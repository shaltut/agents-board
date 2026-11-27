// #4352 slice 3: cb update installs the served release on a copy (staged version, verified, probed, then a link flip)
// and cb update --rollback goes back. Everything runs in a temp folder: a board repo made from this checkout's tracked
// files, a copy with its own packages (an offline install into temp, never a link to a real node_modules).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { freshDb, TEST_URL } from './helpers.ts';
import { releaseApp, setRelease } from '../server/release.ts';
import { releaseAt } from '../cli/release-archive.ts';
import { startedAs } from '../cli/started-as.ts';

const tmp = mkdtempSync(join(tmpdir(), `cb-upd-${process.pid}-`));
const server = serve({ fetch: releaseApp.fetch, port: 0, hostname: '127.0.0.1' });
const port = await new Promise<number>((res) => server.once('listening', () => res((server.address() as any).port)));
const base = `http://127.0.0.1:${port}`;
const clients: any[] = [];
const repo = join(tmp, 'board'), live = join(tmp, 'w', 'claude-board'), home = `${live}.home`;
after(async () => {
  server.close();
  await Promise.all(clients.map((c) => c.end()));
  try { if (lstatSync(live).isSymbolicLink()) unlinkSync(live); } catch {} // the link first: a delete never goes through it
  rmSync(tmp, { recursive: true, force: true });
});

const git = (...a: string[]) => {
  const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
/** Every file under a folder with its size and hash (links listed, not followed): to prove it was not touched. */
function tree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isSymbolicLink()) out.push(`${f} -> link`); else if (e.isDirectory()) walk(f); else out.push(`${f} ${statSync(f).size} ${sha(readFileSync(f))}`);
  } };
  walk(dir);
  return out.sort().join('\n');
}
const FILES = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'bin', 'cli', 'db', 'prompts', 'server', 'hooks', 'kit', 'package.json', 'pnpm-lock.yaml'], { encoding: 'utf8' })
  .stdout.split('\n').filter(Boolean);
const copyTo = (dir: string) => { for (const p of FILES) { mkdirSync(join(dir, p, '..'), { recursive: true }); copyFileSync(p, join(dir, p)); } };
const edit = (p: string, add: string) => writeFileSync(join(repo, p), readFileSync(join(repo, p), 'utf8') + add);
const commit = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); setRelease(releaseAt(repo)); return git('rev-parse', 'HEAD'); };

/** async: the board answering cb runs in this process */
function cb(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((res) => {
    execFile(process.execPath, ['cli/cb.ts', ...args], { timeout: 180_000, env: { ...process.env, CB_DATABASE_URL: TEST_URL, HERDR_PANE_ID: '',
      CB_MACHINE: 'testbox', CB_ACTOR: 'W1@test', CB_PUBLIC_URL: '', CLAUDE_CODE_MESSAGING_SOCKET: '', ...env } },
    (e: any, out, err) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(out).trim(), err: String(err).trim() }));
  });
}
const state = () => JSON.parse(readFileSync(join(home, 'versions', 'state.json'), 'utf8'));

let A = '', B = '', nm = '', env0 = '';
before(async () => {
  clients.push(await freshDb()); // the probe runs cb sessions from the new code against this board
  copyTo(repo);
  git('init', '-q');
  A = commit('A');
  // the copy: release A as the tar step left it, its own packages from the store, and its settings
  copyTo(live);
  // hoisted: real folders, no links (pnpm's Windows junctions name the copy's absolute path; a refusal test covers them)
  const i = spawnSync('pnpm', ['install', '--frozen-lockfile', '--offline', '--prod', '--ignore-scripts', '--config.node-linker=hoisted'], { cwd: live, encoding: 'utf8', shell: process.platform === 'win32', timeout: 300_000 });
  assert.equal(i.status, 0, `offline install into the temp copy failed: ${i.stderr || i.stdout}`);
  writeFileSync(join(live, '.env'), 'CB_MACHINE=testbox\n');
  nm = tree(join(live, 'node_modules'));
  env0 = sha(readFileSync(join(live, '.env')));
  edit('cli/doctor.ts', '// release B\n');
  B = commit('B');
});

test('cb update: the first install moves the copy to .home, stages and probes the release, then flips the link; packages and .env untouched', { timeout: 300_000 }, async () => {
  const r = await cb(['update', '--from', base, '--root', live]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, new RegExp(`^release: ${B.slice(0, 7)} from `, 'm'));
  assert.match(r.out, /^adopted: .* is now a link to .*claude-board\.home, the copy as it was/m);
  assert.match(r.out, /^packages: .*node_modules reused \(pnpm-lock\.yaml unchanged, [0-9a-f]{7}\)$/m);
  assert.match(r.out, /^staged: .*versions.* files verified, bin\/cb executable\); probes passed: cb help, cb sessions$/m);
  assert.match(r.out, new RegExp(`^flipped: .* \\(was the original copy\\)\\. Back: cb update --rollback$`, 'm'));
  assert.ok(lstatSync(live).isSymbolicLink());
  assert.equal(realpathSync(live), realpathSync(join(home, 'versions', B)));
  assert.deepEqual(state(), { current: B, previous: 'original' });
  assert.match(readFileSync(join(live, 'cli/doctor.ts'), 'utf8'), /\/\/ release B\n$/);
  assert.ok(!existsSync(join(home, 'versions', B, 'node_modules')) && !existsSync(join(home, 'versions', B, '.env')), 'a version holds only release files');
  assert.equal(tree(join(home, 'node_modules')), nm.replaceAll(live, home), 'node_modules changed');
  assert.equal(sha(readFileSync(join(home, '.env'))), env0);
  if (process.platform !== 'win32') assert.equal(statSync(join(live, 'bin', 'cb')).mode & 0o111, 0o111);
  // the installed version runs through the copy's path: packages and package.json by upward lookup from .home
  const h = spawnSync(process.execPath, [join(live, 'cli', 'cb.ts'), 'help', 'update'], { encoding: 'utf8' });
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /cb update --rollback/);

  const again = await cb(['update', '--from', base, '--root', live, '--json']);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(JSON.parse(again.out), { ok: true, release: B, current: B, changed: false });
});

test('cb update --rollback flips back to the version before, and again to the newer one', { timeout: 120_000 }, async () => {
  const r = await cb(['update', '--rollback', '--root', live]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^rolled back: .* \\(the original copy; was ${B.slice(0, 7)}\\)\\. Again: cb update --rollback$`, 'm'));
  assert.equal(realpathSync(live), realpathSync(home));
  assert.deepEqual(state(), { current: 'original', previous: B });
  const back = await cb(['update', '--rollback', '--root', live, '--json']);
  assert.equal(back.code, 0, back.err);
  assert.equal(JSON.parse(back.out).current, B);
  assert.equal(realpathSync(live), realpathSync(join(home, 'versions', B)));
});

test('cb update refuses: a git checkout, a runner running from the copy, a second update, other packages; nothing changes', { timeout: 300_000 }, async () => {
  const where = () => realpathSync(live);
  const before = where();
  const C = (edit('cli/doctor.ts', '// release C\n'), commit('C'));

  const g = await cb(['update', '--from', base, '--root', repo]);
  assert.equal(g.code, 1);
  assert.match(g.err, /is a git checkout: update it with git pull --ff-only/);

  // a runner started from the copy keeps its old code in memory: refused unless --force
  const runner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', join(live, 'cli', 'runner.ts')], { stdio: 'ignore' });
  try {
    await new Promise((res) => setTimeout(res, 800));
    const d = await cb(['update', '--from', base, '--root', live]);
    assert.equal(d.code, 1, d.out);
    assert.match(d.err, new RegExp(`the runner or supervisor runs from this copy \\(pid ${runner.pid}\\).*stop it by its pid \\(never by name\\)`));
    assert.equal(where(), before);
  } finally { runner.kill(); } // our own child, by its pid

  writeFileSync(`${live}.update.lock`, String(process.pid)); // a live pid holds the lock
  try {
    const l = await cb(['update', '--from', base, '--root', live]);
    assert.equal(l.code, 1);
    assert.match(l.err, new RegExp(`another cb update is running on this copy \\(pid ${process.pid}\\)`));
  } finally { unlinkSync(`${live}.update.lock`); }

  edit('pnpm-lock.yaml', '# another lockfile\n');
  commit('D: other packages');
  const p = await cb(['update', '--from', base, '--root', live]);
  assert.equal(p.code, 1);
  assert.match(p.err, /the release needs other packages \(its pnpm-lock\.yaml [0-9a-f]{7}, this copy's [0-9a-f]{7}\): cb update reuses this copy's node_modules and never installs packages/);
  assert.equal(where(), before);
  assert.ok(!readdirSync(join(home, 'versions')).some((d) => d.startsWith('.staging') || d === C), 'something was staged');
  git('reset', '-q', '--hard', 'HEAD~1'); setRelease(releaseAt(repo));
});

test('cb update refuses to move a copy whose packages link to it by absolute path (pnpm on Windows), before writing anything', { timeout: 120_000 }, async () => {
  const other = join(tmp, 'w2', 'claude-board');
  mkdirSync(join(other, 'cli'), { recursive: true });
  writeFileSync(join(other, 'cli', 'cb.ts'), '');
  copyFileSync('pnpm-lock.yaml', join(other, 'pnpm-lock.yaml'));
  mkdirSync(join(other, 'node_modules', '.pnpm', 'x@1', 'node_modules', 'x'), { recursive: true });
  symlinkSync(join(other, 'node_modules', '.pnpm', 'x@1', 'node_modules', 'x'), join(other, 'node_modules', 'x'), 'junction'); // absolute, into the copy
  try {
    const r = await cb(['update', '--from', base, '--root', other]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.err, /this copy's packages link to it by its absolute path \(.*node_modules.x; pnpm does this on Windows\)/);
    assert.ok(!existsSync(`${other}.home`) && !lstatSync(other).isSymbolicLink());
  } finally { unlinkSync(join(other, 'node_modules', 'x')); }
});

test('cb update: a release whose code fails its probe is never flipped to, and leaves nothing staged', { timeout: 300_000 }, async () => {
  const before = realpathSync(live);
  edit('cli/cb.ts', '\nthis is not code(\n');
  const bad = commit('broken');
  const r = await cb(['update', '--from', base, '--root', live]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /the new code failed its probe cb help \(exit 1\)/);
  assert.equal(realpathSync(live), before);
  assert.ok(!readdirSync(join(home, 'versions')).some((d) => d.startsWith('.staging') || d === bad));
  git('reset', '-q', '--hard', 'HEAD~1'); setRelease(releaseAt(repo));
});

test('a relay or cb started through the copy path watches and relaunches through it, not the real version folder', () => {
  assert.equal(startedAs(join(live, 'cli', 'relay.ts'), join(home, 'versions', B, 'cli', 'relay.ts')), join(live, 'cli', 'relay.ts'));
  assert.equal(startedAs(undefined, '/r/cli/relay.ts'), '/r/cli/relay.ts');
  assert.equal(startedAs('/t/test-runner.mjs', '/r/cli/relay.ts'), '/r/cli/relay.ts'); // imported, not run: its own path
  const src = readFileSync('cli/relay.ts', 'utf8');
  assert.doesNotMatch(src.replace(/startedAs\(process\.argv\[1\], import\.meta\.filename\)/, ''), /import\.meta\.(filename|dirname)/, 'relay.ts watches or relaunches by its real path');
});
