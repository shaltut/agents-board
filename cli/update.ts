// cb update --check (#4352 slice 2): is this machine's copy the release the board serves? Fetches the board's
// /release/current.json and the archive it names, verifies the archive against the manifest (in memory), then compares
// this copy's files with it (filesReport, as cb doctor does). Writes nothing and never connects to the board's
// database. Installing it is cli/update-install.ts (cb update, cb update --rollback).
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { filesReport } from './doctor.ts';
import { checkManifest, headSha, type Manifest } from './release.ts';
import { readArchive, releaseFromArchive } from './release-archive.ts';

const MAX_JSON = 5 * 1024 * 1024, MAX_TGZ = 50 * 1024 * 1024;

/** A GET's body, refused past `cap` bytes or `ms` milliseconds. */
async function get(url: string, cap: number, ms: number) {
  let res: Response;
  try { res = await fetch(url, { signal: AbortSignal.timeout(ms) }); } catch (e: any) {
    throw new Error(`cannot reach ${url} (${e?.cause?.code ?? e?.name ?? e?.message ?? e})`);
  }
  const big = () => new Error(`${url} is larger than ${cap} bytes`);
  if (Number(res.headers.get('content-length') ?? 0) > cap) throw big();
  // counted as it arrives: a body with no length (chunked) stops at the cap, never buffered whole first
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
    n += chunk.length;
    if (n > cap) { await res.body?.cancel().catch(() => {}); throw big(); }
    parts.push(Buffer.from(chunk));
  }
  return { status: res.status, body: Buffer.concat(parts) };
}

/** The board's web address, or what to do when none is set. */
export function needAddress(from: string | undefined) {
  if (!from) throw new Error("no board web address: pass --from <url> (the board's https address), or set CB_PUBLIC_URL or PUBLIC_URL in this checkout's .env");
  return from;
}

/** The board's address as given, http(s) only, with no user:pass@ (never printed or sent: the routes need no sign-in). */
export function boardBase(from: string) {
  try {
    const u = new URL(from);
    if (!/^https?:$/.test(u.protocol)) throw 0;
    u.username = ''; u.password = '';
    return u.href.replace(/\/+$/, '');
  } catch {
    throw new Error('not a board address: --from, CB_PUBLIC_URL or PUBLIC_URL must be an http:// or https:// URL');
  }
}

export type Fetched = { manifest: Manifest; served: any; tgz: Buffer; archiveProblem: string | null; files: Map<string, Buffer> | null };
/** The release the board serves: its manifest (checked) and its archive, verified in memory against the manifest's hash
 *  and file list. archiveProblem says why the archive is unusable (files is then null). */
export async function fetchRelease(base: string, ms = 20_000): Promise<Fetched> {
  const cur = await get(`${base}/release/current.json`, MAX_JSON, ms);
  let served: any;
  try { served = JSON.parse(cur.body.toString('utf8')); } catch { served = null; }
  if (cur.status !== 200) {
    const err = typeof served?.error === 'string' ? served.error.slice(0, 300) : `HTTP ${cur.status}`;
    throw new Error(`the board at ${base} gave no release: ${err}`);
  }
  const m = checkManifest(served, `${base}/release/current.json`);
  const a = served.archive;
  if (typeof a?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error(`${base}/release/current.json names no archive hash`);
  const tgz = await get(`${base}/release/${m.sha}.tgz`, MAX_TGZ, ms);
  let archiveProblem: string | null = null, files: Map<string, Buffer> | null = null;
  if (tgz.status !== 200) archiveProblem = `HTTP ${tgz.status}`;
  else if (createHash('sha256').update(tgz.body).digest('hex') !== a.sha256) archiveProblem = 'its sha256 is not the one the manifest names (a half download or a proxy changed it)';
  else {
    try {
      const r = releaseFromArchive(tgz.body);
      const want = Object.entries(m.files), got = r.manifest.files;
      if (r.manifest.sha !== m.sha) archiveProblem = `it is commit ${r.manifest.sha.slice(0, 7)}, not ${m.sha.slice(0, 7)}`;
      else if (want.length !== Object.keys(got).length || want.some(([p, h]) => got[p] !== h)) archiveProblem = 'its files are not the manifest\'s';
      else files = readArchive(tgz.body).files;
    } catch (e: any) { archiveProblem = String(e?.message ?? e); }
  }
  return { manifest: m, served, tgz: tgz.body, archiveProblem, files };
}

export async function updateCheck(o: { root: string; from: string; timeoutMs?: number }) {
  const root = resolve(o.root);
  const base = boardBase(o.from);
  const lines: string[] = [];
  const json: any = { root, from: base, checkout_sha: headSha(root) };
  let problems = 0;

  const { manifest: m, served, tgz, archiveProblem } = await fetchRelease(base, o.timeoutMs);
  json.release = m.sha;
  json.archive = { sha256: served.archive.sha256, bytes: tgz.length, verified: !archiveProblem, ...(archiveProblem ? { problem: archiveProblem } : {}) };
  if (archiveProblem) { problems++; lines.push(`release: ${m.sha.slice(0, 7)} from ${base}: its archive is not usable: ${archiveProblem}. Tell the lead (cb tell)`); }
  else lines.push(`release: ${m.sha.slice(0, 7)} from ${base} (${Object.keys(m.files).length} files; archive ${Math.ceil(tgz.length / 1024)} KB, verified)`);

  const f = filesReport(root, m, json.checkout_sha);
  json.files = f.files;
  if (!f.ok) problems++;
  lines.push(...f.lines);
  json.ok = problems === 0;
  json.problems = problems;
  lines.push(json.ok ? 'update: this machine is on the release'
    : `update: ${problems} ${problems === 1 ? 'check' : 'checks'} failed. Install it with cb update (a copy), or git pull --ff-only (a git checkout)`);
  return { ok: json.ok, lines, json };
}
