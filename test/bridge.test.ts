// cb through its session's relay (2026-11-18): the relay's connection is already open, so a cb call skips the
// connect (TCP, SCRAM, type fetch: ~5 round trips, ~650 ms from Egypt to the VPS) and re-uses prepared statements.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../server/db.ts';
import { freshDb, TEST_URL } from './helpers.ts';
import { serveBridge, openBridge, bridgeFiles } from '../cli/bridge.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function served(url = TEST_URL) {
  const sql = await freshDb(); clients.push(sql);
  const relaySql = connect(TEST_URL, { app: 'cb-relay', max: 1 }); clients.push(relaySql);
  const key = `t${process.pid}${Math.random().toString(36).slice(2, 6)}`;
  const files = bridgeFiles(key);
  const stop = await serveBridge(relaySql, key, url);
  return { sql, key, files, stop };
}

test('a query through the bridge: params, IN lists, jsonb, dates, and Postgres errors with their code', async () => {
  const { sql, key, stop } = await served();
  try {
    await sql`select cb.task_add(project => 'demo', title => 'first', actor => 'W1')`;
    await sql`select cb.task_add(project => 'demo', title => 'second', actor => 'W1')`;
    const db: any = await openBridge(key, TEST_URL);
    assert.ok(db, 'bridge opened');
    const rows = await db`select id, title, created_at from cb.tasks where id in ${db([1, 2])} order by id`;
    assert.deepEqual(rows.map((r: any) => [r.id, r.title]), [[1, 'first'], [2, 'second']]);
    assert.ok(rows[0].created_at instanceof Date);
    const [{ j }] = await db.unsafe(`select $1::jsonb as j`, [{ a: [1, 2] }]) // as callFn passes jsonb;
    assert.deepEqual(j, { a: [1, 2] });
    await assert.rejects(db`select cb.task_move(${'999'}, 'done', 'x', 'W1')`, (e: any) => /task #999 not found/.test(e.message) && typeof e.code === 'string');
    // concurrent queries each get their own answer
    const [a, b] = await Promise.all([db`select ${'a'}::text as v`, db`select ${'b'}::text as v`]);
    assert.deepEqual([a[0].v, b[0].v], ['a', 'b']);
    await db.end();
  } finally { await stop(); }
});

test('the bridge refuses a cb that points at another database, or has the wrong token: cb then connects itself', async () => {
  const { key, files, stop } = await served('postgres://cb@vps:5434/claude_board');
  try {
    // a test run inside a live session inherits its socket: it must never reach the live board through the relay
    assert.equal(await openBridge(key, TEST_URL), null);
    const info = JSON.parse(fs.readFileSync(files.info, 'utf8'));
    fs.writeFileSync(files.info, JSON.stringify({ ...info, token: 'wrong' }));
    assert.equal(await openBridge(key, 'postgres://cb@vps:5434/claude_board'), null);
  } finally { await stop(); }
  assert.equal(await openBridge('no-such-relay', TEST_URL), null, 'no relay: null at once');
});

test('cb in a session with a relay runs through it, and opens no connection of its own', { timeout: 30_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  const inbox = process.platform === 'win32' ? String.raw`\\.\pipe\cb-bridge-test-` + process.pid : join(tmpdir(), `cb-bridge-${process.pid}.sock`);
  const key = createHash('sha1').update(inbox).digest('hex').slice(0, 12);
  fs.writeFileSync(join(tmpdir(), `cb-relay-${key}.pid`), '');
  const env = { ...process.env, CB_DATABASE_URL: TEST_URL, CB_MACHINE: 'testbox', HERDR_PANE_ID: 'p7', CB_ACTOR: 'W7',
                CLAUDE_CODE_MESSAGING_SOCKET: inbox, CLAUDE_CODE_MESSAGING_TOKEN: 'tok', PGAPPNAME: '' };
  const relay = spawn('node', ['cli/relay.ts', '--child'], { stdio: 'ignore', env });
  const exited = new Promise((r) => relay.on('exit', r));
  try {
    for (let i = 0; i < 50 && !fs.existsSync(bridgeFiles(key).info); i++) await wait(100);
    assert.ok(fs.existsSync(bridgeFiles(key).info), 'relay published its bridge');
    // cb names its own connections 'cb': none may appear while it runs through the relay
    let own = 0, done = false;
    const watch = (async () => { while (!done) {
      const [{ n }] = await sql`select count(*)::int as n from pg_stat_activity where application_name = 'cb'`;
      own = Math.max(own, n); await wait(20);
    } })();
    const r = spawnSync('node', ['cli/cb.ts', 'add', 'demo', 'via the relay'], { encoding: 'utf8', env });
    done = true; await watch;
    assert.equal(r.status, 0, r.stderr);
    const [t] = await sql`select title, created_by from cb.tasks`;
    assert.deepEqual({ ...t }, { title: 'via the relay', created_by: 'W7' });
    assert.equal(own, 0, 'cb opened its own connection');
  } finally {
    relay.kill();
    await exited;
  }
  assert.ok(!fs.existsSync(bridgeFiles(key).info) || process.platform === 'win32', 'a stopped relay leaves no bridge behind');
});
