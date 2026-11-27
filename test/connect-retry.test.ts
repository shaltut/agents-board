// #4337: cb retries a statement only while the board is unreachable before it was sent (refused, timed out on
// connect, DNS), for ~10 s; a statement that may have reached the board is never sent again. The first tests are pure;
// the last two run cb through a TCP proxy in front of the test database, on a non-local address so the retry is on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { neverSent, ranWords, withConnectRetry, checkFirst, onlyReads } from '../cli/connect-retry.ts';
import { namesCommand, COMMANDS } from '../cli/help.ts';
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
  const check = 'check with cb show 42 before running it again';
  assert.match(ranWords(err('ECONNREFUSED', 'connect'), 0, check)!, /never reached it, so this command did not run$/);
  // a committed write, then a read that never got through (cb tell, done, bug, run): never "did not run" (#3331)
  const later = ranWords(err('CONNECT_TIMEOUT'), 1, check)!;
  assert.doesNotMatch(later, /did not run/);
  assert.match(later, /an earlier step of this command did and may have saved your change: check with cb show 42 before running it again$/);
  for (const e of [err('ECONNRESET'), err('EPIPE', 'write'), err('ETIMEDOUT', 'read'), err('CONNECTION_CLOSED'), err('CONNECTION_DESTROYED'), err('RELAY_LOST'), err('57P01')])
    for (const n of [0, 3]) assert.match(ranWords(e, n, check)!, /may have reached it, so this command may have run: check with cb show 42 before/, `${e.code} ${n}`);
  for (const e of [new TypeError('x'), err('23505'), null]) assert.equal(ranWords(e, 0, check), null);
});

// #4450: "check with cb before running it again" named no command, and passed the names-a-command check by accident
test('checkFirst names the command that shows whether this one landed, and every answer passes the names-a-command check', () => {
  const me = 'W1@test';
  for (const [cmd, args, want] of [
    ['done', ['#42', 'fixed'], 'check with cb show 42 before running it again'],
    ['log', ['42', 'note'], 'check with cb show 42 before running it again'],
    ['move', ['42', 'review'], 'check with cb show 42 before running it again'],
    ['add', ['demo', 'Fix the "month" parse  in rows', 'row 8812 reads 1900'], 'check with cb search demo "Fix the month parse in rows" before running it again'],
    // bare words are the title, joined, as cb add reads them (title-body.ts); not just the first word (review M1)
    ['add', ['demo', 'Fix', 'month', 'parse'], 'check with cb search demo "Fix month parse" before running it again'],
    // a backslash becomes a space, so the path keeps its parts apart (review I1)
    ['bug', ['demo', 'Path C:\\w\\cli breaks'], 'check with cb search demo "Path C: w cli breaks" before running it again'],
    ['bug', ['demo', 'one two three four five six seven eight'], 'check with cb search demo "one two three four five six" before running it again'],
    // a leading - would exclude the word from the search; a - inside a word stays
    ['add', ['demo', 'Drop the -v flag from re-runs'], 'check with cb search demo "Drop the v flag from re-runs" before running it again'],
    ['pass', ['42', 'built'], 'check with cb show 42 --json (its stage; a card in parts: the parts line of cb show 42) before running it again'],
    ['tell', ['W2@test', 'hi'], 'check with cb session W1@test (the messages you sent are in its RECENT list) before running it again'],
    ['broadcast', ['hi all'], 'check with cb session W1@test (the messages you sent are in its RECENT list) before running it again'],
    ['run', ['test'], 'check with cb jobs (the queued and running jobs) before running it again'],
    ['next', [], 'check with cb mine (your cards) or cb session W1@test (what the board last recorded from you) before running it again'],
    ['show', ['42'], 'it only reads, so running it again is safe'],
  ] as const) assert.equal(checkFirst(cmd, [...args], me), want, cmd);
  assert.match(checkFirst('ask', ['demo', 'q?'], me), /^send the same cb ask again, unchanged: a question still open is returned, not asked twice \(with pictures it posts again: check cb brief demo first\)$/);
  for (const cmd of ['done', 'pass', 'add', 'bug', 'tell', 'ask', 'run', 'next', 'iam', 'mem', undefined])
    assert.ok(namesCommand(ranWords(err('ECONNRESET'), 0, checkFirst(cmd, ['42', 'x'], me))!), String(cmd));
  // the old words, and anything else where a plain word follows "cb", no longer count as naming a command
  assert.equal(namesCommand('the call that failed may have reached it, so this command may have run: check with cb before running it again'), false);
  assert.equal(namesCommand('cb briefly said no'), false);
  for (const m of ['Run: cb help done', 'check the id: cb mine lists yours', 'use `cb ask`', 'cb mem find "x"']) assert.ok(namesCommand(m), m);
});

// #4515: READS listed show, search, session, sessions and digest only, so cb brief, mine and resume (run after a
// compaction) were told they may have saved a change. The mark lives on the command table in cli/help.ts.
test('onlyReads: every command that only reads, and only the read forms of a command that also writes', () => {
  for (const [cmd, args] of [['brief', []], ['mine', []], ['resume', []], ['tick', ['demo']], ['goals', []], ['epics', []],
    ['pending', []], ['role', ['builder']], ['users', []], ['huddles', []], ['jobs', []], ['show', ['42']], ['search', ['x']],
    ['session', ['W1']], ['sessions', []], ['digest', ['demo']], ['start', []], ['help', []], ['mem', ['find', 'x']], ['mem', ['list']],
    ['mem', ['show', 'M3']], ['page', ['show', '42']], ['squad', ['show', 'demo']], ['huddle', ['show', '3']], ['lock', ['queue']],
    ['job', ['show', '7']], ['job', ['log', '7']], ['job', ['7']], ['asks', []], ['github', []]] as const) {
    assert.equal(onlyReads(cmd, [...args]), true, `${cmd} ${args.join(' ')}`);
    assert.equal(checkFirst(cmd, [...args], 'W1@test'), 'it only reads, so running it again is safe', cmd);
  }
  for (const [cmd, args] of [['next', []], ['iam', ['W1']], ['run', ['test']], ['relay', []], ['runner', []], ['supervise', []],
    ['mem', ['add', 'x']], ['page', ['set', '42']], ['squad', ['set', 'demo']], ['squad', ['up', 'demo']], ['huddle', ['say', '3']],
    ['lock', ['take', 'db']], ['job', ['cancel', '7']], ['asks', ['add', 'x']], ['github', ['add', 'o/r']], ['user', ['add', 'x']],
    ['log', ['42', 'x']], ['delivered', ['12']], ['nope', []], [undefined, []]] as const)
    assert.equal(onlyReads(cmd, [...args]), false, `${cmd} ${args.join(' ')}`);
  // a command its help calls read-only carries the mark, so a new one is not missed
  for (const [name, c] of Object.entries(COMMANDS)) if (/Read-only/.test(c.does)) assert.equal(c.reads, true, `cb ${name} says Read-only: mark it reads: true`);
});

test('withConnectRetry: answered counts what the board answered, so a later unreachable read never reads as "did not run"', async () => {
  const { db } = fake([[{ id: 7 }], ...Array.from({ length: 20 }, () => err('ECONNREFUSED', 'connect'))]);
  const sql = withConnectRetry(db, clock());
  await sql.unsafe('select cb.tell($1) as result', ['W2']); // the write: answered
  assert.equal(sql.answered, 1);
  const e = await sql`select live from cb.sessions`.catch((x: any) => x); // the follow-up read: the board went away
  assert.equal(e.code, 'ECONNREFUSED');
  assert.equal(sql.answered, 1);
  assert.doesNotMatch(ranWords(e, sql.answered, 'check with cb mine before running it again')!, /did not run/);
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
  assert.equal(r.code, 3, r.out); // #4450: did not run has its own exit code, so a script need not parse the words
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
    const r = await cbAsync(['add', 'demo', 'Sent "once", not -twice'], port);
    assert.equal(r.code, 1, r.out);
    assert.doesNotMatch(r.err, /tried \d+ times|never reached/);
    // #4450: the check is a command the session can run, not "check with cb"
    assert.match(r.err, /lost the board connection at 127\.0\.0\.2 \(ECONNRESET\): the call that failed may have reached it, so this command may have run: check with cb search demo "Sent once, not twice" before running it again\. Keep working meanwhile\.$/);
    // the board ran it (the write reached it before the drop); give it a moment to commit
    let n = 0;
    for (let i = 0; i < 20 && n === 0; i++) { n = (await sql`select count(*)::int as n from cb.tasks`)[0].n; if (!n) await new Promise((x) => setTimeout(x, 100)); }
    assert.equal(n, 1);
    // and the check it names finds that card (cb search calls cb.task_find with these words and the project)
    const [{ f }] = await sql`select cb.task_find('Sent once, not twice', 'demo') as f`;
    assert.equal(f.total, 1);
    // review I1: a title holding a Windows path; the words checkFirst names must find it too
    const path = 'Path C:\\w\\rv-50\\cli breaks the guard';
    await sql`select cb.task_add(project => 'demo', title => ${path}, actor => 'W1@test')`;
    const w = /cb search demo "([^"]+)"/.exec(checkFirst('add', ['demo', path], 'W1@test'))![1]!;
    const [{ g }] = await sql`select cb.task_find(${w}, 'demo') as g`;
    assert.equal(g.total, 1, w);
  } finally { server.close(); }
});

// #4515: cb brief (run after a compaction) only reads: a connection lost after its statement was sent must say running
// it again is safe and exit 3, not "may have run: check with cb mine" and exit 1 as a write would.
test('a read whose connection dropped after it was sent says running it again is safe, and exits 3', { skip: noAlias }, async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  const port = await freePort();
  let seen = false;
  const server = await proxy(port, (d) => { if (seen) return true; seen = d.includes('cb.brief'); return false; });
  try {
    const r = await cbAsync(['brief', 'demo'], port);
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, /lost the board connection at 127\.0\.0\.2 \(ECONNRESET\): .*it only reads, so running it again is safe\. Keep working meanwhile\.$/);
    assert.doesNotMatch(r.err, /check with cb mine|saved your change/);
  } finally { server.close(); }
});

// review M3: exit 3 means nothing of the command reached the board. cb run --wait queues the job (answered), then polls
// every 3 s: the board goes away in between, the next poll is refused (never sent), and cb must still exit 1.
test('cb exits 1, never 3, when an earlier step of the command reached the board before it went away', { skip: noAlias, timeout: 60_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('test', 'p1', 'W1@test', 'demo', 'builder')`;
  const runner = connect(TEST_URL, { app: 'cb-runner/test', max: 1 }); clients.push(runner);
  await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1/', ${runner.json([{ project: 'demo', recipe: 'test', params: { files: { min: 1, max: 20 } }, db: false }] as any)})`;
  const port = await freePort();
  const socks = new Set<net.Socket>();
  const server = await proxy(port, (_d, c) => { socks.add(c); return false; });
  const p = spawn(process.execPath, ['cli/cb.ts', 'run', 'test', '--sha', 'abc1234', '--files', 'a.test.ts', '--project', 'demo', '--wait'],
    { env: { ...process.env, CB_DATABASE_URL: remote(port), CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', CLAUDE_CODE_MESSAGING_SOCKET: '' } });
  let out = '', errs = '';
  p.stderr.on('data', (d) => errs += d);
  const queued = new Promise<void>((r) => p.stdout.on('data', (d) => { out += d; if (/queued/.test(out)) r(); }));
  const code = new Promise<number | null>((r) => p.on('close', r));
  await queued; // job_add answered; the first poll follows at once, then cb sleeps 3 s before the next
  await new Promise((r) => setTimeout(r, 1000));
  server.close(); for (const s of socks) s.destroy(); // the board goes away: the next poll's connect is refused
  assert.equal(await code, 1, errs);
  assert.match(errs, /board unreachable at 127\.0\.0\.2 \(ECONNREFUSED, tried \d+ times over \d+ s\): the call that failed never reached it, but an earlier step of this command did and may have saved your change: check with cb jobs/);
  assert.equal((await sql`select count(*)::int as n from cb.jobs`)[0].n, 1);
});
