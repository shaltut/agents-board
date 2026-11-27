// The release manifest (#4352): every file a machine runs cb from, path -> sha256, and the git commit it was built
// from. `node cli/release.ts [--out <file>]` writes it (default release.json at the repo root, not committed: it names
// its own commit). cb doctor compares a machine's files with one (cli/doctor.ts).
// Paths are the git paths (forward slashes); hashes are of the bytes on disk, which are the same on every machine:
// .gitattributes pins eol=lf, and *.cmd eol=crlf everywhere.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASE_DIRS = ['bin', 'cli', 'db', 'prompts', 'server', 'hooks', 'kit'];
export const FORMAT = 'cb.release.v1';
export type Manifest = { format: typeof FORMAT; sha: string; files: Record<string, string> };

export const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

function git(root: string, args: string[]) {
  // GIT_OPTIONAL_LOCKS=0: a read never refreshes .git/index on the way
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

/** This checkout's commit, or null (no git, or not a checkout: the Mac's copy). Reads only. */
export function headSha(root: string): string | null {
  return git(root, ['rev-parse', 'HEAD'])?.trim() || null;
}

/** The manifest of the commit checked out at root. Refuses a tree whose release files differ from that commit: the
 *  manifest would name a commit its hashes do not match. */
export function buildManifest(root: string): Manifest {
  const sha = headSha(root);
  if (!sha) throw new Error(`${root} is not a git checkout: build the manifest in a clone of the repo`);
  const changed = git(root, ['status', '--porcelain', '--untracked-files=no', '--', ...RELEASE_DIRS]);
  if (changed === null) throw new Error(`git status failed in ${root}`);
  if (changed.trim()) throw new Error(`uncommitted changes in the release files (commit or stash them first):\n${changed.trimEnd()}`);
  const list = git(root, ['ls-files', '-z', '--', ...RELEASE_DIRS]);
  if (list === null) throw new Error(`git ls-files failed in ${root}`);
  const paths = list.split('\0').filter(Boolean).sort();
  return { format: FORMAT, sha, files: Object.fromEntries(paths.map((p) => [p, sha256(join(root, p))])) };
}

/** A manifest read from a file, checked: the right format, a commit, and only relative paths inside the release
 *  folders (a manifest may come from elsewhere later: a path must never reach outside the checkout). */
export function readManifest(file: string): Manifest {
  let m: any;
  try { m = JSON.parse(readFileSync(file, 'utf8')); } catch (e: any) {
    throw new Error(`cannot read the manifest ${file}: ${e?.code ?? e?.message ?? e}`);
  }
  if (m?.format !== FORMAT) throw new Error(`${file} is not a release manifest (format ${JSON.stringify(m?.format)}, want ${FORMAT})`);
  if (typeof m.sha !== 'string' || !/^[0-9a-f]{40}$/.test(m.sha)) throw new Error(`${file} has no commit sha`);
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) throw new Error(`${file} has no file list`);
  for (const [p, h] of Object.entries(m.files)) {
    const parts = p.split('/');
    if (isAbsolute(p) || p.includes('\\') || parts.some((s) => s === '' || s === '.' || s === '..') || !RELEASE_DIRS.includes(parts[0]!))
      throw new Error(`${file} lists a path outside the release folders: ${JSON.stringify(p)}`);
    if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) throw new Error(`${file} has a bad hash for ${p}`);
  }
  return m;
}

/** Which of the manifest's files are missing under root, and which differ. Reads only. */
export function compareManifest(root: string, m: Manifest) {
  const missing: string[] = [], changed: string[] = [];
  for (const [p, want] of Object.entries(m.files)) {
    let got: string;
    try { got = sha256(join(root, p)); } catch (e: any) {
      if (e?.code === 'ENOENT' || e?.code === 'EISDIR') { missing.push(p); continue; }
      throw e;
    }
    if (got !== want) changed.push(p);
  }
  return { missing, changed, total: Object.keys(m.files).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const root = resolve(import.meta.dirname, '..');
  const i = args.indexOf('--out');
  if (args.length && !(i === 0 && args.length === 2)) {
    console.error('usage: node cli/release.ts [--out <file>]');
    process.exit(2);
  }
  const out = i === 0 ? resolve(args[1]!) : join(root, 'release.json');
  try {
    const m = buildManifest(root);
    writeFileSync(out, JSON.stringify(m, null, 2) + '\n');
    console.log(`${out}: ${Object.keys(m.files).length} files at ${m.sha.slice(0, 7)}`);
  } catch (e: any) {
    console.error(`release manifest not written: ${e?.message ?? e}`);
    process.exit(1);
  }
}
