// #3222 slice S5 (#4895): one supervisor anywhere, by a lease row on the board in place of a session advisory lock, so the
// same rule holds over an API. cb.leases, cb.lease_take/renew/release; cli/lease.ts renews it on its own timer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { connect } from '../server/db.ts';
import { fenced, keepAlive, keepAliveApart, supervisorLease, SURE_MS } from '../cli/lease.ts';
import { startOne, type Launch, type Runner } from '../cli/squad-up.ts';

const clients: any[] = [], renewing: (() => unknown)[] = [];
// every renewal a test starts is stopped here too: one left running after a failed assertion keeps the file's process
// alive, and the job holds its runner until it is cancelled (job 17535)
after(async () => {
  await Promise.all(renewing.map((stop) => stop()));
  await Promise.all(clients.map((c) => c.end()));
});
const timed = (...a: Parameters<typeof keepAlive>) => { const stop = keepAlive(...a); renewing.push(stop); return stop; };
const apart = (...a: Parameters<typeof keepAliveApart>) => { const r = keepAliveApart(...a); renewing.push(() => r.stop()); return r; };
const conn = (name: string) => { const c = postgres(TEST_URL, { max: 1, onnotice: () => {}, connection: { application_name: name } }); clients.push(c); return c; };
async function setup() {
  const sql = await freshDb(); clients.push(sql);
  return { sql, sup: conn('cb-supervisor/test') };
}
const row = async (sql: any) => (await sql`select holder, token, expires_at, extract(epoch from expires_at - now())::int as left_s from cb.leases where name = 'supervisor'`)[0];
const expire = (sql: any) => sql`update cb.leases set expires_at = now() - interval '1 second'`;
const take = async (sup: any, holder: string) => (await sup`select cb.lease_take('supervisor', ${holder}) as r`)[0].r;
const renew = async (sup: any, token: string) => (await sup`select cb.lease_renew('supervisor', ${token}) as ok`)[0].ok;
const client = () => connect(TEST_URL, { app: 'cb-supervisor/test', max: 1 });
const lease = (holder: string, clock?: () => number) => supervisorLease({ connect: client, holder, clock });
const hold = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** every renewal of the lease, by the database's clock (this machine's); answers the function that removes the log */
async function logWrites(sql: any) {
  await sql`create table if not exists public.lease_writes (at_ms double precision)`;
  await sql`truncate public.lease_writes`;
  await sql.unsafe(`create or replace function public.lease_write() returns trigger language plpgsql as
    $$ begin insert into public.lease_writes values (extract(epoch from clock_timestamp()) * 1000); return new; end $$;
    create trigger lease_write after update on cb.leases for each row execute function public.lease_write()`);
  return () => sql.unsafe('drop trigger if exists lease_write on cb.leases; drop function if exists public.lease_write(); drop table if exists public.lease_writes');
}
const writesBetween = async (sql: any, from: number, to: number) => (await sql`select count(*)::int as n from public.lease_writes where at_ms > ${from} and at_ms < ${to}`)[0].n as number;
async function writesAfter(sql: any, from: number) {
  for (let i = 0; i < 200; i++) {
    if (await writesBetween(sql, from, Date.now() + 60_000)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('the lease was not renewed');
}
const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(done(), 'it never happened'); };

test('a lease is taken for 180 s; another is refused with who holds it and for how long, until it runs out', async () => {
  const { sql, sup } = await setup();
  const a = await take(sup, 'pc pid 1');
  assert.match(a.token, /^[0-9a-f-]{36}$/);
  const held = await row(sql);
  assert.ok(held.left_s > 170 && held.left_s <= 180, String(held.left_s));
  const b = await take(sup, 'mac pid 2');
  assert.deepEqual([b.token, b.holder], [undefined, 'pc pid 1']);
  assert.ok(b.left_s > 170 && b.left_s <= 180, String(b.left_s));
  await expire(sql);
  const c = await take(sup, 'mac pid 2');
  assert.ok(c.token && c.token !== a.token, 'takeover after expiry');
  assert.equal(await renew(sup, a.token), false, 'the old holder renews nothing');
  assert.equal(await renew(sup, c.token), true);
});

test('renew keeps its own lease, also one that ran out and nobody took; release ends only its own', async () => {
  const { sql, sup } = await setup();
  const a = await take(sup, 'pc pid 1');
  await expire(sql);
  assert.equal(await renew(sup, a.token), true, 'a PC that slept still holds it: nobody else took it');
  assert.ok((await row(sql)).left_s > 170);
  const other = '00000000-0000-0000-0000-000000000000';
  assert.equal((await sup`select cb.lease_release('supervisor', ${other}) as ok`)[0].ok, false);
  assert.equal((await sup`select cb.lease_release('supervisor', ${a.token}) as ok`)[0].ok, true);
  assert.equal(await row(sql), undefined);
});

test('the same holder takes it again: a take whose answer was lost does not refuse the one that asked', async () => {
  const { sup } = await setup();
  const a = await take(sup, 'pc pid 1');
  const again = await take(sup, 'pc pid 1');
  assert.ok(again.token && again.token !== a.token);
});

test('only the supervisor takes, renews or releases a lease', async () => {
  await setup();
  const seat = conn('cb-test/session');
  const t = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(seat`select cb.lease_take('supervisor', 'x')`, /only the supervisor/);
  await assert.rejects(seat`select cb.lease_renew('supervisor', ${t})`, /only the supervisor/);
  await assert.rejects(seat`select cb.lease_release('supervisor', ${t})`, /only the supervisor/);
});

test('the Runners page says the supervisor runs while its lease has not run out', async () => {
  const { sql, sup } = await setup();
  const up = async () => (await sql`select cb._supervisor_up() as up`)[0].up;
  assert.equal(await up(), false);
  await take(sup, 'pc pid 1');
  assert.equal(await up(), true);
  await expire(sql);
  assert.equal(await up(), false);
});

function supervise(...flags: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'cb-lease-'));
  const r = spawnSync('node', ['cli/supervise.ts', ...flags], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_RUNNER_CONFIG: join(home, 'none.json'), CB_SUPERVISOR_HOME: home },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('a second supervisor is refused and leaves the lease alone; a dry run previews beside it', async () => {
  const { sql, sup } = await setup(); // empty board: nothing a stray tick could act on
  const a = await take(sup, 'pc pid 1');
  const second = supervise('--once');
  assert.equal(second.code, 1, second.out);
  assert.match(second.out, /another supervisor is running: pc pid 1 holds the lease/);
  const dry = supervise('--dry-run');
  assert.equal(dry.code, 0, dry.out);
  assert.equal((await row(sql)).token, a.token);
});

test('a dry run takes no lease; --once takes it and gives it back', async () => {
  const { sql } = await setup();
  const dry = supervise('--dry-run');
  assert.equal(dry.code, 0, dry.out);
  assert.equal(await row(sql), undefined);
  assert.equal((await sql`select count(*)::int as n from cb.leases`)[0].n, 0);
  await sql`create table if not exists public.lease_seen (holder text)`;
  await sql`truncate public.lease_seen`;
  await sql.unsafe(`create or replace function public.lease_note() returns trigger language plpgsql as
    $$ begin insert into public.lease_seen values (new.holder); return new; end $$;
    create trigger lease_note after insert on cb.leases for each row execute function public.lease_note()`);
  try {
    const once = supervise('--once');
    assert.equal(once.code, 0, once.out);
    assert.equal((await sql`select count(*)::int as n from public.lease_seen`)[0].n, 1, 'it took the lease');
    assert.equal(await row(sql), undefined, 'and released it at exit: the next start need not wait');
  } finally {
    await sql.unsafe('drop trigger if exists lease_note on cb.leases; drop function if exists public.lease_note(); drop table if exists public.lease_seen');
  }
});

test('a renewal the board refuses aborts the tick and then exits', async () => {
  const { sql } = await setup();
  const mine = lease('pc pid 1');
  const did: string[] = [];
  try {
    assert.equal(await mine.keep(), null);
    const stop = timed(mine, { every: 25, abort: () => did.push('abort'), lost: (why) => did.push(why), say: () => {} });
    await sql`update cb.leases set holder = 'mac pid 2', token = gen_random_uuid()`; // another took it
    await until(() => did.length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    stop();
    assert.equal(did.length, 2, 'once');
    assert.equal(did[0], 'abort', 'the tick first');
    assert.match(did[1]!, /no longer this supervisor's/);
  } finally { await mine.release(); }
});

// found reading the start path: startOne is synchronous (spawnSync herdr, Atomics.wait), so one seat's start holds the
// main thread, for longer than the lease lasts when its first prompt stalls: a timer on that thread renews nothing
test('the lease is renewed while the main thread is held, and a refusal reaches it', async () => {
  const { sql } = await setup();
  const mine = lease('pc pid 1');
  assert.equal(await mine.keep(), null);
  const unlog = await logWrites(sql);
  const did: string[] = [];
  const renewal = apart(mine.token()!, { app: 'cb-supervisor/test', every: 100, silentMs: 60_000, abort: () => did.push('abort'), lost: (why) => did.push(why), say: () => {} });
  try {
    await writesAfter(sql, 0);
    const from = Date.now();
    hold(2000); // as a seat's start holds it
    const to = Date.now(); // nothing on this thread has run since `from`
    const n = await writesBetween(sql, from + 300, to - 300);
    assert.ok(n >= 3, `renewed ${n} times while held`);
    assert.deepEqual(did, []);
    await sql`update cb.leases set holder = 'mac pid 2', token = gen_random_uuid()`; // another took it
    await until(() => did.length >= 2);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(did.length, 2, did.join(' | '));
    assert.equal(did[0], 'abort', 'the tick first');
    assert.match(did[1]!, /no longer this supervisor's/);
  } finally {
    await renewal.stop();
    await unlog();
    await mine.release();
  }
});

// the lead's bound on #4895: a thread that renewed on its own for ever would keep the lease for a supervisor whose main
// thread is hung, and no other could take over
test('the thread stops renewing when the main thread says nothing past the limit, and goes on at its next word', async () => {
  const { sql } = await setup();
  const mine = lease('pc pid 1');
  assert.equal(await mine.keep(), null);
  const unlog = await logWrites(sql);
  const did: string[] = [], said: string[] = [];
  const renewal = apart(mine.token()!, { app: 'cb-supervisor/test', every: 100, silentMs: 1500, abort: () => did.push('abort'), lost: () => did.push('lost'), say: (l) => said.push(l) });
  try {
    await writesAfter(sql, 0);
    // a start of several steps, longer than the limit in all, with a word before each step: renewed to its end
    const from = Date.now();
    for (let i = 0; i < 4; i++) { renewal.beat(); hold(700); }
    const steps = Date.now();
    assert.ok(await writesBetween(sql, from + 1900, steps - 100) >= 2, 'a word before each step keeps it going');
    renewal.beat();
    const quiet = Date.now();
    hold(4000); // hung: no word
    const woke = Date.now();
    assert.ok(await writesBetween(sql, quiet, quiet + 1300) >= 1, 'renewed within the limit');
    assert.equal(await writesBetween(sql, quiet + 2200, woke - 100), 0, 'not past it: the lease runs out and another can take it');
    await until(() => did.includes('abort'));
    assert.deepEqual(did, ['abort'], 'the held tick is aborted once; the process stays');
    assert.match(said.join(' '), /nothing from the supervisor/);
    const back = Date.now();
    renewal.beat();
    await writesAfter(sql, back);
  } finally {
    await renewal.stop();
    await unlog();
    await mine.release();
  }
});

// R2 on PR 206: while startOne holds the main thread, what the renewal thread reports waits in the queue, so each herdr
// call has to ask for itself whether the lease still stands
const LAUNCH = { name: 'demo-B1@m', agent: 'claude', model: 'sonnet', role: 'builder', repo: 'main', machine: 'm', herdr: null,
  cwd: 'C:/w/x', board: 'C:/w/board', prompt: 'cb next', env: {} } as unknown as Launch;
/** A seat start whose first herdr call (its pane) holds the main thread for ms; the calls herdr was given */
function heldStart(renewal: ReturnType<typeof keepAliveApart>, ms: number) {
  const calls: string[] = [];
  const herdr: Runner = (_m, args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (calls.length === 1) hold(ms);
    return { status: 0, stdout: JSON.stringify({ result: { pane_id: 'p1' } }), stderr: '' } as ReturnType<Runner>;
  };
  const run = fenced(herdr, () => renewal); // as one tick's
  return { calls, run, herdr, r: startOne(LAUNCH, run, {}, () => {}) };
}
/** sends the query now, so that the database acts on it while this thread is held */
async function meanwhile(sql: any, text: string) {
  const query = sql.unsafe(text).execute();
  await new Promise((r) => setTimeout(r, 300));
  return { done: query };
}

test('a lease another takes while a seat start holds the thread: no herdr call follows, before the thread yields', async () => {
  const { sql } = await setup();
  const mine = lease('pc pid 1');
  assert.equal(await mine.keep(), null);
  const did: string[] = [];
  const renewal = apart(mine.token()!, { app: 'cb-supervisor/test', every: 100, silentMs: 60_000, abort: () => did.push('abort'), lost: () => did.push('lost'), say: () => {} });
  try {
    assert.equal(renewal.sure(), true);
    const other = await meanwhile(sql, `do $$ begin perform pg_sleep(1); update cb.leases set holder = 'mac pid 2', token = gen_random_uuid(); end $$`);
    const { calls, r } = heldStart(renewal, 3000);
    assert.deepEqual(did, [], 'nothing reported yet: this thread has not yielded');
    assert.deepEqual(calls, ['tab create'], r.line);
    assert.equal(r.ok, false);
    assert.match(r.line, /supervisor lease cannot be counted on/);
    await other.done;
    await until(() => did.includes('lost'));
  } finally { await renewal.stop(); await mine.release(); }
});

test('a board that stops answering while a seat start holds the thread: no herdr call follows once the lease cannot be counted on', async () => {
  const { sql } = await setup();
  const mine = lease('pc pid 1');
  assert.equal(await mine.keep(), null);
  const unlog = await logWrites(sql);
  const renewal = apart(mine.token()!, { app: 'cb-supervisor/test', every: 100, silentMs: 60_000, sureMs: 2500, abort: () => {}, lost: () => {}, say: () => {} });
  try {
    await writesAfter(sql, 0);
    // the row held locked: the thread's renewals get no answer
    const locked = await meanwhile(sql, `do $$ begin perform 1 from cb.leases for update; perform pg_sleep(6); end $$`);
    const { calls, run, herdr, r } = heldStart(renewal, 4000);
    assert.deepEqual(calls, ['tab create'], r.line);
    assert.equal(r.ok, false);
    await locked.done;
    for (let i = 0; i < 200 && !renewal.sure(); i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(renewal.sure(), true, 'renewed again');
    // R2: the tick that was refused stays stopped; only the next one calls herdr again
    assert.throws(() => run(null, ['agent', 'list']), /supervisor lease cannot be counted on/);
    assert.deepEqual(calls, ['tab create']);
    fenced(herdr, () => renewal)(null, ['agent', 'list']);
    assert.deepEqual(calls, ['tab create', 'agent list']);
  } finally {
    await renewal.stop();
    await unlog();
    await mine.release();
  }
});

test('a lease still renewed lets every herdr call of a held start through; no renewal (a dry run) fences nothing', async () => {
  const { sql } = await setup();
  const mine = lease('pc pid 1');
  assert.equal(await mine.keep(), null);
  const renewal = apart(mine.token()!, { app: 'cb-supervisor/test', every: 100, silentMs: 60_000, sureMs: 2500, abort: () => {}, lost: () => {}, say: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const { calls, r } = heldStart(renewal, 4000);
    assert.ok(calls.length > 1 && calls.includes('agent start'), `${calls.join(', ')}: ${r.line}`);
    const seen: string[] = [];
    fenced((_m, args) => { seen.push(args[0]!); return { status: 0 } as ReturnType<Runner>; }, () => undefined)(null, ['agent', 'list']);
    assert.deepEqual(seen, ['agent']);
  } finally { await renewal.stop(); await mine.release(); }
  assert.equal(renewal.sure(), false, 'stopped: nothing is counted on');
});

// found reading the diff: the timer could renew a lease being deleted (read as "another took it", exit 1), and the loop
// could take it again between the delete and the exit, leaving the next start to wait it out
test('a lease being given back is not renewed or taken again', async () => {
  const { sql } = await setup();
  const mine = lease('pc pid 1');
  assert.equal(await mine.keep(), null);
  const going = mine.release();
  assert.equal(mine.holds(), false, 'the timer asks nothing');
  await assert.rejects(mine.keep(), /given back/);
  await going;
  assert.equal(await row(sql), undefined);
});

test('a board that does not answer is no refusal: the tick is aborted only once the lease cannot be counted on', async () => {
  await setup();
  let now = 1_000_000, broken = false;
  const flaky = () => {
    const real = client();
    return { unsafe: (text: string, values: any[]) => (broken ? Promise.reject(new Error('connection refused')) : real.unsafe(text, values)),
      end: (o?: any) => real.end(o) };
  };
  const mine = supervisorLease({ connect: flaky, holder: 'pc pid 1', clock: () => now });
  const did: string[] = [], said: string[] = [];
  try {
    assert.equal(await mine.keep(), null);
    broken = true;
    const stop = timed(mine, { every: 25, abort: () => did.push('abort'), lost: () => did.push('lost'), say: (l) => said.push(l) });
    await until(() => said.length >= 2);
    assert.deepEqual(did, [], 'renewed a moment ago: still sure of it');
    now += SURE_MS;
    await until(() => did.includes('abort'));
    assert.ok(!did.includes('lost'), 'it does not exit');
    broken = false;
    await until(() => mine.sure());
    stop();
    assert.match(said[0]!, /not renewed/);
  } finally { broken = false; await mine.release(); }
});
