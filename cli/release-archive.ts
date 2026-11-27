// The release archive (#4352 slice 2): `git archive` of the release folders at one commit, gzipped. git writes only
// tracked files, as checked out (eol attributes applied, so the bytes match a checkout's), and puts the commit in a
// pax global header. The manifest is made from the archive's own entries, so the two always agree.
// The board serves it (server/release.ts); `cb update --check` fetches and verifies it (cli/update.ts).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FORMAT, RELEASE_DIRS, headSha, neverReleased, releasePath, type Manifest } from './release.ts';

export const ARCHIVE = 'release.tgz'; // at the repo root, built at deploy (the image has no .git)
const MAX_TAR = 200 * 1024 * 1024; // unpacked: the release is well under 1 MB; a bomb stops here
export type Release = { manifest: Manifest; tgz: Buffer; sha256: string };

const hex = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const field = (b: Buffer, at: number, len: number) => { const s = b.subarray(at, at + len); const z = s.indexOf(0); return s.subarray(0, z < 0 ? len : z).toString('utf8'); };
// pax records: "<len> <key>=<value>\n", repeated
function pax(b: Buffer) {
  const out: Record<string, string> = {};
  for (let i = 0; i < b.length;) {
    const sp = b.indexOf(0x20, i);
    const len = Number(b.subarray(i, sp).toString('ascii'));
    if (sp < 0 || !Number.isInteger(len) || len <= 0) break;
    const rec = b.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** The files of a gzipped tar and the commit git noted in it. Directories and pax headers are read, not listed; a link
 *  or any other entry type is refused (an extract must never write outside its folder). */
export function readArchive(tgz: Buffer): { sha: string | null; files: Map<string, Buffer> } {
  let tar: Buffer;
  try { tar = gunzipSync(tgz, { maxOutputLength: MAX_TAR }); } catch (e: any) { throw new Error(`the release archive is not a readable .tgz (${e?.code ?? e?.message})`); }
  const files = new Map<string, Buffer>();
  let sha: string | null = null, next: Record<string, string> = {};
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break; // the end
    const size = parseInt(field(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156]!);
    if (!Number.isFinite(size) || size < 0 || at + 512 + size > tar.length) throw new Error('the release archive is cut short');
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') { sha = pax(body).comment ?? sha; continue; }
    if (type === 'x') { next = pax(body); continue; }
    const prefix = field(h, 345, 155);
    const name = next.path ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    next = {};
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') throw new Error(`the release archive holds ${name}, which is not a plain file (type ${type})`);
    files.set(name, Buffer.from(body));
  }
  return { sha: sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null, files };
}

/** A release from its archive: every entry a plain file inside the release folders, never an env file or anything
 *  under node_modules (refused whole, not skipped: a release that tracks one is a mistake to fix, not to serve). */
export function releaseFromArchive(tgz: Buffer): Release {
  const { sha, files } = readArchive(tgz);
  if (!sha) throw new Error('the release archive names no commit (make it with git archive, which notes one)');
  const out: Record<string, string> = {};
  for (const [p, body] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!releasePath(p)) throw new Error(`the release archive holds a path outside the release folders: ${JSON.stringify(p)}`);
    if (neverReleased(p)) throw new Error(`the release archive holds ${p}: an env file or installed package is never served; untrack it (git rm --cached)`);
    out[p] = hex(body);
  }
  if (!Object.keys(out).length) throw new Error('the release archive holds no files');
  return { manifest: { format: FORMAT, sha, files: out }, tgz, sha256: hex(tgz) };
}

/** git archive of the release folders at HEAD (committed content only, whatever the working tree holds). */
export function gitArchive(root: string): Buffer {
  const opts = { maxBuffer: MAX_TAR, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true };
  // only the release folders HEAD has: git archive fails on a path that matches nothing
  const top = spawnSync('git', ['-C', root, 'ls-tree', '--name-only', 'HEAD'], { ...opts, encoding: 'utf8' });
  const dirs = top.status === 0 ? RELEASE_DIRS.filter((d) => top.stdout.split('\n').includes(d)) : [];
  if (!dirs.length) throw new Error(`git archive failed in ${root}: HEAD has none of the release folders (${RELEASE_DIRS.join(' ')})`);
  // core.autocrlf=false: the bytes follow the repo's .gitattributes (eol=lf, *.cmd crlf), never this host's own setting
  const r = spawnSync('git', ['-C', root, '-c', 'core.autocrlf=false', 'archive', '--format=tar.gz', 'HEAD', '--', ...dirs], opts);
  if (r.status !== 0) throw new Error(`git archive failed in ${root}: ${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 200)}`);
  return r.stdout;
}

/** The release a board at root serves: its own commit when root is a checkout, else the archive made at deploy. */
export function releaseAt(root: string): Release {
  if (headSha(root)) return releaseFromArchive(gitArchive(root));
  let tgz: Buffer;
  try { tgz = readFileSync(join(root, ARCHIVE)); } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
    throw new Error(`no ${ARCHIVE} in ${root} and no git checkout: make it at deploy (docs/ops/maintain.md, Upgrade)`);
  }
  return releaseFromArchive(tgz);
}
