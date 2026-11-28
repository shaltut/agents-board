// #3222 S2: the worker API (/w/v1). A worker signs in with its machine's key; the board decides what that key may call
// and as whom. Every key here is made by the test database and thrown away with it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, onProject, TEST_URL } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');
const { closeWorker } = await import('../server/worker.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), closeWorker(), serverSql.end()]));

/** A wiped board: the dashboard's connection (it issues and revokes keys) and a session's (psql with no special name). */
async function board() {
  const sql = await freshDb();
  const session = postgres(TEST_URL, { onnotice: () => {}, max: 1, connection: { application_name: 'cb' } });
  clients.push(sql, session);
  await onProject(sql, 'cai', 'demo');
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
    'github_watch_add', 'github_watch_remove', 'role_text_set', 'constructor', '__proto__']) {
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
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call(key, 'resume', { actor: 'W1@boxa' })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal((await call(other, 'resume', { actor: 'W1@boxb' })).status, 200);
  } finally { delete process.env.CB_API_RATE; }
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
