// #3222 S2: the worker API (/w/v1). A worker signs in with its machine's key; the board decides what that key may call
// and as whom. Every key here is made by the test database and thrown away with it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');
const { closeWorker, failure, wire, workerApp } = await import('../server/worker.ts');
const { setRelease } = await import('../server/release.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), closeWorker(), serverSql.end()]));

/** A wiped board: the dashboard's connection (it issues and revokes keys) and a session's (psql with no special name). */
async function board() {
  const sql = await freshDb();
  const session = postgres(TEST_URL, { onnotice: () => {}, max: 1, connection: { application_name: 'cb' } });
  clients.push(sql, session);
  await sql`select cb.ensure_project('demo')`;
  return { sql, session };
}
const issue = async (sql: any, machine = 'boxa', kind = 'machine', runner: string | null = null): Promise<string> =>
  (await sql`select cb.key_issue(${machine}, ${kind}, ${runner}) as key`)[0].key;
const idOf = (key: string) => key.split('_')[1]!;
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const call = (key: string, fn: string, args: object = {}) => app.request(`/w/v1/call/${fn}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...bearer(key) }, body: JSON.stringify({ args }),
});
const result = async (res: Response) => {
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.result;
};
const task = { project: 'demo', title: 'synthetic-title-never-logged', actor: 'W1@boxa' };

/** console.log while fn runs, as one text. */
async function logged(fn: () => Promise<unknown>) {
  const lines: string[] = [], orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

test('an allowed call works, is bound to the key, and logs one line with no argument and no secret', async () => {
  const { sql } = await board();
  const key = await issue(sql);
  assert.match(key, /^cbk1_[0-9a-f]{10}_[A-Za-z0-9_-]{43}$/);
  const hello = await app.request('/w/v1/hello', { headers: bearer(key) });
  assert.equal(hello.headers.get('x-cb-proto'), '1');
  const who = await hello.json() as any;
  assert.deepEqual([who.ok, who.key, who.kind, who.machine, who.runner], [true, idOf(key), 'machine', 'boxa', null]);

  await sql.unsafe(`create or replace function public.zz_seen() returns trigger language plpgsql as $$ begin
      new.data := new.data || jsonb_build_object('app', current_setting('application_name'), 'timeout', current_setting('statement_timeout'));
      return new; end $$;
    create or replace trigger zz_seen before insert on cb.events for each row execute function public.zz_seen()`);
  try {
    let id: unknown;
    const log = await logged(async () => { id = await result(await call(key, 'task_add', task)); });
    assert.equal(id, 1);
    const [e] = await sql`select client, actor, data from cb.events where kind = 'task_created'`;
    assert.deepEqual([e.client, e.actor, e.data.app, e.data.timeout], [idOf(key), 'W1@boxa', 'cb-api/seat', '30s']);
    assert.match(log, new RegExp(`key ${idOf(key)} task_add 200 \\d+ms`));
    assert.equal(log.split('\n').length, 1, log);
    assert.ok(!log.includes('synthetic-title') && !log.includes(key.slice(-43)), log);
    // a write that did not come through the API names no key
    await sql`select cb.task_add('demo', 'direct', actor => 'ahmed')`;
    assert.equal((await sql`select client from cb.events where kind = 'task_created' order by id desc limit 1`)[0].client, null);
  } finally {
    await sql.unsafe('drop trigger if exists zz_seen on cb.events; drop function if exists public.zz_seen()');
  }
  assert.ok((await sql`select last_used_at from cb.worker_keys where id = ${idOf(key)}`)[0].last_used_at);
});

test('what is not listed does not exist: 42883, whatever the key', async () => {
  const { sql } = await board();
  const key = await issue(sql);
  for (const fn of ['nope', 'type_to', 'user_add', 'user_password', 'user_show', 'user_set_role', 'key_issue', 'key_revoke', 'key_check',
    'keys_list', '_actor_ok', 'set_actor', 'answer', 'send_back', 'seen', 'mem_confirm', 'runner_set', 'project_state', 'github_mute',
    'github_watch_add', 'github_watch_remove', 'role_text_set', 'lease_take', 'lease_renew', 'lease_release',
    // the runner's own, until the slice that moves it lists them for its key
    'job_claim', 'job_finish', 'runner_beat', 'runner_hello', 'runner_reconcile_held', 'runner_settings', 'jobs_cancelled',
    'constructor', '__proto__']) {
    const res = await call(key, fn, { actor: 'W1@boxa' });
    const body = await res.json() as any;
    assert.deepEqual([res.status, body.ok, body.code], [404, false, '42883'], `${fn}: ${JSON.stringify(body)}`);
  }
  for (const [method, path] of [['GET', '/w/v1/call/task_add'], ['GET', '/w/v1/keys'], ['POST', '/w/v1/hello'], ['GET', '/w/v1'], ['GET', '/w/other']] as const) {
    assert.equal((await app.request(path, { method, headers: bearer(key) })).status, 404, `${method} ${path}`);
  }
});

test('no key, a bad key or a revoked key: 401, and no cookie or link signs a worker in', async () => {
  const { sql } = await board();
  const key = await issue(sql);
  const wrongSecret = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
  const unknownId = `cbk1_0000000000_${key.slice(-43)}`;
  const [{ token }] = await sql`insert into cb.users (name, display, role, token) values ('ada', 'Ada', 'admin', 'synthetic-cookie') returning token`;
  const refused: Record<string, string>[] = [{}, bearer(''), bearer('cbk1_short'), bearer(wrongSecret), bearer(unknownId), { cookie: `cb_user=${token}` }];
  for (const headers of refused) {
    for (const [method, path] of [['POST', '/w/v1/call/task_add'], ['GET', '/w/v1/hello'], ['GET', '/w/v1/events?ch=cb']] as const) {
      const res = await app.request(path, { method, headers, ...(method === 'POST' ? { body: JSON.stringify({ args: task }) } : {}) });
      assert.equal(res.status, 401, `${method} ${path} ${Object.keys(headers)}`);
    }
  }
  const link = await app.request(`/w/v1/hello?u=${token}`, { headers: bearer(key) });
  assert.equal(link.headers.get('set-cookie'), null);

  assert.equal((await call(key, 'task_add', task)).status, 200);
  await sql`select cb.key_revoke(${idOf(key)})`;
  assert.equal((await call(key, 'task_add', task)).status, 401);
  assert.equal((await app.request('/w/v1/hello', { headers: bearer(key) })).status, 401);
  assert.equal((await sql`select count(*)::int as n from cb.tasks`)[0].n, 1);
});

test('a write names an actor of the key\'s own machine, never the owner; a read may name anyone', async () => {
  const { sql } = await board();
  const key = await issue(sql);
  for (const actor of ['W1@boxb', 'ahmed', 'ahmed@boxa', 'Ahmed@boxa', 'supervisor', 'W1', 'W1@boxa@boxa', 'a b@boxa', '@boxa', '', null, undefined, ['W1@boxa']]) {
    const res = await call(key, 'task_add', { project: 'demo', title: 'x', ...(actor === undefined ? {} : { actor }) });
    assert.equal(res.status, 403, `actor ${JSON.stringify(actor)}: ${await res.text()}`);
  }
  assert.equal((await sql`select count(*)::int as n from cb.tasks`)[0].n, 0);
  assert.equal((await call(key, 'resume', { actor: 'W1@boxb' })).status, 200, 'a read');
});

test('cb._actor_ok: a machine key acts as its own seats, the supervisor key as the supervisor, nothing else', async () => {
  const { sql } = await board();
  const ok = async (kind: string, actor: string | null) => (await sql`select cb._actor_ok(${kind}, 'boxa', ${actor}) as ok`)[0].ok;
  assert.equal(await ok('machine', 'claude-board-B2@boxa'), true);
  assert.equal(await ok('supervisor', 'supervisor'), true);
  for (const [kind, actor] of [['machine', 'W1@boxb'], ['machine', 'supervisor'], ['machine', 'ahmed@boxa'], ['machine', null],
    ['supervisor', 'W1@boxa'], ['supervisor', 'ahmed'], ['runner', 'W1@boxa'], ['other', 'W1@boxa']] as const) {
    assert.equal(await ok(kind, actor), false, `${kind} ${actor}`);
  }
});

test('the machine is the key\'s: filled in when missing, refused when another is named; a memory\'s machine is a label', async () => {
  const { sql } = await board();
  const key = await issue(sql);
  await result(await call(key, 'iam', { pane: 'p1', actor: 'W1@boxa', project: 'demo' }));
  assert.deepEqual([...await sql`select machine, pane from cb.sessions`].map((s) => `${s.machine}:${s.pane}`), ['boxa:p1']);
  const other = await call(key, 'iam', { machine: 'boxb', pane: 'p2', actor: 'W1@boxa', project: 'demo' });
  assert.equal(other.status, 403);
  assert.equal((await sql`select count(*)::int as n from cb.sessions`)[0].n, 1);
  await result(await call(key, 'mem_add', { project: 'demo', title: 'about another machine', kind: 'gotcha', machine: 'boxb', actor: 'W1@boxa' }));
});

test('a key calls only what its kind is for', async () => {
  const { sql } = await board();
  const runner = await issue(sql, 'boxa', 'runner', 'runner-a'), supervisor = await issue(sql, 'boxa', 'supervisor');
  for (const [key, actor] of [[runner, 'W1@boxa'], [supervisor, 'supervisor']] as const) {
    const res = await call(key, 'task_add', { ...task, actor });
    assert.equal(res.status, 403, await res.text());
  }
  assert.equal((await (await app.request('/w/v1/hello', { headers: bearer(runner) })).json() as any).runner, 'runner-a');
  assert.equal((await sql`select count(*)::int as n from cb.tasks`)[0].n, 0);
});

test('keys: issued and revoked from the dashboard only, stored hashed, two live ones per machine and kind', async () => {
  const { sql, session } = await board();
  await assert.rejects(session`select cb.key_issue('boxa', 'machine')`, /only Ahmed/);
  const first = await issue(sql), second = await issue(sql);
  await assert.rejects(session`select cb.key_revoke(${idOf(first)})`, /only Ahmed/);
  await assert.rejects(issue(sql), /2 live/);
  await issue(sql, 'boxb');
  await sql`select cb.key_revoke(${idOf(first)})`;
  await issue(sql);
  for (const [machine, kind, runner] of [['Box A', 'machine', null], ['boxa', 'seat', null], ['boxa', 'runner', null], ['boxa', 'machine', 'runner-a']] as const) {
    await assert.rejects(issue(sql, machine, kind, runner), undefined, `${machine} ${kind} ${runner}`);
  }
  const everything = JSON.stringify([await sql`select *, encode(hash, 'escape') as h from cb.worker_keys`, await sql`select * from cb.events`,
    (await sql`select cb.keys_list() as k`)[0].k]);
  for (const key of [first, second]) assert.ok(!everything.includes(key.slice(-43)));
  const [{ k }] = await sql`select cb.keys_list() as k`;
  assert.ok(k.length === 4 && k.every((row: any) => row.id && !('hash' in row)), JSON.stringify(k));
});

test('a body over 1 MB is refused, except where pictures travel', async () => {
  const { sql } = await board();
  const key = await issue(sql);
  const big = 'x'.repeat(1_100_000);
  assert.equal((await call(key, 'task_add', { ...task, body: big })).status, 413);
  assert.equal((await call(key, 'ask_post', { project: 'demo', body: 'synthetic question', context: big, actor: 'W1@boxa' })).status, 200);
});

test('each key has its own rate limit', async () => {
  const { sql } = await board();
  const key = await issue(sql), other = await issue(sql, 'boxb');
  process.env.CB_API_RATE = '3';
  try {
    const replies = [];
    for (let i = 0; i < 5; i++) replies.push(await call(key, 'resume', { actor: 'W1@boxa' }));
    assert.deepEqual(replies.map((r) => r.status), [200, 200, 200, 429, 429]);
    const after = Number(replies[4]!.headers.get('retry-after'));
    assert.ok(after >= 1 && after <= 60, `retry-after ${after}`);
    assert.equal((await call(other, 'resume', { actor: 'W1@boxb' })).status, 200);
  } finally { delete process.env.CB_API_RATE; }
});

// The contract with the client (S3, #4913)
test('a time or bytes in the result or in a row\'s own column is tagged; nothing deeper is', () => {
  const at = new Date('2026-01-02T03:04:05.000Z'), bytes = Buffer.from('synthetic');
  const tagged = [{ $date: '2026-01-02T03:04:05.000Z' }, { $bytes: bytes.toString('base64') }];
  assert.deepEqual([wire(at, false), wire(bytes, false), wire(null, false), wire(7, false)], [...tagged, null, 7]);
  assert.deepEqual(wire([{ id: 1, at, data: bytes, links: { seen: '2026-01-02', list: [1] } }], true),
    [{ id: 1, at: tagged[0], data: tagged[1], links: { seen: '2026-01-02', list: [1] } }]);
});

test('over the API a row\'s time arrives tagged, and a database error keeps its code', async () => {
  const { sql } = await board();
  const key = await issue(sql);
  const id = await result(await call(key, 'task_add', task));
  const [row] = await result(await call(key, 'task_row', { id }));
  assert.equal(new Date(row.created_at.$date).getUTCFullYear() >= 2026, true, JSON.stringify(row.created_at));
  const bad = await call(key, 'task_move', { id: String(id), status: 'nope', actor: 'W1@boxa' });
  const body = await bad.json() as any;
  assert.deepEqual([bad.status, body.ok, body.code, bad.headers.get('x-cb-proto')], [400, false, 'P0001', '1'], JSON.stringify(body));
  assert.ok(body.error && !('never_ran' in body));
  // an argument the function does not have
  assert.equal(((await (await call(key, 'task_add', { ...task, nope: 'x' })).json()) as any).code, '42883');
  for (const raw of ['', 'not json', '[]', '{"args":[]}', '{"args":"x"}', 'null']) {
    const res = await app.request('/w/v1/call/task_add', { method: 'POST', headers: bearer(key), body: raw });
    assert.equal(res.status, 400, raw);
  }
});

test('never_ran is said only when the call cannot have run', () => {
  const lost = Object.assign(new Error('write CONNECTION_CLOSED db:5432'), { code: 'CONNECTION_CLOSED' });
  assert.deepEqual([failure(lost, false).status, failure(lost, false).body.never_ran], [503, true]);
  assert.deepEqual([failure(lost, true).status, 'never_ran' in failure(lost, true).body], [500, false]);
  for (const sent of [false, true]) assert.ok(!JSON.stringify(failure(lost, sent).body).includes('db:5432'), 'no address in the reply');
  const refused = Object.assign(new Error('no such task'), { name: 'PostgresError', code: 'P0001', detail: 'd', hint: 'h', query: 'select secret', parameters: ['secret'] });
  assert.deepEqual(failure(refused, true), { status: 400, body: { ok: false, code: 'P0001', error: 'no such task', detail: 'd', hint: 'h' } });
  // a database that takes no connection answers with a code of its own (too many, starting up): still never sent
  for (const code of ['53300', '57P03', '57P01', '08006']) {
    const full = Object.assign(new Error('sorry'), { name: 'PostgresError', code });
    assert.deepEqual(failure(full, false), { status: 503, body: { ok: false, code, error: 'sorry', never_ran: true } }, code);
    assert.deepEqual([failure(full, true).status, 'never_ran' in failure(full, true).body], [400, false], code);
  }
  assert.equal(failure(refused, false).status, 400, 'any other database error says the same again');
});

test('a database that cannot be reached: 503 never_ran, one log line with the error\'s code and no address', async () => {
  const { sql } = await board();
  const key = await issue(sql);
  const url = process.env.CB_DATABASE_URL!;
  await closeWorker(); // the next call opens a new pool, at a port nothing listens on
  process.env.CB_DATABASE_URL = 'postgres://cb@127.0.0.1:1/claude_board_test_nowhere';
  try {
    let res!: Response;
    const log = await logged(async () => { res = await call(key, 'task_add', task); });
    const body = await res.json() as any;
    assert.deepEqual([res.status, body.never_ran], [503, true], JSON.stringify(body));
    assert.match(log, new RegExp(`^worker api: key ${idOf(key)} task_add 503 \\d+ms ECONNREFUSED$`));
    assert.ok(!JSON.stringify(body).includes('127.0.0.1') && !log.includes('127.0.0.1'), 'no address anywhere');
  } finally {
    await closeWorker();
    process.env.CB_DATABASE_URL = url;
  }
});

test('the board names its release only to a signed-in worker', async () => {
  const { sql } = await board();
  const key = await issue(sql);
  setRelease({ manifest: { sha: 'a'.repeat(40) } } as any);
  try {
    assert.equal((await app.request('/w/v1/hello')).headers.get('x-cb-code'), null);
    assert.equal((await app.request('/w/v1/hello', { headers: bearer(key) })).headers.get('x-cb-code'), 'a'.repeat(40));
  } finally {
    setRelease(null);
  }
});

/** An open event stream, read in the background. */
async function stream(key: string, query: string) {
  const res = await app.request(`/w/v1/events?${query}`, { headers: bearer(key) });
  assert.equal(res.status, 200, res.status === 200 ? '' : await res.text());
  const reader = res.body!.getReader(), decoder = new TextDecoder();
  const s = { text: '', ended: false, close: () => reader.cancel(), async until(what: () => boolean) {
    for (const end = Date.now() + 5000; !what();) {
      assert.ok(Date.now() < end, `the stream never got there: ${JSON.stringify(s.text)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  } };
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
      if (done) break;
      s.text += decoder.decode(value, { stream: true });
    }
    s.ended = true;
  })();
  return s;
}

test('a stream carries its own machine\'s bindings and its kind\'s channels only, pings, and ends with its key', async () => {
  const { sql } = await board();
  const key = await issue(sql), runner = await issue(sql, 'boxa', 'runner', 'runner-a');
  for (const [k, query] of [[key, 'ch=cb_jobs'], [runner, 'ch=cb_bind'], [runner, 'ch=cb'], [key, 'ch=cb&ch=other'], [key, '']] as const) {
    assert.equal((await app.request(`/w/v1/events?${query}`, { headers: bearer(k) })).status, 403, query);
  }
  process.env.CB_API_PING_MS = '100';
  try {
    const seats = await stream(key, 'ch=cb&ch=cb_bind'), jobs = await stream(runner, 'ch=cb_jobs');
    await seats.until(() => seats.text.includes('event: listen'));
    await jobs.until(() => jobs.text.includes('event: listen'));
    await sql`select cb.iam('boxb', 'p2', 'W2@boxb', 'demo')`;
    await sql`select cb.iam('boxa2', 'p3', 'W3@boxa2', 'demo')`;
    await sql`select cb.iam('boxa', 'p1', 'W1@boxa', 'demo')`;
    await sql`select pg_notify('cb_jobs', '7')`;
    await seats.until(() => seats.text.includes('boxa:p1'));
    await jobs.until(() => jobs.text.includes('event: cb_jobs\ndata: 7'));
    assert.match(seats.text, /event: cb_bind\ndata: boxa:p1/);
    assert.ok(!/boxb|boxa2|cb_jobs/.test(seats.text), seats.text);
    assert.ok(!/cb_bind|boxa:p1/.test(jobs.text), jobs.text);
    await seats.until(() => seats.text.includes(': ping'));
    await sql`select cb.key_revoke(${idOf(key)})`;
    await seats.until(() => seats.ended);
    assert.equal(jobs.ended, false);
    await jobs.close();
  } finally { delete process.env.CB_API_PING_MS; }
});

// the first stream starts the server's LISTEN, which takes a moment: opens that arrive meanwhile count too
test('one key holds 64 streams at most, however many it opens at once', async () => {
  const { sql } = await board();
  const [key, other] = [await issue(sql), await issue(sql, 'boxb')];
  const w = workerApp(() => new Promise((r) => setTimeout(r, 300)));
  const open = (k: string) => w.request('/events?ch=cb', { headers: bearer(k) });
  const replies = await Promise.all(Array.from({ length: 70 }, () => open(key)));
  try {
    assert.deepEqual([200, 429].map((s) => replies.filter((r) => r.status === s).length), [64, 6]);
    const theirs = await open(other);
    assert.equal(theirs.status, 200, 'another key is unaffected');
    replies.push(theirs);
  } finally {
    await Promise.all(replies.map((r) => r.body?.cancel()));
  }
});
