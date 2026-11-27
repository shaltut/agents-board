// #4337: cb retries a statement only while the board is unreachable before it was sent (refused, timed out on
// connect, DNS), for ~10 s; a statement that may have reached the board is never sent again. The first tests are pure;
// the last two run cb through a TCP proxy in front of the test database, on a non-local address so the retry is on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { neverSent, ranWords, withConnectRetry } from '../cli/connect-retry.ts';
import { serveBridge, openBridge } from '../cli/bridge.ts';
import { freshDb, TEST_URL } from './helpers.ts';
import { connect } from '../server/db.ts';

// Windows and Linux route all of 127/8 to loopback; macOS binds only 127.0.0.1 unless an alias is added
const noAlias = await new Promise<string | false>((r) => { const s = net.createServer(); s.once('error', () => r('127.0.0.2 is not bound here (macOS: sudo ifconfig lo0 alias 127.0.0.2)')); s.listen(0, '127.0.0.2', () => s.close(() => r(false))); });

const err = (code: string, syscall?: string, message = `${syscall ?? 'read'} ${code}`) => Object.assign(new Error(message), { code, ...(syscall ? { syscall } : {}) });

test('neverSent: refused, DNS and connect timeouts; never an error that can come after a statement was sent', () => {
  for (const e of [err('ECONNREFUSED', 'connect'), err('ECONNREFUSED'), err('ENOTFOUND', 'getaddrinfo'), err('EAI_AGAIN', 'getaddrinfo'),
    err('CONNECT_TIMEOUT'), err('ETIMEDOUT', 'connect'), err('EHOSTUNREACH', 'connect'), err('ENETUNREACH', 'connect'),
    err('ECONNRESET', undefined, 'Client network socket disconnected before secure TLS connection was established'),
    new AggregateError([err('ECONNREFUSED', 'connect'), err('ETIMEDOUT', 'connect')], 'all failed')])
    assert.equal(neverSent(e), true, `${(e as any).code} ${e.message}`);
  // after a write: reset, read timeout, closed, relay lost, a board restart mid-query; and anything not a network error
  for (const e of [err('ECONNRESET'), err('ETIMEDOUT', 'read'), err('ETIMEDOUT'), err('EHOSTUNREACH', 'write'), err('EPIPE', 'write'),
    err('CONNECTION_CLOSED'), err('CONNECTION_DESTROYED'), err('RELAY_LOST'), err('57P01'), err('23505'), new TypeError('x'), null, 'ECONNREFUSED',
    new AggregateError([err('ECONNREFUSED', 'connect'), err('ECONNRESET')], 'mixed')])
    assert.equal(neverSent(e), false, String((e as any)?.code ?? e));
});

/** A fake sql: each call takes the next outcome (an Error is thrown). */
function fake(outcomes: any[]) {
  const calls: string[] = [];
  const next = (what: string) => { calls.push(what); const r = outcomes.shift(); return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); };
  const db: any = (s: any, ...v: any[]) => Array.isArray(s?.raw) ? next(`q:${s.join('?')}`) : { list: s };
  db.unsafe = (text: string) => next(`u:${text}`);
  db.begin = (body: (tx: any) => any) => { calls.push('begin'); const r = outcomes.shift(); return r instanceof Error ? Promise.reject(r) : body('tx'); };
  db.end = () => 'ended'; db.binding = { actor: 'W1' };
  return { db, calls };
}
const clock = () => { let t = 0; const slept: number[] = []; return { slept, now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; } }; };

test('withConnectRetry: a refused statement is sent again with backoff until it answers', async () => {
  const c = clock(), { db, calls } = fake([err('ECONNREFUSED', 'connect'), err('CONNECT_TIMEOUT'), [{ ok: 1 }]]);
  const sql = withConnectRetry(db, c);
  assert.deepEqual(await sql`select ${1}`, [{ ok: 1 }]);
  assert.equal(calls.length, 3);
  assert.deepEqual(c.slept, [500, 1000]);
  assert.deepEqual(sql([1, 2]), { list: [1, 2] }); // sql(list) is a helper, passed through
  assert.equal(sql.end(), 'ended'); assert.deepEqual(sql.binding, { actor: 'W1' });
});

test('withConnectRetry: a statement that may have been sent is never sent again', async () => {
  for (const e of [err('ECONNRESET'), err('ETIMEDOUT', 'read'), err('CONNECTION_CLOSED'), err('RELAY_LOST')]) {
    const c = clock(), { db, calls } = fake([e, ['twice']]);
    await assert.rejects(withConnectRetry(db, c).unsafe('select cb.task_add()'), (x: any) => x === e && x.tries === undefined);
    assert.equal(calls.length, 1, e.code);
  }
});

test('withConnectRetry: gives up within the budget and says how often it tried', async () => {
  const c = clock(), { db, calls } = fake(Array.from({ length: 20 }, () => err('ECONNREFUSED', 'connect')));
  await assert.rejects(withConnectRetry(db, { ...c, budgetMs: 10_000 }).unsafe('select 1'), (x: any) => x.code === 'ECONNREFUSED' && x.tries === 5);
  assert.deepEqual(c.slept, [500, 1000, 2000, 4000]); // 7.5 s slept; the next 8 s wait would pass 10 s
  assert.equal(calls.length, 5);
});

test('withConnectRetry: a transaction is retried only if its body never started', async () => {
  let ran = 0;
  const a = fake([err('ECONNREFUSED', 'connect'), 'go']);
  assert.equal(await withConnectRetry(a.db, clock()).begin(async (tx: any) => (ran++, tx)), 'tx');
  assert.equal(ran, 1);
  assert.deepEqual(a.calls, ['begin', 'begin']);
  // the body ran, then a connect-class error came out of it: it is not run again
  const b = fake(['go', 'go']);
  await assert.rejects(withConnectRetry(b.db, clock()).begin(async () => { ran++; throw err('ECONNREFUSED', 'connect'); }));
  assert.equal(ran, 2);
  assert.deepEqual(b.calls, ['begin']);
});

test('ranWords: "did not run" only when nothing of the command reached the board; "may have run" after a send', () => {
  assert.match(ranWords(err('ECONNREFUSED', 'connect'), 0)!, /never reached it, so this command did not run/);
  // a committed write, then a read that never got through (cb tell, done, bug, run): never "did not run" (#3331)
  const later = ranWords(err('CONNECT_TIMEOUT'), 1)!;
  assert.doesNotMatch(later, /did not run/);
  assert.match(later, /an earlier step of this command did and may have saved your change: check with cb before running it again/);
  for (const e of [err('ECONNRESET'), err('EPIPE', 'write'), err('ETIMEDOUT', 'read'), err('CONNECTION_CLOSED'), err('CONNECTION_DESTROYED'), err('RELAY_LOST'), err('57P01')])
    for (const n of [0, 3]) assert.match(ranWords(e, n)!, /may have reached it, so this command may have run: check with cb/, `${e.code} ${n}`);
  for (const e of [new TypeError('x'), err('23505'), null]) assert.equal(ranWords(e, 0), null);
});

test('withConnectRetry: answered counts what the board answered, so a later unreachable read never reads as "did not run"', async () => {
  const { db } = fake([[{ id: 7 }], ...Array.from({ length: 20 }, () => err('ECONNREFUSED', 'connect'))]);
  const sql = withConnectRetry(db, clock());
  await sql.unsafe('select cb.tell($1) as result', ['W2']); // the write: answered
  assert.equal(sql.answered, 1);
  const e = await sql`select live from cb.sessions`.catch((x: any) => x); // the follow-up read: the board went away
  assert.equal(e.code, 'ECONNREFUSED');
  assert.equal(sql.answered, 1);
  assert.doesNotMatch(ranWords(e, sql.answered)!, /did not run/);
});

test('the relay bridge forwards syscall: a connect timeout is retried through it, a read timeout is not', async () => {
  const key = `t4337-${process.pid}`, url = 'postgres://cb@board.invalid:5434/claude_board';
  const outcomes: any[] = [];
  const relaySql: any = () => Promise.resolve([]);
  relaySql.unsafe = () => { const r = outcomes.shift(); return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); };
  const stop = await serveBridge(relaySql, key, url);
  try {
    const db = await openBridge(key, url);
    assert.ok(db, 'bridge opened');
    outcomes.push(err('ETIMEDOUT', 'connect'), [{ result: 'ok' }]);
    assert.deepEqual(await withConnectRetry(db, clock()).unsafe('select 1'), [{ result: 'ok' }]);
    outcomes.push(err('ETIMEDOUT', 'read'), [{ result: 'twice' }]);
    const e = await withConnectRetry(db, clock()).unsafe('select 1').catch((x: any) => x);
    assert.equal(e.code, 'ETIMEDOUT'); assert.equal(e.syscall, 'read');
    assert.equal(outcomes.length, 1, 'not sent again');
    await db.end();
  } finally { await stop(); }
});

// ---- through a real proxy: cb against a "remote" board (127.0.0.2 is loopback but not in cb's local list) ----
const target = new URL(TEST_URL);
const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

/** Listens on 127.0.0.2:<port> and forwards to the test database. onData may cut the client off. */
function proxy(port: number, onData?: (chunk: Buffer, client: net.Socket) => boolean) {
  const server = net.createServer((client) => {
    const up = net.connect(Number(target.port), target.hostname);
    client.on('error', () => {}); up.on('error', () => {});
    up.on('data', (d) => client.write(d)); up.on('close', () => client.destroy());
    client.on('data', (d) => { up.write(d); if (onData?.(d, client)) client.resetAndDestroy(); });
    client.on('close', () => up.end());
  });
  return new Promise<net.Server>((r, j) => { server.once('error', j); server.listen(port, '127.0.0.2', () => r(server)); });
}
const freePort = () => new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
function cbAsync(args: string[], port: number) {
  const p = spawn(process.execPath, ['cli/cb.ts', ...args], { env: { ...process.env, CB_DATABASE_URL: remote(port), CB_ACTOR: 'W1@test', HERDR_PANE_ID: '' } });
  let out = '', errs = '';
  p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => errs += d);
  return new Promise<{ code: number | null; out: string; err: string }>((r) => p.on('close', (code) => r({ code, out: out.trim(), err: errs.trim() })));
}

const remote = (port: number) => { const u = new URL(TEST_URL); u.hostname = '127.0.0.2'; u.port = String(port); return u.href; };

test('a statement asked while nothing listens waits until the board is back, on a real connection', { skip: noAlias }, async () => {
  const sql = await freshDb(); clients.push(sql);
  const port = await freePort();
  const db = connect(remote(port), { max: 1 }); clients.push(db);
  const t0 = Date.now();
  const asked = withConnectRetry(db)`select cb.task_add(project => 'demo', title => 'Back soon', actor => 'W1@test') as id`;
  await new Promise((r) => setTimeout(r, 1200)); // refused until now
  const server = await proxy(port);
  try {
    const [row] = await asked;
    assert.equal(row.id, 1);
    assert.ok(Date.now() - t0 >= 1200);
    assert.equal((await sql`select count(*)::int as n from cb.tasks`)[0].n, 1);
  } finally { server.close(); }
});

test('cb says it tried and that the call never reached a board that stays away', { skip: noAlias }, async () => {
  const port = await freePort(); // nothing ever listens
  const r = await cbAsync(['add', 'demo', 'Never sent'], port);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /board unreachable at 127\.0\.0\.2 \(ECONNREFUSED, tried \d+ times over \d+ s\): the call that failed never reached it, so this command did not run/);
  assert.match(r.err, /keep working/);
});

test('cb never resends a write whose connection dropped after it was sent', { skip: noAlias }, async () => {
  const sql = await freshDb(); clients.push(sql);
  const port = await freePort();
  // postgres.js sends a new statement's text first (parse, describe), then bind and execute: cut the client off right
  // after the execute is forwarded, so the board runs the write and cb never hears back
  let seen = false;
  const server = await proxy(port, (d) => { if (seen) return true; seen = d.includes('cb.task_add'); return false; });
  try {
    const r = await cbAsync(['add', 'demo', 'Sent once'], port);
    assert.equal(r.code, 1, r.out);
    assert.doesNotMatch(r.err, /tried \d+ times|never reached/);
    assert.match(r.err, /lost the board connection at 127\.0\.0\.2 \(ECONNRESET\): the call that failed may have reached it, so this command may have run: check with cb before running it again/);
    // the board ran it (the write reached it before the drop); give it a moment to commit
    let n = 0;
    for (let i = 0; i < 20 && n === 0; i++) { n = (await sql`select count(*)::int as n from cb.tasks`)[0].n; if (!n) await new Promise((x) => setTimeout(x, 100)); }
    assert.equal(n, 1);
  } finally { server.close(); }
});
