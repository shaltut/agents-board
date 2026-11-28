// #4915, #3222 S7: cut-over step 6. Ruling D5 ends every sign-in; ruling Q3244 expires every password, and whoever
// signs in with an expired one reaches nothing but the change to a new one. Every value here is made up by the test.
// Needs the sign-in tables of #4868.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app, loginFails } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
afterEach(() => loginFails.clear());
async function db() { const s = await freshDb(); clients.push(s); return s; }
/** a connection without cb-web, as psql inside the database container is */
function psql() { const s = postgres(TEST_URL, { onnotice: () => {} }); clients.push(s); return s; }

const SITE = 'board.example.com';
const web = (path: string, o: { cookie?: string; method?: string; body?: object } = {}) =>
  app.request(path, { method: o.method ?? (o.body ? 'POST' : 'GET'), headers: {
    host: SITE, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', origin: `https://${SITE}`, 'sec-fetch-site': 'same-origin',
    ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: `cb_user=${o.cookie}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined });
const who = async (cookie: string) => (await web('/api/whoami', { cookie })).json() as Promise<any>;
const cookieOf = (r: Response) => /cb_user=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
async function login(name: string, password = `${name}-pass-1`) {
  const r = await web('/api/login', { body: { name, password } });
  assert.equal(r.status, 200, `sign in as ${name}`);
  return cookieOf(r)!;
}
const change = (cookie: string, current: string, password: string) => web('/api/password', { cookie, body: { current, password } });

/** an admin who is the owner, a second admin, a member with a password and a member with a link only */
async function board() {
  const sql = await db();
  await sql`select cb.user_add('ahmed', 'Ahmed', role => 'admin')`;
  await sql`select cb.user_password('ahmed', 'ahmed-pass-1')`;
  await sql`select cb.user_add('bo', 'Bo', role => 'admin')`;
  await sql`select cb.user_password('bo', 'bo-pass-1')`;
  const [{ v: cai }] = await sql`select cb.user_add('cai', 'Cai') as v`;
  await sql`select cb.user_password('cai', 'cai-pass-1')`;
  const [{ v: ana }] = await sql`select cb.user_add('ana', 'Ana') as v`;
  return { sql, links: { cai: cai as string, ana: ana as string } };
}
const cutover = async () => (await psql()`select cb._cutover_end_sign_ins() as r`)[0].r;
const state = async (sql: any) => ({
  signIns: (await sql`select count(*)::int as n from cb.sign_ins`)[0].n,
  expired: (await sql`select name from cb.users where password_expired order by name`).map((r: any) => r.name),
});

test('the cut-over step refuses while an admin has no password, and changes nothing', async () => {
  const { sql } = await board();
  await sql`select cb.user_add('dee', 'Dee', role => 'admin')`;
  const was = await state(sql);
  await assert.rejects(cutover(), /no password.*dee/s);
  assert.deepEqual(await state(sql), was);
});

test('it ends every sign-in, links included, clears plain values, expires every password and says how many', async () => {
  const { sql, links } = await board();
  const browsers = [await login('ahmed'), await login('cai')];
  await sql`alter table cb.users add column if not exists token text`;
  await sql`update cb.users set token = 'a-plain-value' where name = 'ana'`;
  assert.deepEqual(await cutover(), { browsers: 2, links: 2, passwords: 3 });
  assert.deepEqual(await state(sql), { signIns: 0, expired: ['ahmed', 'bo', 'cai'] });
  assert.equal((await sql`select count(token)::int as n from cb.users`)[0].n, 0);
  for (const b of browsers) assert.equal((await who(b)).role, 'anonymous');
  for (const l of Object.values(links)) assert.equal((await web(`/?u=${l}`)).status, 401);
  const [event] = await sql`select summary, data from cb.events where kind = 'user' order by id desc limit 1`;
  assert.match(event.summary, /cut-over/);
  assert.equal(event.data.action, 'cutover_sign_ins');
});

test('an expired password signs in to nothing but its own change', async () => {
  await board();
  await cutover();
  const admin = await login('ahmed'), member = await login('cai');
  assert.deepEqual([(await who(admin)).role, (await who(admin)).user.name], ['expired', 'ahmed']);
  assert.equal((await who(member)).role, 'expired');
  const tries: [string, string, object?][] = [[admin, '/api/tasks'], [admin, '/api/projects'], [admin, '/api/stream'],
    [admin, '/api/rpc/user_add', { name: 'eve', display: 'Eve', role: 'admin' }], [member, '/api/me'], [member, '/api/rpc/log', { task_id: 1, summary: 'x' }]];
  for (const [cookie, path, body] of tries) {
    const r = await web(path, { cookie, body });
    assert.equal(r.status, 403, path);
    assert.match(((await r.json()) as any).error, /new password/, path);
  }
  // the function every signed-in request asks answers nobody: a path added later is shut without knowing of this
  assert.equal((await psql()`select count(*)::int as n from cb.sign_in_user(${admin})`)[0].n, 0);
  assert.equal((await web('/api/logout', { cookie: member, method: 'POST' })).status, 200);
});

test('the change takes the current one, refuses the expired one again, and ends every other sign-in', async () => {
  const { sql } = await board();
  await cutover();
  for (const [name, role] of [['ahmed', 'admin'], ['cai', 'guest']]) {
    const mine = await login(name), other = await login(name);
    assert.equal((await change(mine, 'not-it-at-all', `${name}-pass-2`)).status, 400);
    const same = await change(mine, `${name}-pass-1`, `${name}-pass-1`);
    assert.equal(same.status, 400);
    assert.match(((await same.json()) as any).error, /expired password.*new one/s);
    assert.equal((await who(mine)).role, 'expired', 'still shut');
    const done = await change(mine, `${name}-pass-1`, `${name}-pass-2`);
    assert.equal(done.status, 200);
    const fresh = cookieOf(done)!;
    assert.equal((await who(fresh)).role, role);
    assert.equal((await web(role === 'admin' ? '/api/tasks' : '/api/me', { cookie: fresh })).status, 200);
    for (const old of [mine, other]) assert.equal((await who(old)).role, 'anonymous', 'a sign-in made with the old password is gone');
    assert.equal((await web('/api/login', { body: { name, password: `${name}-pass-1` } })).status, 401);
  }
  assert.deepEqual((await state(sql)).expired, ['bo']);
});

test('a new link for a member whose password is expired opens only the change; a member without a password is not held', async () => {
  const { sql } = await board();
  await cutover();
  const [{ v: cai }] = await sql`select cb.user_rotate('cai') as v`;
  assert.equal((await web(`/?u=${cai}`)).status, 302);
  assert.equal((await who(cai)).role, 'expired');
  assert.equal((await web('/api/me', { cookie: cai })).status, 403);
  const [{ v: ana }] = await sql`select cb.user_rotate('ana') as v`;
  assert.equal((await who(ana)).role, 'guest');
});

test('a password set for someone else must differ too, and ends the expiry; the web cannot run the cut-over', async () => {
  const { sql } = await board();
  await cutover();
  await assert.rejects(sql`select cb.user_password('bo', 'bo-pass-1')`, /expired password/);
  await sql`select cb.user_password('bo', 'bo-pass-9')`;
  assert.equal((await who(await login('bo', 'bo-pass-9'))).role, 'admin');
  const mine = await login('ahmed');
  const fresh = cookieOf(await change(mine, 'ahmed-pass-1', 'ahmed-pass-2'))!;
  const r = await web('/api/rpc/_cutover_end_sign_ins', { cookie: fresh, body: {} });
  assert.ok(r.status >= 400, String(r.status));
  assert.equal((await who(fresh)).role, 'admin', 'nothing was ended');
});
