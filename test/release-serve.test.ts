// #4352 slice 2: the board serves its release (server/release.ts: /release/current.json and /release/<sha>.tgz, made
// with git archive) and cb update --check compares a copy with it. Pure: no database; fixtures in a temp folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { serve } from '@hono/node-server';
import { releaseApp, setRelease } from '../server/release.ts';
import { readArchive, releaseAt, releaseFromArchive, gitArchive } from '../cli/release-archive.ts';

const tmp = mkdtempSync(join(tmpdir(), `cb-release-${process.pid}-`));
const server = serve({ fetch: releaseApp.fetch, port: 0, hostname: '127.0.0.1' });
const port = await new Promise<number>((res) => server.once('listening', () => res((server.address() as any).port)));
const base = `http://127.0.0.1:${port}`;
after(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
const dir = () => { const d = join(tmp, String(n++)); mkdirSync(d, { recursive: true }); return d; };
const put = (root: string, p: string, body: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), body); };
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const git = (root: string, ...a: string[]) => {
  const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const LONG = `kit/${'a'.repeat(60)}/${'b'.repeat(60)}.mjs`; // past ustar's 100-character name: git writes a pax path
const TRACKED = ['bin/cb', 'bin/cb.cmd', 'cli/cb.ts', 'kit/guard/core.mjs', LONG].sort();

/** A board checkout: tracked release files, and the secrets and installs that must never ship, left untracked. */
function repo() {
  const root = dir();
  put(root, 'bin/cb', '#!/bin/sh\n');
  put(root, 'bin/cb.cmd', '@node cb\r\n');
  put(root, 'cli/cb.ts', 'console.log(1)\n');
  put(root, 'kit/guard/core.mjs', 'export const core = 1;\n');
  put(root, LONG, 'export const long = 1;\n');
  put(root, 'README.md', 'not released\n');
  put(root, '.gitignore', '.env\n.env.*\nnode_modules/\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'one');
  for (const p of ['.env', 'deploy/.env', 'cli/.env', 'cli/.env.local', 'kit/node_modules/x/index.js', 'server/.env.production'])
    put(root, p, 'CB_PG_PASSWORD=not-a-real-secret\n');
  put(root, 'cli/scratch.ts', 'untracked\n');
  return root;
}

/** async: the server answering cb runs in this process, so a blocking spawn would hang it */
function cb(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((res) => {
    execFile(process.execPath, ['cli/cb.ts', ...args], { timeout: 60_000, env: { ...process.env, CB_DATABASE_URL: 'postgres://cb@192.0.2.1:5434/claude_board',
      HERDR_PANE_ID: `p-upd-${process.pid}`, CB_MACHINE: 'testbox', CB_ACTOR: '', CB_PUBLIC_URL: '', CLAUDE_CODE_MESSAGING_SOCKET: '', ...env } },
    (e: any, out, err) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(out).trim(), err: String(err).trim() }));
  });
}

test('the release is git archive of the tracked release files at HEAD: never an env file, node_modules or an untracked file', () => {
  const root = repo();
  put(root, 'cli/cb.ts', 'console.log("edited, not committed")\n'); // the working tree does not leak into a release
  const r = releaseAt(root);
  assert.equal(r.manifest.sha, git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(Object.keys(r.manifest.files), TRACKED);
  assert.equal(r.manifest.files['cli/cb.ts'], sha('console.log(1)\n'));
  assert.equal(r.manifest.files['bin/cb.cmd'], sha('@node cb\r\n')); // the bytes a checkout has
  assert.equal(r.sha256, sha(r.tgz));
  const entries = [...readArchive(r.tgz).files.keys()];
  assert.deepEqual(entries.sort(), TRACKED);
  for (const p of entries) assert.doesNotMatch(p, /(^|\/)(\.env(\.|$)|node_modules\/)/);
  assert.ok(!gunzipSync(r.tgz).includes('not-a-real-secret'), 'a secret reached the archive');
  // the system tar reads the same files (bsdtar on Windows and macOS, GNU tar on Linux)
  const t = spawnSync('tar', ['-tzf', '-'], { input: r.tgz, encoding: 'utf8' });
  if (t.status === 0) assert.deepEqual(t.stdout.split(/\r?\n/).filter((l) => l && !l.endsWith('/') && l !== 'pax_global_header').sort(), TRACKED);
});

test('a release that tracks an env file or node_modules is refused whole, not served', () => {
  for (const p of ['cli/.env', 'kit/.env.local', 'kit/node_modules/x/index.js', 'server/x/.env']) {
    const root = repo();
    put(root, p, 'SECRET=1\n');
    git(root, 'add', '-f', p);
    git(root, 'commit', '-qm', 'oops');
    assert.throws(() => releaseAt(root), new RegExp(`the release archive holds ${p.replace(/\./g, '\\.')}: an env file or installed package is never served`), p);
  }
});

test('the image (no .git) serves the release.tgz made at deploy; without one it serves none and says why', () => {
  const root = repo();
  const image = dir();
  writeFileSync(join(image, 'release.tgz'), gitArchive(root));
  const r = releaseAt(image);
  assert.deepEqual(r.manifest, releaseAt(root).manifest);
  assert.throws(() => releaseAt(dir()), /no release\.tgz in .* and no git checkout: make it at deploy/);
});

/** A hand-made tar: a pax global header naming a commit, then the entries. */
function tarOf(entries: { name: string; type?: string; body?: string; link?: string }[], commit = 'a'.repeat(40)) {
  const block = (name: string, type: string, body: Buffer, link = '') => {
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write(type, 156); h.write(link, 157);
    h.write('ustar\0', 257); h.write('00', 263); h.write('        ', 148);
    h.write(h.reduce((s, x) => s + x, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  };
  const rec = `comment=${commit}\n`;
  const pax = `${rec.length + 3} ${rec}`; // the length counts its own 2 digits and the space // "<len> comment=<sha>\n"
  return gzipSync(Buffer.concat([block('pax_global_header', 'g', Buffer.from(pax)),
    ...entries.map((e) => block(e.name, e.type ?? '0', Buffer.from(e.body ?? ''), e.link)), Buffer.alloc(1024)]));
}

test('an archive is refused for a link, a path outside the release folders, or no commit', () => {
  const ok = releaseFromArchive(tarOf([{ name: 'cli/a.ts', body: 'a' }]));
  assert.deepEqual(ok.manifest.files, { 'cli/a.ts': sha('a') });
  assert.equal(ok.manifest.sha, 'a'.repeat(40));
  assert.throws(() => releaseFromArchive(tarOf([{ name: 'cli/a.ts', type: '2', link: '/etc/passwd' }])), /cli\/a\.ts, which is not a plain file \(type 2\)/);
  assert.throws(() => releaseFromArchive(tarOf([{ name: 'cli/../../x', body: 'a' }])), /outside the release folders/);
  assert.throws(() => releaseFromArchive(tarOf([{ name: 'README.md', body: 'a' }])), /outside the release folders/);
  assert.throws(() => releaseFromArchive(tarOf([{ name: 'cli/a.ts', body: 'a' }], 'main')), /names no commit/);
  assert.throws(() => releaseFromArchive(Buffer.from('not gzip')), /not a readable \.tgz/);
});

test('GET /release/current.json and /release/<sha>.tgz serve the release from memory; anything else is a 404, never the UI', async () => {
  const r = releaseAt(repo());
  setRelease(r);
  const cur = await fetch(`${base}/release/current.json`);
  assert.equal(cur.status, 200);
  assert.equal(cur.headers.get('cache-control'), 'no-store');
  const j: any = await cur.json();
  assert.deepEqual({ format: j.format, sha: j.sha, files: j.files }, r.manifest);
  assert.deepEqual(j.archive, { name: `${r.manifest.sha}.tgz`, sha256: r.sha256, bytes: r.tgz.length });
  const tgz = await fetch(`${base}/release/${r.manifest.sha}.tgz`);
  assert.equal(tgz.status, 200);
  assert.equal(tgz.headers.get('content-type'), 'application/gzip');
  assert.ok(Buffer.from(await tgz.arrayBuffer()).equals(r.tgz));
  for (const p of [`/release/${'b'.repeat(40)}.tgz`, '/release/..%2f.env', '/release/a/b', `/release/${r.manifest.sha}.json`]) {
    const x = await fetch(base + p);
    assert.equal(x.status, 404, p);
    assert.match(String(x.headers.get('content-type')), /json/, p);
  }
  setRelease(null, 'no release.tgz in /app and no git checkout');
  const none = await fetch(`${base}/release/current.json`);
  assert.equal(none.status, 404);
  assert.deepEqual(await none.json(), { ok: false, error: 'this board serves no release: no release.tgz in /app and no git checkout' });
});

test('cb update --check: a copy matching the served release passes; a changed file fails; it never touches the database', async () => {
  const root = repo();
  setRelease(releaseAt(root));
  const copy = dir(); // a worker's copy: the release files only, no .git (the Mac's)
  for (const p of TRACKED) { mkdirSync(join(copy, p, '..'), { recursive: true }); copyFileSync(join(root, p), join(copy, p)); }
  writeFileSync(join(copy, 'cli/cb.ts'), 'console.log(1)\n'); // the committed bytes (root's working tree was not edited here)

  const t0 = Date.now();
  const good = await cb(['update', '--check', '--from', base, '--root', copy]);
  assert.ok(Date.now() - t0 < 20_000, 'update waited on the database');
  assert.equal(good.code, 0, good.err + good.out);
  assert.match(good.out, new RegExp(`^release: [0-9a-f]{7} from ${base.replace(/\./g, '\\.')} \\(5 files; archive \\d+ KB, verified\\)$`, 'm'));
  assert.match(good.out, /^files: all 5 match release [0-9a-f]{7}$/m);
  assert.match(good.out, /^update: this machine is on the release$/m);

  writeFileSync(join(copy, 'cli/cb.ts'), 'console.log("old")\n');
  put(copy, 'cli/dropped.ts', 'a release removed me\n');
  const bad = await cb(['update', '--check', '--root', copy, '--json'], { CB_PUBLIC_URL: base }); // the address from the env
  assert.equal(bad.code, 1, bad.err);
  const j = JSON.parse(bad.out);
  assert.deepEqual(j.files, { missing: [], changed: ['cli/cb.ts'], extra: ['cli/dropped.ts'], outside: [], total: 5 });
  assert.equal(j.archive.verified, true);
  assert.equal(j.ok, false);
});

test('cb update --check: a tampered archive is caught; no address and bare cb update are refused in words', async () => {
  const root = repo();
  const r = releaseAt(root);
  setRelease({ ...r, sha256: 'f'.repeat(64) }); // the manifest names other bytes than the board sends
  const t = await cb(['update', '--check', '--from', base, '--root', root, '--json']);
  assert.equal(t.code, 1, t.err);
  const j = JSON.parse(t.out);
  assert.equal(j.archive.verified, false);
  assert.match(j.archive.problem, /its sha256 is not the one the manifest names/);

  const bare = await cb(['update']);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /cb update does not install a release yet: run cb update --check/);
  const away = await cb(['update', '--check', '--from', 'http://127.0.0.1:9']); // nothing listens on the discard port
  assert.equal(away.code, 1);
  assert.match(away.err, /cannot reach http:\/\/127\.0\.0\.1:9\/release\/current\.json/);
  const noUrl = await cb(['update', '--check', '--from', 'ftp://x']);
  assert.match(noUrl.err, /not a board address: "ftp:\/\/x"/);
  setRelease(null, 'none built');
  const none = await cb(['update', '--check', '--from', base]);
  assert.match(none.err, /the board at .* gave no release: this board serves no release: none built/);
});
