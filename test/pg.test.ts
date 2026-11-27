import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import postgres from 'postgres';
import { ensurePg, ensureTestPg, spawnWithin, testPgPort, testPortStart } from '../db/pg.ts';

// the private cluster is Windows-only (initdb.exe, pg_ctl.exe; db/pg.ts): elsewhere Postgres is started by hand (#4401)
test('ensurePg creates the cluster when .pgdata is missing', { timeout: 120_000, skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cb-pg-')), '.pgdata');
  const pgCtl = join(process.env.CB_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin', 'pg_ctl.exe');
  try {
    ensurePg(dir, 5439);
    const sql = postgres('postgres://cb@127.0.0.1:5439/postgres', { onnotice: () => {} });
    const [r] = await sql`select current_user as u`;
    await sql.end();
    assert.equal(r.u, 'cb');
  } finally {
    spawnSync(pgCtl, ['-D', dir, 'stop', '-m', 'immediate', '-w'], { stdio: 'ignore' });
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

// #4401: with no Postgres where CB_PG_BIN says, the error said "undefined" (spawnSync failed to start, so no output)
test('ensurePg says why it could not create the cluster and what to set', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cb-pg-')), '.pgdata');
  const r = spawnSync(process.execPath, ['-e', `import('./db/pg.ts').then((m) => m.ensurePg(${JSON.stringify(dir)}, 5441)).catch((e) => { console.log(e.message); })`],
    { encoding: 'utf8', env: { ...process.env, CB_PG_BIN: join(dir, '..', 'no-such-bin') } });
  rmSync(join(dir, '..'), { recursive: true, force: true });
  assert.match(r.stdout, /could not create Postgres cluster in .*: .*ENOENT.*CB_PG_BIN/s);
  assert.doesNotMatch(r.stdout, /undefined/);
});

// #4413: every Windows worktree tested on 127.0.0.1:5434, served by whichever worktree's cluster started first; eight
// parallel runs exhausted its 100 connections and failed when it was in crash recovery. A worktree gets its own port.
test('a Windows worktree tests on its own port; the main checkout and other platforms keep 5434', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cb-pg-'));
  const tree = join(tmp, 'tree'), main = join(tmp, 'main');
  try {
    mkdirSync(tree); writeFileSync(join(tree, '.git'), 'gitdir: elsewhere\n'); // a worktree's .git is a file
    mkdirSync(join(main, '.git'), { recursive: true });
    const port = testPgPort(tree, 'win32');
    assert.notEqual(port, 5434);
    assert.ok(port >= 15435 && port < 16454, `port ${port} in the worktree range`);
    assert.equal(testPgPort(tree, 'win32'), port, 'the same worktree gets the same port');
    assert.equal(testPgPort(main, 'win32'), 5434, 'the main checkout');
    assert.equal(testPgPort(tree, 'darwin'), 5434, 'the Mac: Postgres started by hand on 5434');
    assert.equal(testPgPort(tree, 'linux'), 5434);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// #4413 review: pg_isready says "no response" for a non-Postgres listener as for an empty port, so a port another
// program held was chosen and the tests reached that program. Any accepted connection means taken.
test('a worktree skips a port another program listens on', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cb-pg-'));
  const tree = join(tmp, 'tree');
  mkdirSync(tree); writeFileSync(join(tree, '.git'), 'gitdir: elsewhere\n');
  const start = testPortStart(tree);
  const other = createServer(() => {});
  try {
    await new Promise<void>((ok, fail) => { other.once('error', fail); other.listen(start, '127.0.0.1', ok); });
    assert.notEqual(testPgPort(tree, 'win32'), start);
  } finally {
    other.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The root cause of #4413: a worktree adopted whichever Postgres answered on its port. Its test cluster must be its own:
// with another cluster on the port, the search skips it, and a start there fails instead of using the other one.
test('a worktree never adopts another Postgres on its port', { timeout: 180_000, skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cb-pg-'));
  const tree = join(tmp, 'tree'), otherDir = join(tmp, 'other', '.pgdata');
  mkdirSync(tree); writeFileSync(join(tree, '.git'), 'gitdir: elsewhere\n');
  const port = testPortStart(tree);
  const pgCtl = join(process.env.CB_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin', 'pg_ctl.exe');
  try {
    ensurePg(otherDir, port); // another worktree's cluster, on this worktree's first port
    assert.notEqual(testPgPort(tree, 'win32'), port, 'the port search skips it');
    assert.throws(() => ensureTestPg(`postgres://cb@127.0.0.1:${port}/claude_board_test`, tree), /could not start Postgres/);
  } finally {
    spawnSync(pgCtl, ['-D', join(tree, '.pgdata'), 'stop', '-m', 'immediate', '-w'], { stdio: 'ignore' });
    spawnSync(pgCtl, ['-D', otherDir, 'stop', '-m', 'immediate', '-w'], { stdio: 'ignore' });
    rmSync(tmp, { recursive: true, force: true });
  }
});

// #4413 review: --stop without --test ran the full dev setup (schema and PATH) against CB_DATABASE_URL's board.
test('setup --stop without --test refuses and touches no database', () => {
  const r = spawnSync(process.execPath, ['db/setup.ts', '--stop'],
    { encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: 'postgres://cb@127.0.0.1:1/claude_board_test_stop' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--stop only stops a worktree's test cluster: run node db\/setup\.ts --test --stop/);
  assert.doesNotMatch(r.stderr, /ECONNREFUSED/, 'it never tried to connect');
});

// #4482 hardening: every child the test cluster's start waits on (initdb, pg_ctl, the port probe) has a deadline, and a
// timed-out child throws in words: it never returns a null status that a caller's `.status === 0` would read as "not
// running" (and start a second cluster).
test('spawnWithin: a child that never exits fails fast in words; one that exits in time passes through', () => {
  const t0 = Date.now();
  assert.throws(() => spawnWithin(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }, 500, 'the fake pg_ctl start'),
    /^Error: the fake pg_ctl start did not finish within 0\.5 s$/);
  assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
  const ok = spawnWithin(process.execPath, ['-e', 'console.log(7); process.exit(3)'], { encoding: 'utf8' }, 30_000, 'x');
  assert.deepEqual([ok.status, String(ok.stdout).trim()], [3, '7']);
});

// #4482 root cause: the postmaster holds every inheritable handle in the chain that starts it. Run from an agent's Git
// Bash with output piped (node --test ... | tail), that included the pipe the shell reads: the run that started a
// worktree's cluster never returned, its tests long done, until the cluster stopped; a rerun (cluster up) passed. Here a
// stray inheritable pipe (cmd.exe's fd 3) sits above the start: it must close when the start ends, the cluster still up.
test('a worktree cluster holds no handle of the run that started it', { timeout: 240_000, skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cb-pg-'));
  const tree = join(tmp, 'tree'), dir = join(tree, '.pgdata').replace(/\\/g, '/');
  mkdirSync(tree); writeFileSync(join(tree, '.git'), 'gitdir: elsewhere\n');
  const port = testPgPort(tree, 'win32');
  const pgCtl = join(process.env.CB_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin', 'pg_ctl.exe');
  const js = `import('${new URL('../db/pg.ts', import.meta.url).href}').then((m) => { m.ensurePg('${dir}', ${port}, false); console.log('started'); })`;
  try {
    const c = spawn('cmd.exe', ['/d', '/s', '/c', `node -e "${js}"`], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true });
    let out = '';
    c.stdout!.on('data', (d) => { out += d; }); c.stderr!.on('data', (d) => { out += d; }); c.stdio[3]!.on('data', () => {});
    const closed = new Promise<boolean>((r) => c.stdio[3]!.on('close', () => r(true)));
    await new Promise((r) => c.on('exit', r));
    assert.match(out, /started/);
    assert.equal(await Promise.race([closed, new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]), true,
      'the postmaster still holds a pipe of the run that started it');
    assert.equal(spawnSync(pgCtl, ['-D', dir, 'status'], { stdio: 'ignore' }).status, 0, 'the cluster is still up');
  } finally {
    spawnSync(pgCtl, ['-D', dir, 'stop', '-m', 'immediate', '-w'], { stdio: 'ignore' });
    rmSync(tmp, { recursive: true, force: true });
  }
});

