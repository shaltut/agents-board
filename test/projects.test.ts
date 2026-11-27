import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app, loginFails } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }

const DASHBOARD = { host: 'localhost:4747', origin: 'http://localhost:4747' };
const SESSION = { host: 'localhost:4747' };
const rpc = (fn: string, args: object, headers: Record<string, string> = DASHBOARD) =>
  app.request(`/api/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(args) });
const remote = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  app.request(path, { ...init, headers: { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '1.2.3.4', host: 'board.example.app',
    ...(init.cookie ? { cookie: `cb_user=${init.cookie}` } : {}), ...(init.headers as any) } });
const post = (path: string, body: object, cookie?: string) =>
  remote(path, { method: 'POST', cookie, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

/** cai on iris; projects iris and zed exist. */
async function setup() {
  const sql = await db();
  await sql`select cb.task_add(project => 'iris', title => 'seed iris'), cb.task_add(project => 'zed', title => 'seed zed')`;
  const [{ token }] = await sql`select cb.user_add('cai', 'Cai') as token`;
  await sql`select cb.user_project_add('cai', 'iris', 'ahmed')`;
  return { sql, token };
}

/** Rows from before #315: assigned to a person on a project they aren't on (the check would refuse them now). */
async function legacy(sql: any, f: () => Promise<unknown>) {
  await sql`alter table cb.tasks disable trigger tasks_assignee_project`;
  await sql`alter table cb.questions disable trigger questions_assignee_project`;
  try { await f() } finally {
    await sql`alter table cb.tasks enable trigger tasks_assignee_project`;
    await sql`alter table cb.questions enable trigger questions_assignee_project`;
  }
}

test('projects: a question or task goes only to a person on its project', async () => {
  const { sql } = await setup();
  const refused = /cai is not on project zed/;
  await assert.rejects(sql`select cb.ask(project => 'zed', body => 'x', to_user => 'cai', actor => 'orch@pc')`, refused);
  await sql`select cb.ask(project => 'iris', body => 'fine', to_user => 'cai', actor => 'orch@pc')`;
  const [{ q }] = await sql`select cb.ask(project => 'zed', body => 'for Ahmed', actor => 'orch@pc') as q`;
  await assert.rejects(sql`select cb.question_assign(${String(q)}, 'cai', 'orch@pc')`, refused);
  await assert.rejects(sql`select cb.task_add(project => 'zed', title => 'x', assignee => 'cai')`, refused);
  await sql`select cb.task_add(project => 'iris', title => 'fine', assignee => 'cai')`;
  await assert.rejects(sql`select cb.task_update('2', ${sql.json({ assignee: 'cai' })}::jsonb, 'orch@pc')`, refused, 'task #2 is on zed');
  await sql`select cb.task_add(project => 'zed', title => 'sessions are not people', assignee => 'W1@pc')`;

  // the live board's cai and ana start with no projects: their old items still move, nothing new reaches them
  await sql`select cb.user_add('ana', 'Ana')`;
  await legacy(sql, () => sql`select cb.task_add(project => 'zed', title => 'old', assignee => 'ana')`);
  const [{ id }] = await sql`select id::text from cb.tasks where title = 'old'`;
  await sql`select cb.task_move(${id}, 'done', null, 'orch@pc')`;
  await assert.rejects(sql`select cb.task_add(project => 'iris', title => 'x', assignee => 'ana')`, /ana is not on project iris/);
});

test('projects: taking a person off a project hands their open work there back', async () => {
  const { sql } = await setup();
  await sql`select cb.ask(project => 'iris', body => 'q', to_user => 'cai', actor => 'orch@pc')`;
  await sql`select cb.task_add(project => 'iris', title => 'doing', assignee => 'cai', status => 'in_progress')`;
  const res = await rpc('user_project_remove', { name: 'cai', project: 'iris', actor: 'ahmed' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).result, { questions: 1, tasks: 1 });
  const [t] = await sql`select assignee, status from cb.tasks where title = 'doing'`;
  assert.deepEqual({ ...t }, { assignee: null, status: 'next' });
  assert.equal((await sql`select 1 from cb.user_projects`).length, 0);
  const people = await (await app.request('/api/people', { headers: { ...SESSION, 'sec-fetch-site': 'same-origin' } })).json();
  assert.deepEqual(people.people[0].projects, []);
});

test('projects: a guest sees and answers only what is assigned to them on their projects', async () => {
  const { sql, token } = await setup();
  await sql`select cb.ask(project => 'iris', body => 'mine', to_user => 'cai', actor => 'orch@pc')`;
  await sql`select cb.task_add(project => 'iris', title => 'my task', assignee => 'cai')`;
  await legacy(sql, async () => {
    await sql`select cb.ask(project => 'zed', body => 'not my project', to_user => 'cai', actor => 'orch@pc')`;
    await sql`select cb.task_add(project => 'zed', title => 'not my project either', assignee => 'cai')`;
  });
  const me = await (await remote('/api/me', { cookie: token })).json();
  assert.deepEqual(me.questions.map((q: any) => q.body), ['mine']);
  assert.deepEqual(me.tasks.map((t: any) => t.title), ['my task']);
  const [{ q }] = await sql`select id::text as q from cb.questions where body = 'not my project'`;
  const [{ t }] = await sql`select id::text as t from cb.tasks where title = 'not my project either'`;
  assert.equal((await post('/api/rpc/answer', { id: q, answer: 'x' }, token)).status, 403);
  assert.equal((await post('/api/rpc/log', { task_id: t, summary: 'x' }, token)).status, 403);
  const [{ mq }] = await sql`select id::text as mq from cb.questions where body = 'mine'`;
  assert.equal((await post('/api/rpc/answer', { id: mq, answer: 'yes' }, token)).status, 200);
});

test('login: name and password set the same cookie as the link; a wrong one waits and says nothing more', async () => {
  const { sql, token } = await setup();
  await sql`select cb.user_add('ana', 'Ana')`; // no password
  await sql`select cb.user_password('cai', 'correct horse', 'ahmed')`;
  const [{ password }] = await sql`select password from cb.users where name = 'cai'`;
  assert.match(password, /^\$2[abxy]\$10\$/, 'bcrypt at cost 10, never the plain text');
  await assert.rejects(sql`select cb.user_password('cai', 'short', 'ahmed')`, /at least 8/);

  const ok = await post('/api/login', { name: ' Cai ', password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie') ?? '', new RegExp(`cb_user=${token};.*HttpOnly`, 'i'));
  assert.deepEqual(await (await remote('/api/whoami', { cookie: token })).json(), { role: 'guest', user: { name: 'cai', display: 'Cai' } });

  for (const [name, pw] of [['cai', 'wrong horse'], ['nobody', 'correct horse'], ['ana', ''], ['ana', 'anything at all']]) {
    const t0 = Date.now();
    const bad = await post('/api/login', { name, password: pw });
    assert.equal(bad.status, 401, `${name}/${pw}`);
    assert.deepEqual(await bad.json(), { ok: false, error: "That name and password don't match." });
    assert.equal(bad.headers.get('set-cookie'), null);
    assert.ok(Date.now() - t0 >= 900, 'a failure waits about a second');
  }
  assert.equal((await post('/api/login', {})).status, 401, 'garbage is a failure, not a crash');

  const out = await post('/api/logout', {}, token);
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') ?? '', /cb_user=;.*Max-Age=0/i);
  assert.equal((await remote(`/?u=${token}`)).status, 302, 'the link still signs in with one click');
});

test('a session cannot set passwords or projects', async () => {
  const { sql } = await setup();
  for (const [fn, args] of [['user_password', { name: 'cai', password: 'correct horse' }], ['user_project_add', { name: 'cai', project: 'zed' }],
    ['user_project_remove', { name: 'cai', project: 'iris' }]] as const) {
    const r = await rpc(fn, args, SESSION);
    assert.equal(r.status, 400, fn);
    assert.match((await r.json()).error, /only Ahmed can do this/);
  }
  const [u] = await sql`select password is null as none, (select count(*)::int from cb.user_projects) as n from cb.users`;
  assert.deepEqual({ ...u }, { none: true, n: 1 });
  const page = await (await app.request('/api/people', { headers: { ...SESSION, 'sec-fetch-site': 'same-origin' } })).text();
  assert.doesNotMatch(page, /\$2[abxy]\$/, 'the hash never leaves the database');
});

test('projects: an alias merge or a slug rename keeps a guest on their work', async () => {
  const { sql, token } = await setup();
  await sql`select cb.task_add(project => 'acme', title => 'seed acme')`;
  await sql`select cb.user_project_add('cai', 'acme', 'ahmed')`;
  await sql`select cb.ask(project => 'acme', body => 'merged one', to_user => 'cai', actor => 'orch@pc')`;
  await sql`select cb.project_alias('acme', 'zed')`; // cai was not on zed
  const me = await (await remote('/api/me', { cookie: token })).json();
  assert.deepEqual(me.questions.map((q: any) => q.body), ['merged one']);
  const [{ q }] = await sql`select id::text as q from cb.questions where body = 'merged one'`;
  assert.equal((await post('/api/rpc/answer', { id: q, answer: 'yes' }, token)).status, 200);
  assert.deepEqual((await sql`select project from cb.user_projects order by 1`).map((r: any) => r.project), ['iris', 'zed']);

  await sql`select cb.ask(project => 'iris', body => 'renamed one', to_user => 'cai', actor => 'orch@pc')`;
  await sql`update cb.projects set slug = 'iris2' where slug = 'iris'`;
  const me2 = await (await remote('/api/me', { cookie: token })).json();
  assert.ok(me2.questions.some((q: any) => q.body === 'renamed one'), 'still on the guest page after iris became iris2');
  assert.deepEqual((await sql`select project from cb.user_projects order by 1`).map((r: any) => r.project), ['iris2', 'zed']);
});

test('projects: an alias merge moves the asks and bound sessions, not nulls them', async () => {
  const { sql } = await setup();
  await sql`select cb.task_add(project => 'acme', title => 'seed acme')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('pc', 'p9', 'B9@pc', 'acme', 'builder')`;
  await sql`insert into cb.asks (project, to_actor, body) values ('acme', 'B9@pc', 'merged ask')`;
  await sql`select cb.project_alias('acme', 'zed')`;
  assert.equal((await sql`select project from cb.asks where body = 'merged ask'`)[0].project, 'zed');
  assert.equal((await sql`select project from cb.sessions where actor = 'B9@pc'`)[0].project, 'zed');
});

test('projects: an alias merge moves the memories (their foreign key would refuse the delete)', async () => {
  const { sql } = await setup();
  await sql`select cb.task_add(project => 'acme', title => 'seed acme')`;
  await sql`insert into cb.memories (project, kind, title, created_by) values ('acme', 'fact', 'merged memory', 'B9@pc')`;
  await sql`select cb.project_alias('acme', 'zed')`;
  assert.equal((await sql`select project from cb.memories where title = 'merged memory'`)[0].project, 'zed');
});

test('login: five wrong tries lock the name for two minutes; a success resets the count', async () => {
  const { sql } = await setup();
  loginFails.clear();
  await sql`select cb.user_add('ana', 'Ana')`;
  await sql`select cb.user_password('cai', 'correct horse', 'ahmed'), cb.user_password('ana', 'battery staple', 'ahmed')`;
  const msg = { ok: false, error: "That name and password don't match." };

  const five = await Promise.all(Array.from({ length: 5 }, () => post('/api/login', { name: 'cai', password: 'wrong' })));
  assert.deepEqual(five.map((r) => r.status), [401, 401, 401, 401, 401], 'in parallel too');
  const locked = await post('/api/login', { name: 'cai', password: 'correct horse' });
  assert.equal(locked.status, 429, 'the right password waits out the lock');
  assert.deepEqual(await locked.json(), msg);
  assert.equal(locked.headers.get('set-cookie'), null);
  loginFails.get('cai|1.2.3.4')!.until = Date.now() - 1; // two minutes later (counts are per name and address)
  assert.equal((await post('/api/login', { name: 'cai', password: 'correct horse' })).status, 200);

  for (let round = 0; round < 2; round++) {
    const four = await Promise.all(Array.from({ length: 4 }, () => post('/api/login', { name: 'ana', password: 'wrong' })));
    assert.deepEqual(four.map((r) => r.status), [401, 401, 401, 401]);
    assert.equal((await post('/api/login', { name: 'ana', password: 'battery staple' })).status, 200, `round ${round}`);
  }

  // at most 20 failures wait at once; past that the answer comes at once
  const flood = await Promise.all(Array.from({ length: 25 }, (_, i) => post('/api/login', { name: `nobody${i}`, password: 'x' })));
  const n = (s: number) => flood.filter((r) => r.status === s).length;
  assert.deepEqual([n(401), n(429)], [20, 5]);
  loginFails.clear();
});

test('the sign-in cookie is Secure when the tunnel says https', async () => {
  const { sql, token } = await setup();
  await sql`select cb.user_password('cai', 'correct horse', 'ahmed')`;
  const https = { 'content-type': 'application/json', 'x-forwarded-proto': 'https' };
  const login = await remote('/api/login', { method: 'POST', body: JSON.stringify({ name: 'cai', password: 'correct horse' }), headers: https });
  assert.match(login.headers.get('set-cookie') ?? '', /;\s*Secure/i);
  assert.match((await remote(`/?u=${token}`, { headers: https })).headers.get('set-cookie') ?? '', /;\s*Secure/i);
  assert.doesNotMatch((await remote(`/?u=${token}`)).headers.get('set-cookie') ?? '', /Secure/i, 'plain http (local dev) stays usable');
});

test('#4531: the board project shows as Agents Board, its slug stays claude-board; a name set by hand is kept', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('claude-board'), cb.ensure_project('zed-two')`;
  const name = async (slug: string) => (await sql`select name from cb.projects where slug = ${slug}`)[0]!.name;
  assert.equal(await name('claude-board'), 'Agents Board', 'a new board names its own project Agents Board');
  assert.equal(await name('zed-two'), 'Zed Two', 'any other project keeps the name from its slug');
  // the statement db/setup.ts re-applies on every deploy (db/schema.sql), run as it is there
  const step = /^update cb\.projects set name = 'Agents Board' where .*;$/m.exec(readFileSync('db/schema.sql', 'utf8'))?.[0];
  assert.ok(step, 'db/schema.sql renames the board project');
  await sql`update cb.projects set name = 'Claude Board' where slug = 'claude-board'`; // a board from before the rename
  for (let i = 0; i < 2; i++) await sql.unsafe(step);
  assert.equal(await name('claude-board'), 'Agents Board');
  await sql`update cb.projects set name = 'Our board' where slug = 'claude-board'`;
  assert.equal((await sql.unsafe(step)).count, 0, 'a name set by hand is kept');
  assert.equal(await name('claude-board'), 'Our board');
});
