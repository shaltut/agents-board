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
import { layout, lsofCwd, rollback, runningFrom } from '../cli/update-install.ts';
import { recordSchema, schemaSha } from '../db/schema-applied.ts';

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
  assert.match(r.out, /^staged: .*versions.* files verified, bin\/cb executable\); probes passed: cb help, cb sessions, node cli\/relay\.ts$/m);
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
  assert.match(r.out, /^relays: the original copy's relays do not follow later flips: after the next cb update, run cb relay --restart in each pane$/m);
  assert.equal(realpathSync(live), realpathSync(home));
  assert.deepEqual(state(), { current: 'original', previous: B });
  const back = await cb(['update', '--rollback', '--root', live, '--json']);
  assert.equal(back.code, 0, back.err);
  assert.equal(JSON.parse(back.out).current, B);
  assert.equal(realpathSync(live), realpathSync(join(home, 'versions', B)));
  // an update that stopped between its flip and its note: the note disagrees with the link, so no blind flip
  const note = readFileSync(join(home, 'versions', 'state.json'), 'utf8');
  writeFileSync(join(home, 'versions', 'state.json'), JSON.stringify({ current: 'original', previous: B }));
  try {
    const off = await cb(['update', '--rollback', '--root', live]);
    assert.equal(off.code, 1);
    assert.match(off.err, /says original is in use, but .* points at [0-9a-f]{40} \(an update stopped between its flip and its note\)/);
    assert.equal(realpathSync(live), realpathSync(join(home, 'versions', B)));
    // review I1: cb update, as the refusal says, settles the note; then rollback works
    const settle = await cb(['update', '--from', base, '--root', live]);
    assert.equal(settle.code, 0, settle.err);
    assert.match(settle.out, new RegExp(`^settled: .*state\\.json now says ${B.slice(0, 7)} is in use \\(back: the original copy\\)$`, 'm'));
    assert.match(settle.out, /^update: already on /m);
    assert.deepEqual(state(), { current: B, previous: 'original' });
    const ok = await cb(['update', '--rollback', '--root', live]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(realpathSync(live), realpathSync(home));
    const fwd = await cb(['update', '--rollback', '--root', live]);
    assert.equal(fwd.code, 0, fwd.err);
    assert.equal(realpathSync(live), realpathSync(join(home, 'versions', B)));
    // no state.json at all (cut off after the first flip): settled the same way
    unlinkSync(join(home, 'versions', 'state.json'));
    const none = await cb(['update', '--from', base, '--root', live]);
    assert.match(none.out, /^settled: /m);
    assert.deepEqual(state(), { current: B, previous: 'original' });
  } finally { writeFileSync(join(home, 'versions', 'state.json'), note); }
});

test('review M3: a copy path left missing by a cut-off update (adopt or a Windows flip) is linked again on the next run', { timeout: 120_000 }, async () => {
  unlinkSync(live); // the link only: .home and its versions stay
  // review I3: the way back is cb from .home; without --root its root is .home, never a copy: refused, nothing moves
  const fromHome = spawnSync(process.execPath, [join(home, 'cli', 'cb.ts'), 'update', '--from', base], { encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, HERDR_PANE_ID: '', CB_PUBLIC_URL: '', CLAUDE_CODE_MESSAGING_SOCKET: '' } });
  assert.equal(fromHome.status, 1, fromHome.stdout);
  assert.match(fromHome.stderr, /claude-board\.home holds a copy's installed releases, it is not a copy: run cb update --root .*claude-board$/m);
  assert.ok(!existsSync(`${home}.home`) && !existsSync(live) && !lstatSync(home).isSymbolicLink());
  const rb0 = spawnSync(process.execPath, [join(home, 'cli', 'cb.ts'), 'update', '--rollback'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HERDR_PANE_ID: '' } });
  assert.equal(rb0.status, 1);
  assert.match(rb0.stderr, /it is not a copy: run cb update --root /);
  const r = await cb(['update', '--from', base, '--root', live]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^repaired: .* was missing \(an earlier cb update was cut off\); it links to .* again\. When the path is gone, cb cannot start from it: node .*claude-board\.home.cli.cb\.ts update --root .*claude-board$/m);
  assert.equal(realpathSync(live), realpathSync(join(home, 'versions', B))); // what state.json says is in use
  unlinkSync(live);
  const rb = await cb(['update', '--rollback', '--root', live]);
  assert.equal(rb.code, 0, rb.err);
  assert.match(rb.out, /^repaired: /m);
  assert.equal(realpathSync(live), realpathSync(home));
  const fwd = await cb(['update', '--rollback', '--root', live]);
  assert.equal(fwd.code, 0, fwd.err);
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
  // a dead run's leftovers: removed by the next run
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  mkdirSync(join(home, 'versions', `.staging-0000000-${dead}`, 'cli'), { recursive: true });
  symlinkSync(home, `${live}.flip-${dead}`, 'junction');
  writeFileSync(`${live}.update.lock.stale-${dead}`, String(dead)); // a lock a dead run moved aside
  edit('cli/cb.ts', '\nthis is not code(\n');
  const bad = commit('broken');
  const r = await cb(['update', '--from', base, '--root', live]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /the new code failed its probe cb help \(exit 1\)/);
  assert.equal(realpathSync(live), before);
  assert.ok(!readdirSync(join(home, 'versions')).some((d) => d.startsWith('.staging') || d === bad));
  assert.ok(!existsSync(`${live}.flip-${dead}`) && !lstatSync(home).isSymbolicLink());
  assert.ok(!existsSync(`${live}.update.lock.stale-${dead}`));
  git('reset', '-q', '--hard', 'HEAD~1');

  // review I2: a module only the relay loads (settle.ts) is broken: cb help and cb sessions pass, the relay probe does not
  edit('cli/settle.ts', '\nthis is not code(\n');
  const relayBad = commit('broken relay module');
  const q = await cb(['update', '--from', base, '--root', live]);
  assert.equal(q.code, 1, q.out);
  assert.match(q.err, /the new code failed its probe node cli\/relay\.ts \(exit 1\)/);
  assert.equal(realpathSync(live), before);
  assert.ok(!readdirSync(join(home, 'versions')).some((d) => d.startsWith('.staging') || d === relayBad));
  git('reset', '-q', '--hard', 'HEAD~1'); setRelease(releaseAt(repo));
});

const plat = (s: string) => (process.platform === 'win32' ? s.replaceAll('/', '\\') : s);
const elsewhere = plat(join(tmp, 'elsewhere', 'claude-board'));

test('the runner or supervisor is found by its real command lines: through bin/cb, cb.ts, the spawned child, or a relative path', () => {
  const L = layout(live);
  const p = (cmd: string, pid = 9_000_001) => ({ pid, cmd });
  const run = runningFrom(L, [
    p(`/bin/sh ${live}/bin/cb runner`, 1), p(`node ${live}/bin/../cli/cb.ts supervise`, 2),
    p(`node ${home}/versions/${B}/cli/runner.ts`, 3), p('node cli/cb.ts runner', 4),
    p(`node ${live}/cli/relay.ts --pane w1:p1 --agent claude`, 5), p(`node ${live}/cli/cb.ts sessions`, 6),
    p('node /elsewhere/claude-board/cli/cb.ts runner', 7), p('node /elsewhere/claude-board/cli/relay.ts', 8)]
    .map((x) => ({ ...x, cmd: plat(x.cmd) })), (pid) => (pid === 4 ? live : null));
  assert.deepEqual(run.daemons.map((x) => x.pid), [1, 2, 3, 4]);
  assert.deepEqual(run.relays.map((x) => x.pid), [5]);
  assert.deepEqual(run.others.map((x) => x.pid), [6]);
  assert.deepEqual(run.unsure.map((x) => x.pid), []);
});

test('#4572: a relative runner counts only when its working folder is the copy; another checkout\'s does not; an unreadable folder is said so', () => {
  const L = layout(live);
  const folders: Record<number, string | null> = {
    1: live, // started in the copy
    2: plat(join(home, 'versions', '0'.repeat(40))), // started through the link before an earlier flip: the real folder
    3: elsewhere, // another checkout's runner test on the same machine
    4: null, // the folder cannot be read (Windows, or another user's process)
    5: plat(`${live}-other`), // a sibling whose name starts like the copy's
  };
  const asked: number[] = [];
  const run = runningFrom(L, [
    { pid: 1, cmd: 'node cli/runner.ts' }, { pid: 2, cmd: 'node --conditions=x cli/supervise.ts' },
    { pid: 3, cmd: 'node cli/runner.ts' }, { pid: 4, cmd: plat('/bin/sh ./bin/cb runner') },
    { pid: 5, cmd: '"node" "cli/cb.ts" runner' }, { pid: 6, cmd: 'node cli/doctor.ts' }],
  (pid) => { asked.push(pid); return folders[pid] ?? null; });
  assert.deepEqual(run.daemons.map((x) => x.pid), [1, 2]);
  assert.deepEqual(run.unsure.map((x) => x.pid), [4]);
  assert.deepEqual([...run.relays, ...run.others].map((x) => x.pid), []);
  assert.deepEqual(asked, [1, 2, 3, 4, 5], 'the folder is read only for a relative runner or supervisor');
});

test('#4572: a relative runner whose folder cannot be read refuses and says so, never that it runs from this copy; --force goes ahead', () => {
  const where = realpathSync(live);
  const procs = () => [{ pid: 999_999_991, cmd: 'node cli/runner.ts' }]; // no such pid: its folder cannot be read on any OS
  assert.throws(() => rollback({ root: live, procs }), (e: any) => {
    assert.match(e.message, /^pid 999999991 runs a runner or supervisor by a relative path and its working folder could not be read.*: it may be this copy's or another checkout's\. .*if it is not, pass --force$/);
    assert.doesNotMatch(e.message, /runs from this copy/);
    return true;
  });
  assert.equal(realpathSync(live), where);
  const r = rollback({ root: live, procs, force: true });
  assert.ok(r.lines.some((l) => /^runner\/supervisor: pid 999999991 runs a runner or supervisor by a relative path .*restart it by its pid \(never by name\)$/.test(l)), r.lines.join('\n'));
  rollback({ root: live, procs: () => [] }); // and back
  assert.equal(realpathSync(live), where);
});

test('#4572: the cwd line of lsof -Fn output is read; anything else is no folder', () => {
  assert.equal(lsofCwd('p4242\nfcwd\nn/Users/x/Work/claude-board.home/versions/abc\n'), '/Users/x/Work/claude-board.home/versions/abc');
  assert.equal(lsofCwd('p4242\nfcwd\nn/path with spaces/b\n'), '/path with spaces/b');
  assert.equal(lsofCwd(''), null);
  assert.equal(lsofCwd('p4242\n'), null);
  assert.equal(lsofCwd('p4242\nfcwd\nnrelative/x\n'), null);
});

test('a relay or cb started through the copy path watches and relaunches through it, not the real version folder', () => {
  assert.equal(startedAs(join(live, 'cli', 'relay.ts'), join(home, 'versions', B, 'cli', 'relay.ts')), join(live, 'cli', 'relay.ts'));
  assert.equal(startedAs(undefined, '/r/cli/relay.ts'), '/r/cli/relay.ts');
  assert.equal(startedAs('/t/test-runner.mjs', '/r/cli/relay.ts'), '/r/cli/relay.ts'); // imported, not run: its own path
  const src = readFileSync('cli/relay.ts', 'utf8');
  assert.doesNotMatch(src.replace(/startedAs\(process\.argv\[1\], import\.meta\.filename\)/, ''), /import\.meta\.(filename|dirname)/, 'relay.ts watches or relaunches by its real path');
});

// last: it serves releases whose schema the test board lacks, and moves the board's noted schema (put back at the end)
test('schema gate: cb update refuses, writing nothing, a release whose schema the board\'s database does not have; it names what to deploy', { timeout: 300_000 }, async () => {
  const sql = clients[0];
  const ours = schemaSha('db/schema.sql'); // what the test board applied (this checkout's schema)
  const where = realpathSync(live), st = readFileSync(join(home, 'versions', 'state.json'), 'utf8'), vs = readdirSync(join(home, 'versions')).sort();
  const untouched = () => {
    assert.equal(realpathSync(live), where, 'the link moved');
    assert.equal(readFileSync(join(home, 'versions', 'state.json'), 'utf8'), st, 'state.json changed');
    assert.deepEqual(readdirSync(join(home, 'versions')).sort(), vs, 'something was staged');
    assert.ok(!existsSync(`${live}.update.lock`), 'a lock was left');
  };
  edit('db/schema.sql', '\n-- a schema the board has not applied\n');
  const S = commit('S: new schema');
  const need = sha(readFileSync(join(repo, 'db', 'schema.sql')));
  try {
    const r = await cb(['update', '--from', base, '--root', live]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.err, new RegExp(`the board's database runs an older schema than release ${S.slice(0, 7)} needs \\(the release's db/schema\\.sql ${need.slice(0, 8)}, the board's ${ours.slice(0, 8)}\\): `
      + `deploy release ${S.slice(0, 7)} to the board first \\(docs/ops/maintain\\.md, Upgrade: the board and its schema go first\\), then cb update again`));
    untouched();

    // the order: a schema first applied before the current one is covered (forward only); one first applied after it
    // (the board rolled back since) or never applied is not
    assert.equal((await sql`select cb.schema_covers(${ours}) as c`)[0].c, true);
    await recordSchema(sql, need); // the board deployed S
    assert.deepEqual((await sql`select cb.schema_covers(${need}) as n, cb.schema_covers(${ours}) as o, cb.schema_covers(${'f'.repeat(64)}) as x`)[0], { n: true, o: true, x: false });
    await recordSchema(sql, ours); // and was rolled back
    assert.deepEqual((await sql`select cb.schema_covers(${need}) as n, cb.schema_covers(${ours}) as o`)[0], { n: false, o: true });
    assert.deepEqual((await sql`select cb.schema_applied() as a`)[0].a.seen.slice(-2), [ours, need], 'each schema once, in the order first applied');

    // a board from before the gate (no cb.schema_applied): refused the same way
    await sql`alter function cb.schema_applied() rename to schema_applied_gone`;
    try {
      const o = await cb(['update', '--from', base, '--root', live]);
      assert.equal(o.code, 1, o.out);
      assert.match(o.err, new RegExp(`the board's database does not say which schema it runs \\(it runs a board from before cb update's schema check\\): deploy release ${S.slice(0, 7)} to the board first`));
      untouched();
    } finally { await sql`alter function cb.schema_applied_gone() rename to schema_applied`; }
  } finally {
    await recordSchema(sql, ours);
    git('reset', '-q', '--hard', 'HEAD~1'); setRelease(releaseAt(repo));
  }
});
