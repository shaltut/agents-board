// cb through its session's relay (2026-11-18): the relay's connection is already open, so a cb call skips the
// connect (TCP, SCRAM, type fetch: ~5 round trips, ~650 ms to a remote board) and re-uses prepared statements.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../server/db.ts';
import { freshDb, TEST_URL } from './helpers.ts';
import { serveBridge, openBridge, bridgeFiles, seatKey } from '../cli/bridge.ts';
import { claudeEndpointPath } from '../cli/agents/claude.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A relay's files are keyed per seat (machine + pane): each test has its own pane, with this process's pid in it.
const rmSeat = (machine: string, pane: string) => {
  const k = seatKey(machine, pane);
  for (const f of [join(tmpdir(), `cb-relay-${k}.pid`), join(tmpdir(), `cb-relay-${k}.log`), bridgeFiles(k).info, claudeEndpointPath(machine, pane)]) fs.rmSync(f, { force: true });
};
/** A stand-in for Claude's inbox that takes whatever comes: a relay stays up only while its agent's inbox is there. */
const listening = (path: string) => new Promise<net.Server>((r) => {
  const s = net.createServer((c) => { c.on('error', () => {}); c.resume(); });
  s.listen(path, () => r(s));
});
const closed = (s: net.Server) => new Promise((r) => s.close(r));

async function served(url = TEST_URL, opts: any = {}) {
  const sql = await freshDb(); clients.push(sql);
  const relaySql = connect(TEST_URL, { app: 'cb-relay', max: 1 }); clients.push(relaySql);
  const key = `t${process.pid}${Math.random().toString(36).slice(2, 6)}`;
  const files = bridgeFiles(key);
  const stop = await serveBridge(relaySql, key, url, undefined, opts);
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
  const pane = `p-bridge-${process.pid}`, key = seatKey('testbox', pane);
  rmSeat('testbox', pane);
  fs.writeFileSync(join(tmpdir(), `cb-relay-${key}.pid`), '');
  const box = await listening(inbox);
  const env = { ...process.env, CB_DATABASE_URL: TEST_URL, CB_MACHINE: 'testbox', HERDR_PANE_ID: pane, CB_ACTOR: 'W7', CB_AGENT: '',
                CLAUDE_CODE_MESSAGING_SOCKET: inbox, CLAUDE_CODE_MESSAGING_TOKEN: 'tok', PGAPPNAME: '' };
  const relay = spawn('node', ['cli/relay.ts', '--child'], { stdio: 'ignore', env });
  const exited = new Promise((r) => relay.on('exit', r));
  let leftBridge = false;
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
    await closed(box);
    leftBridge = fs.existsSync(bridgeFiles(key).info);
    rmSeat('testbox', pane);
  }
  assert.ok(!leftBridge || process.platform === 'win32', 'a stopped relay leaves no bridge behind');
});

// Speed 6 (#3256): the relay keeps its pane's binding (cb iam) and hands it to cb with the hello, so a cb call is one
// round trip, not two. Whatever changes a binding must reach the relay at once: a notice per changed row.
test('a changed binding is announced on cb_bind, whatever changed it; a heartbeat is not', async () => {
  const sql = await freshDb(); clients.push(sql);
  const heard: string[] = [];
  const l = connect(TEST_URL, { app: 'cb-relay', max: 1 }); clients.push(l);
  await l.listen('cb_bind', (p: string) => heard.push(p));
  const settle = async (n: number) => { for (let i = 0; i < 50 && heard.length < n; i++) await wait(20); await wait(100); };
  await sql`select cb.ensure_project('demo'), cb.ensure_project('other')`;
  await sql`select cb.inbox('PC', 'p1', 0)`;                       // the relay's own row
  await settle(1); assert.deepEqual(heard, ['pc:p1']);
  await sql`select cb.inbox('pc', 'p1', 0)`;                       // heartbeat: nothing changed
  await sql`select cb.iam('pc', 'p1', 'p1@pc', null)`;             // same name again: nothing changed
  await settle(2); assert.deepEqual(heard, ['pc:p1'], 'no notice without a change');
  await sql`select cb.iam('pc', 'p1', 'W1', 'demo')`;
  await settle(2); assert.deepEqual(heard.length, 2);
  await sql`update cb.projects set slug = 'demo2' where slug = 'demo'`; // a rename reaches the session by cascade
  await settle(3); assert.equal(heard.length, 3);
  const [{ i }] = await sql`select cb.inbox('pc', 'p1', 0) as i`;
  assert.deepEqual([i.actor, i.project], ['W1', 'demo2'], 'the inbox says the binding, so the relay keeps it fresh');
  await sql`delete from cb.sessions`;
  await settle(4); assert.deepEqual(heard.at(-1), 'pc:p1');
});

test('the hello carries the binding the relay holds: for its own pane only', async () => {
  const { key, stop } = await served(TEST_URL, { binding: (who: any) => who.machine === 'pc' && who.pane === 'p1' ? { actor: 'W1', project: 'demo' } : undefined });
  try {
    const mine: any = await openBridge(key, TEST_URL, undefined, { machine: 'pc', pane: 'p1' });
    assert.deepEqual(mine.binding, { actor: 'W1', project: 'demo' });
    await mine.end();
    const other: any = await openBridge(key, TEST_URL, undefined, { machine: 'pc', pane: 'p2' });
    assert.equal(other.binding, undefined, 'another pane looks itself up');
    await other.end();
  } finally { await stop(); }
});

test('cb uses the name the hello hands it, not a lookup of its own', { timeout: 30_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  const pane = `p-hello-${process.pid}`;
  await sql`select cb.iam('testbox', ${pane}, 'InTheTable', 'demo')`;
  const inbox = join(tmpdir(), `cb-hello-${process.pid}.sock`);
  const key = seatKey('testbox', pane);
  const relaySql = connect(TEST_URL, { app: 'cb-relay', max: 1 }); clients.push(relaySql);
  const stop = await serveBridge(relaySql, key, TEST_URL, undefined,
    { binding: (who: any) => who.machine === 'testbox' && who.pane === pane ? { actor: 'FromTheHello', project: 'demo' } : undefined });
  try {
    const env = { ...process.env, CB_DATABASE_URL: TEST_URL, CB_MACHINE: 'testbox', HERDR_PANE_ID: pane, PGAPPNAME: '',
                  CLAUDE_CODE_MESSAGING_SOCKET: inbox, CLAUDE_CODE_MESSAGING_TOKEN: 'tok' };
    delete (env as any).CB_ACTOR;
    // not spawnSync: the bridge lives in this process and must answer cb's hello meanwhile
    const child = spawn('node', ['cli/cb.ts', 'add', 'demo', 'named by the hello'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0, err);
    const [t] = await sql`select created_by from cb.tasks`;
    assert.equal(t.created_by, 'FromTheHello');
  } finally { await stop(); }
});

test('cb takes its name from the relay, and hears every change: its own cb iam, a direct cb iam, the dashboard', { timeout: 60_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  const inbox = process.platform === 'win32' ? String.raw`\\.\pipe\cb-bind-test-` + process.pid : join(tmpdir(), `cb-bind-${process.pid}.sock`);
  const pane = `p-bind-${process.pid}`, key = seatKey('testbox', pane);
  rmSeat('testbox', pane);
  fs.writeFileSync(join(tmpdir(), `cb-relay-${key}.pid`), '');
  const box = await listening(inbox);
  // base: a cb that does not use the relay (PGAPPNAME set: cb connects itself, as 'cb')
  const base = { ...process.env, CB_DATABASE_URL: TEST_URL, CB_MACHINE: 'testbox', HERDR_PANE_ID: pane, CB_AGENT: '', PGAPPNAME: 'cb',
                 CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '' };
  delete (base as any).CB_ACTOR;
  const env = { ...base, PGAPPNAME: '', CLAUDE_CODE_MESSAGING_SOCKET: inbox, CLAUDE_CODE_MESSAGING_TOKEN: 'tok' };
  const relay = spawn('node', ['cli/relay.ts', '--child'], { stdio: 'ignore', env });
  const exited = new Promise((r) => relay.on('exit', r));
  const cb = (e: any, ...a: string[]) => { const r = spawnSync('node', ['cli/cb.ts', ...a], { encoding: 'utf8', env: e }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  let n = 0;
  const addedBy = async () => { cb(env, 'add', 'demo', `t${++n}`); const [t] = await sql`select created_by from cb.tasks where title = ${'t' + n}`; return t.created_by; };
  try {
    for (let i = 0; i < 50 && !fs.existsSync(bridgeFiles(key).info); i++) await wait(100);
    cb(env, 'iam', 'W8', 'demo');
    assert.equal(await addedBy(), 'W8', 'its own cb iam, through the relay');
    await sql`select cb.iam('testbox', ${pane}, 'W9', null)`;          // the dashboard's way
    await wait(400);
    assert.equal(await addedBy(), 'W9');
    cb(base, 'iam', 'W10');                                          // a cb without the relay
    await wait(400);
    assert.equal(await addedBy(), 'W10');
    // the relay's connections cut (Postgres restarted, a network change): a rename meanwhile is not missed
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name like 'cb-relay%'`;
    await sql`select cb.iam('testbox', ${pane}, 'W11', null)`;
    assert.equal(await addedBy(), 'W11', 'no notice could reach the relay: cb must not get the old name');
    await wait(1500);
    assert.equal(await addedBy(), 'W11');
  } finally {
    relay.kill();
    await exited;
    await closed(box);
    rmSeat('testbox', pane);
  }
});

/** cb add in a child process (the bridge lives in this one and must answer cb's hello meanwhile): who it was added as. */
async function addedVia(sql: any, env: Record<string, string>, title: string) {
  const child = spawn('node', ['cli/cb.ts', 'add', 'demo', title], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr!.on('data', (d) => { err += d; });
  const code = await Promise.race([new Promise((r) => child.on('exit', r)), wait(20_000).then(() => { child.kill(); return 'timeout'; })]);
  assert.equal(code, 0, err);
  return (await sql`select created_by from cb.tasks where title = ${title}`)[0]?.created_by;
}
/** cb's env in a seat, with nothing from the session running these tests. */
function seatEnv(pane: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CB_DATABASE_URL: TEST_URL, CB_MACHINE: 'testbox', HERDR_PANE_ID: pane, CB_AGENT: '', PGAPPNAME: '' };
  delete env.CB_ACTOR; delete env.CLAUDE_CODE_MESSAGING_SOCKET; delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  return { ...env, ...extra };
}

test('cb finds bridge by seatKey without CLAUDE_CODE_MESSAGING_SOCKET', { timeout: 30_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  const pane = `p-seat-${process.pid}`;
  const relaySql = connect(TEST_URL, { app: 'cb-relay', max: 1 }); clients.push(relaySql);
  const stop = await serveBridge(relaySql, seatKey('testbox', pane), TEST_URL, undefined,
    { binding: (who: any) => who.machine === 'testbox' && who.pane === pane ? { actor: 'FromTheSeat', project: 'demo' } : undefined });
  try {
    assert.equal(await addedVia(sql, seatEnv(pane), 'by seat'), 'FromTheSeat', 'cb went through the seat relay (its hello named it)');
  } finally { await stop(); }
});

test('cb falls back to legacy sha1(SOCKET) bridge key during rolling upgrade', { timeout: 30_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  const pane = `p-legacy-${process.pid}`, inbox = join(tmpdir(), `cb-legacy-${process.pid}.sock`);
  // a relay that has not restarted yet: keyed by its Claude's socket, as before Stage B
  const relaySql = connect(TEST_URL, { app: 'cb-relay', max: 1 }); clients.push(relaySql);
  const stop = await serveBridge(relaySql, createHash('sha1').update(inbox).digest('hex').slice(0, 12), TEST_URL, undefined,
    { binding: (who: any) => who.machine === 'testbox' && who.pane === pane ? { actor: 'FromTheOldRelay', project: 'demo' } : undefined });
  try {
    const env = seatEnv(pane, { CLAUDE_CODE_MESSAGING_SOCKET: inbox, CLAUDE_CODE_MESSAGING_TOKEN: 'tok' });
    assert.equal(await addedVia(sql, env, 'by socket'), 'FromTheOldRelay', 'cb went through the old relay (its hello named it)');
  } finally { await stop(); }
});

test('a sql`` fragment passed as a value is refused with a clear error, not "#<Promise> could not be cloned"', async () => {
  const { key, stop } = await served();
  try {
    const db: any = await openBridge(key, TEST_URL);
    const frag = db`select 1`; frag.catch(() => {}); // a postgres.js fragment is a Promise
    await assert.rejects(db`select ${frag}`, /cannot carry a sql`` fragment/);
    assert.equal((await db`select ${2}::int as n`)[0].n, 2, 'plain values still work');
  } finally { await stop(); }
});

test('cb ask: a stored question exits 0 even when the board drops right after, and a resend posts no second copy (#3331)', { timeout: 60_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  const pane = `p-ask-${process.pid}`;
  const relaySql = connect(TEST_URL, { app: 'cb-relay', max: 1 }); clients.push(relaySql);
  // a relay whose board connection drops once the question is in: the insert runs in cb's own transaction, the
  // reads after it come through here and time out, as seen live ("board unreachable (CONNECT_TIMEOUT)", then a duplicate)
  const flaky: any = (strings: any, ...values: any[]) => Array.isArray(strings?.raw) && /from cb\.sessions where actor|select parent_id, if_answer/.test(strings.join('$'))
    ? Promise.reject(Object.assign(new Error('write CONNECT_TIMEOUT'), { code: 'CONNECT_TIMEOUT' })) : relaySql(strings, ...values);
  flaky.unsafe = (...a: any[]) => relaySql.unsafe(...a);
  const stop = await serveBridge(flaky, seatKey('testbox', pane), TEST_URL, undefined,
    { binding: (who: any) => who.pane === pane ? { actor: 'W5@test', project: null } : undefined });
  const ask = async (...a: string[]) => {
    const child = spawn('node', ['cli/cb.ts', 'ask', 'demo', 'Ship it tonight?', ...a], { env: seatEnv(pane), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout!.on('data', (d) => { out += d; }); child.stderr!.on('data', (d) => { err += d; });
    const code = await Promise.race([new Promise((r) => child.on('exit', r)), wait(20_000).then(() => { child.kill(); return 'timeout'; })]);
    return { code, out: out.trim(), err: err.trim() };
  };
  try {
    const first = await ask('-o', 'Yes', '-o', 'No');
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /^Q1 posted/);
    const again = await ask('-o', 'Yes', '-o', 'No');
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /^Q1 is already on the board/);
    assert.deepEqual((await sql`select id, asked_by from cb.questions`).map((q: any) => [q.id, q.asked_by]), [['1', 'W5@test']], 'one question, not two');
    // --json says it was a resend (#4453); the relay read failed, so whether a relay listens is unknown, not false
    const json = await ask('-o', 'Yes', '-o', 'No', '--json');
    assert.equal(json.code, 0, json.err);
    assert.deepEqual(JSON.parse(json.out), { id: 1, duplicate: true, parent: null, if_answer: null, relay_live: null });
    // other options are another question; so is the same one once the first is withdrawn
    const other = await ask('-o', 'Yes', '-o', 'Tomorrow');
    assert.match(other.out, /^Q2 posted/, other.err);
    await sql`select cb.withdraw('1', 'W5@test')`;
    const third = await ask('-o', 'Yes', '-o', 'No');
    assert.match(third.out, /^Q3 posted/, third.err);
    // a follow-up: its parent read fails too, and the message falls back to what was asked
    const follow = await ask('-o', 'Yes', '-o', 'No', '--after', 'Q2', '--if', 'Yes');
    assert.equal(follow.code, 0, follow.err);
    assert.match(follow.out, /^Q4 posted as a follow-up to Q2: it opens only if Q2 is answered "Yes"/);
    const fj = await ask('-o', 'Yes', '-o', 'No', '--after', 'Q2', '--if', 'Yes', '--json'); // the parent from what was asked, still a number
    assert.deepEqual(JSON.parse(fj.out), { id: 4, duplicate: true, parent: 2, if_answer: 'Yes', relay_live: null }, fj.err);
  } finally { await stop(); }
});
