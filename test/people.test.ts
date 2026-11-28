import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, onProject } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }

const DASHBOARD = { host: 'localhost:4747', origin: 'http://localhost:4747' };
const SESSION = { host: 'localhost:4747' }; // curl or cb from a session: local, no Origin
// The Users page's own fetch: a browser marks it same-origin; curl and sessions send no Sec-Fetch-Site.
const PAGE = { host: 'localhost:4747', 'sec-fetch-site': 'same-origin' };
const rpc = (fn: string, args: object, headers: Record<string, string> = DASHBOARD) =>
  app.request(`/api/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(args) });
const remote = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  app.request(path, { ...init, headers: { 'x-forwarded-for': '1.2.3.4', host: 'abc.ngrok-free.app',
    ...(init.cookie ? { cookie: `cb_user=${init.cookie}` } : {}), ...(init.headers as any) } });

test('People: only this PC reads the Users page, which holds no link; a guest or a stranger never reads it', async () => {
  const sql = await db();
  const [{ token }] = await sql`select cb.user_add('cai', 'Cai') as token`;
  await onProject(sql, 'cai', 'iris');
  await sql`select cb.ask(project => 'iris', body => 'E1 scope?', blocking => true, to_user => 'cai', actor => 'orch@shaltoot')`;

  const local = await (await app.request('/api/people', { headers: PAGE })).json();
  assert.equal(local.people[0].has_link, true);
  assert.ok(!('token' in local.people[0]) && !JSON.stringify(local).includes(token), 'a link is not shown again (#4868)');
  assert.equal((await app.request('/api/people', { headers: SESSION })).status, 403, 'a session on this PC (no Sec-Fetch-Site)');
  assert.equal((await app.request('/api/people', { headers: { ...SESSION, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(local.people[0].name, 'cai');

  assert.equal((await remote('/api/people')).status, 401);
  assert.equal((await remote('/api/people', { cookie: token })).status, 403);
  const post = (fn: string) => remote(`/api/rpc/${fn}`, { cookie: token, method: 'POST', body: JSON.stringify({ name: 'cai' }), headers: { 'content-type': 'application/json' } });
  for (const fn of ['user_rotate', 'user_remove', 'user_add']) assert.equal((await post(fn)).status, 403, fn);
  for (const p of ['/api/me', '/api/whoami']) assert.doesNotMatch(await (await remote(p, { cookie: token })).text(), new RegExp(token), p);
  assert.deepEqual(await (await app.request('/api/users')).json(), [{ name: 'cai', display: 'Cai', projects: ['iris'] }],
    '/api/users: name, display and projects (for the pickers), never the token');
});

test('People: what waits on each person, and when they last answered or wrote', async () => {
  const sql = await db();
  await sql`select cb.user_add('cai', 'Cai'), cb.user_add('ana', 'Ana')`;
  await onProject(sql, 'cai', 'iris');
  await sql`select cb.ask(project => 'iris', body => 'E1 scope?', blocking => true, task_id => null, to_user => 'cai', actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'iris', body => 'Launch date?', to_user => 'cai', actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'iris', body => 'Answered one', to_user => 'cai', actor => 'orch@shaltoot')`;
  await sql`select cb.answer('3', 'yes', 'cai')`;
  await sql`select cb.task_add(project => 'iris', title => 'PO sign-off', assignee => 'cai')`;
  await sql`select cb.task_add(project => 'iris', title => 'old', assignee => 'cai', status => 'done')`;

  const { people, public_url } = await (await app.request('/api/people', { headers: PAGE })).json();
  assert.equal(typeof public_url === 'string' || public_url === null, true);
  const cai = people.find((p: any) => p.name === 'cai'), ana = people.find((p: any) => p.name === 'ana');
  assert.deepEqual(cai.questions.map((q: any) => [q.body, q.blocking]), [['E1 scope?', true], ['Launch date?', false]]);
  assert.deepEqual(cai.tasks.map((t: any) => t.title), ['PO sign-off']);
  assert.ok(cai.last_active, 'his answer counts as activity');
  assert.deepEqual([ana.questions, ana.tasks, ana.last_active], [[], [], null]);
});

test('People: a new link stops the old one, in a fresh browser and in a signed-in one', async () => {
  const sql = await db();
  const [{ token: old }] = await sql`select cb.user_add('cai', 'Cai') as token`;
  assert.equal((await remote(`/?u=${old}`)).status, 302);

  const res = await rpc('user_rotate', { name: 'cai' });
  assert.equal(res.status, 200);
  const fresh = (await res.json()).result;
  assert.ok(fresh && fresh !== old);

  assert.equal((await remote(`/?u=${old}`)).status, 401, 'the old link');
  assert.equal((await remote('/api/me', { cookie: old })).status, 401, 'a browser signed in with the old link');
  assert.equal((await remote(`/?u=${fresh}`)).status, 302);
  assert.equal((await remote('/api/me', { cookie: fresh })).status, 200);

  assert.equal((await rpc('user_rotate', { name: 'nobody' })).status, 400);
});

test('People: removing a person hands their open questions back to Ahmed and unassigns their open tasks', async () => {
  const sql = await db();
  const [{ token }] = await sql`select cb.user_add('cai', 'Cai') as token`;
  await onProject(sql, 'cai', 'iris');
  await sql`select cb.task_add(project => 'iris', title => 'PO sign-off', assignee => 'cai', status => 'review')`;
  await sql`select cb.task_add(project => 'iris', title => 'old', assignee => 'cai', status => 'done')`;
  await sql`select cb.task_add(project => 'iris', title => 'Draft copy', assignee => 'cai', status => 'in_progress')`;
  await sql`select cb.ask(project => 'iris', body => 'open one', blocking => true, task_id => '1', to_user => 'cai', actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'iris', body => 'answered one', to_user => 'cai', actor => 'orch@shaltoot')`;
  await sql`select cb.answer('2', 'yes', 'cai')`;

  const res = await rpc('user_remove', { name: 'cai', actor: 'ahmed' }); // as the dashboard's rpc() sends it
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).result, { questions: 1, tasks: 2 });

  const qs = await sql`select body, status, assigned_to, answered_by from cb.questions order by id`;
  assert.deepEqual(qs.map((q) => ({ ...q })), [
    { body: 'open one', status: 'open', assigned_to: null, answered_by: null },
    { body: 'answered one', status: 'answered', assigned_to: null, answered_by: 'cai' }]);
  const ts = await sql`select title, status, assignee from cb.tasks order by id`;
  assert.deepEqual(ts.map((t) => ({ ...t })), [
    { title: 'PO sign-off', status: 'blocked', assignee: null }, // still held on Q1, which now waits on Ahmed
    { title: 'old', status: 'done', assignee: 'cai' },
    { title: 'Draft copy', status: 'next', assignee: null }]); // nobody is working it any more: back in the queue
  const evs = await sql`select task_id::int, kind, actor, summary from cb.events where task_id in (1, 3) and kind in ('updated', 'moved') and actor = 'ahmed' order by id`;
  assert.deepEqual(evs.map((e) => ({ ...e })), [
    { task_id: 3, kind: 'moved', actor: 'ahmed', summary: 'unassigned and back to Next: Cai was removed' },
    { task_id: 1, kind: 'updated', actor: 'ahmed', summary: 'unassigned: Cai was removed' }]);

  assert.equal((await sql`select 1 from cb.users`).length, 0);
  assert.equal((await remote(`/?u=${token}`)).status, 401);
  assert.equal((await remote('/api/me', { cookie: token })).status, 401);
  assert.equal((await rpc('user_remove', { name: 'cai' })).status, 400, 'already gone');
});

test('People: only the dashboard rotates or removes; a session cannot, with or without a name', async () => {
  const sql = await db();
  const [{ token }] = await sql`select cb.user_add('cai', 'Cai') as token`;
  await onProject(sql, 'cai', 'iris');
  for (const fn of ['user_rotate', 'user_remove']) {
    for (const args of [{ name: 'cai' }, { name: 'cai', actor: 'W1@pc' }, { name: 'cai', actor: 'ahmed' }]) {
      const r = await rpc(fn, args, SESSION);
      assert.equal(r.status, 400, `${fn} ${JSON.stringify(args)}`);
      assert.match((await r.json()).error, /only Ahmed (can|'s dashboard can)/);
    }
  }
  assert.equal((await remote('/api/me', { cookie: token })).status, 200, 'nothing changed');
});

test('People: user_add hands the token only to the dashboard', async () => {
  await db();
  const fromSession = await rpc('user_add', { name: 'cai', display: 'Cai', actor: 'W1@pc' }, SESSION);
  assert.equal(fromSession.status, 200);
  assert.equal((await fromSession.json()).result, null, 'a session adds people but never sees a link');
  const fromPage = await (await rpc('user_add', { name: 'ana', display: 'Ana', actor: 'ahmed' })).json();
  assert.match(fromPage.result, /^[0-9a-f-]{36}$/);
});

test('People: add, new link and remove each leave one audit line, never the token', async () => {
  const sql = await db();
  const add = (await (await rpc('user_add', { name: 'cai', display: 'Cai', actor: 'ahmed' })).json()).result;
  await rpc('user_add', { name: 'cai', display: 'Cai', actor: 'ahmed' }); // the same again: nothing changed, nothing logged
  await onProject(sql, 'cai', 'iris');
  await sql`select cb.ask(project => 'iris', body => 'q', to_user => 'cai', actor => 'orch@shaltoot')`;
  const fresh = (await (await rpc('user_rotate', { name: 'cai', actor: 'ahmed' })).json()).result;
  await rpc('user_remove', { name: 'cai', actor: 'ahmed' });
  const evs = await sql`select actor, summary, data from cb.events where kind = 'user' order by id`;
  assert.deepEqual(evs.map((e) => [e.actor, e.summary, e.data]), [
    ['ahmed', 'added Cai (cai)', { user: 'cai', action: 'add' }],
    ['ahmed', 'Cai (cai) is now on iris', { user: 'cai', action: 'project_add', project: 'iris' }],
    ['ahmed', 'new link for Cai (cai): the old one no longer works', { user: 'cai', action: 'rotate' }],
    ['ahmed', 'removed Cai (cai): 1 open question back to Ahmed, 0 open tasks unassigned', { user: 'cai', action: 'remove', questions: 1, tasks: 0 }],
  ]);
  const all = JSON.stringify(await sql`select * from cb.events`);
  for (const t of [add, fresh]) assert.ok(!all.includes(t), 'no token in any event');
});
