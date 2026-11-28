// #4868: a sign-in (a member's link, or a signed-in browser's cookie) is stored as a hash only, so reading the database
// gives nothing that signs anyone in. Every value here is made up by the test.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app, loginFails } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
afterEach(() => loginFails.clear());
async function db() { const s = await freshDb(); clients.push(s); return s; }
/** a connection that is a session (no cb-web) */
function session() { const s = postgres(TEST_URL, { onnotice: () => {} }); clients.push(s); return s; }

const SITE = 'board.example.com';
const web = (path: string, o: { cookie?: string; method?: string; body?: object } = {}) =>
  app.request(path, { method: o.method ?? (o.body ? 'POST' : 'GET'), headers: {
    host: SITE, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', origin: `https://${SITE}`, 'sec-fetch-site': 'same-origin',
    ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: `cb_user=${o.cookie}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined });
const roleOf = async (cookie: string) => (await (await web('/api/whoami', { cookie })).json()).role;
const linkStatus = async (value: string) => (await web(`/?u=${value}`)).status;
async function login(name: string, password = `${name}-pass-1`) {
  const r = await web('/api/login', { body: { name, password } });
  assert.equal(r.status, 200, `sign in as ${name}`);
  return /cb_user=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1];
}
async function owner(sql: any) {
  await sql`select cb.user_add('ahmed', 'Ahmed', role => 'admin')`;
  await sql`select cb.user_password('ahmed', 'ahmed-pass-1')`;
}
/** a member as the dashboard adds one: what comes back is their link's value */
async function member(sql: any, name: string): Promise<string> {
  const [{ v }] = await sql`select cb.user_add(${name}, ${name}) as v`;
  await sql`select cb.user_password(${name}, ${`${name}-pass-1`})`;
  return v;
}

const setup = () => execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe', timeout: 300_000 });
/** the board as it was before #4868: one plain value per user in cb.users.token, and no sign-in rows */
async function boardFromBefore(sql: any) {
  await owner(sql);
  await member(sql, 'cai');
  await member(sql, 'ana');
  const old = { ahmed: randomUUID(), cai: randomUUID(), ana: randomUUID() };
  await sql`alter table cb.users add column if not exists token text`;
  await sql`delete from cb.sign_ins`;
  for (const [name, value] of Object.entries(old)) await sql`update cb.users set token = ${value} where name = ${name}`;
  return old;
}
const rows = async (sql: any) => (await sql`select user_name, kind, encode(hash, 'hex') as hash, created_at::text as at
  from cb.sign_ins order by user_name, kind, hash`).map((r: any) => ({ ...r }));

test('a board from before keeps its links and signed-in browsers, empties the plain column, and setup can run again', { timeout: 400_000 }, async () => {
  const sql = await db();
  const old = await boardFromBefore(sql);
  setup();
  assert.equal((await sql`select count(*)::int as n from cb.users where token is not null`)[0].n, 0, 'no plain value is left');
  assert.equal(await linkStatus(old.cai), 302, "a member's link still signs in");
  assert.equal(await roleOf(old.cai), 'guest', 'and so does a browser that used it');
  assert.equal(await roleOf(old.ahmed), 'admin', 'a signed-in admin browser stays signed in');
  assert.equal(await linkStatus(old.ahmed), 401, 'an admin has no link');
  const before = await rows(sql);
  assert.deepEqual(before.map((r: any) => [r.user_name, r.kind]), [['ahmed', 'session'], ['ana', 'link'], ['cai', 'link']]);
  setup();
  assert.deepEqual(await rows(sql), before, 'a second run changes nothing');
});

test('rolled back and forward again: a link replaced in between stays dead', { timeout: 400_000 }, async () => {
  const sql = await db();
  const old = await boardFromBefore(sql);
  setup();
  const replaced = randomUUID(); // what New link did on the older code: a fresh plain value
  await sql`update cb.users set token = ${replaced} where name = 'cai'`;
  setup();
  assert.equal(await linkStatus(old.cai), 401, 'the replaced link does not come back');
  assert.equal(await roleOf(old.cai), 'anonymous');
  assert.equal(await linkStatus(replaced), 302);
  assert.equal(await linkStatus(old.ana), 302, 'a user the older code did not touch keeps theirs');
});

test('nothing the database holds signs anyone in', async () => {
  const sql = await db();
  await owner(sql);
  const link = await member(sql, 'cai');
  const secrets = [link, await login('cai'), await login('ahmed')];
  const held = JSON.stringify([await sql`select * from cb.users`, await rows(sql), await sql`select * from cb.events`]);
  for (const s of secrets) assert.ok(!held.includes(s), 'no usable value is stored');
  const hashes = (await rows(sql)).map((r: any) => r.hash);
  assert.equal(hashes.length, 3);
  for (const h of hashes) {
    assert.equal(await roleOf(h), 'anonymous');
    assert.equal(await linkStatus(h), 401);
  }
});

test('each sign-in has its own value; a browser session is not a link; signing out ends that browser only', async () => {
  const sql = await db();
  await owner(sql);
  const link = await member(sql, 'cai');
  const first = await login('cai'), second = await login('cai');
  assert.equal(new Set([link, first, second]).size, 3);
  assert.deepEqual([await roleOf(first), await roleOf(second), await roleOf(link)], ['guest', 'guest', 'guest']);
  assert.equal(await linkStatus(first), 401, 'a password sign-in is no link to pass on');
  assert.equal((await web('/api/logout', { method: 'POST', cookie: first })).status, 200);
  assert.deepEqual([await roleOf(first), await roleOf(second)], ['anonymous', 'guest']);
  assert.equal((await web('/api/logout', { method: 'POST', cookie: link })).status, 200);
  assert.equal(await linkStatus(link), 302, 'signing out never ends the link itself');
});

test('a browser session ends after 90 days, as its cookie does; a link does not; old sessions are cleared', async () => {
  const sql = await db();
  await owner(sql);
  const link = await member(sql, 'cai');
  const old = await login('cai'), admin = await login('ahmed');
  await sql`update cb.sign_ins set created_at = now() - interval '91 days'`;
  assert.deepEqual([await roleOf(old), await roleOf(admin), await roleOf(link)], ['anonymous', 'anonymous', 'guest']);
  await login('cai');
  assert.deepEqual((await rows(sql)).filter((r: any) => r.user_name === 'cai').map((r: any) => r.kind), ['link', 'session']);
});

test('a link comes back once, when it is made; the Users page only says whether there is one', async () => {
  const sql = await db();
  await owner(sql);
  const link = await member(sql, 'cai');
  assert.match(link, /^[0-9a-f-]{36}$/);
  assert.equal((await sql`select cb.user_add('cai', 'Cai') as v`)[0].v, null, 'adding again returns nothing');
  assert.equal(await linkStatus(link), 302, 'and keeps the link');
  const s = session();
  assert.equal((await s`select cb.user_add('ana', 'Ana') as v`)[0].v, null, 'a session adds people but gets no link');
  const admin = await login('ahmed');
  const people = async () => (await (await web('/api/people', { cookie: admin })).json()).people;
  const listed = await people();
  assert.deepEqual(listed.map((p: any) => [p.name, p.has_link]), [['ahmed', false], ['cai', true], ['ana', false]]);
  assert.ok(listed.every((p: any) => !('token' in p)) && !JSON.stringify(listed).includes(link));
  const made = (await (await web('/api/rpc/user_rotate', { cookie: admin, body: { name: 'ana' } })).json()).result;
  assert.equal(await linkStatus(made), 302);
  assert.deepEqual((await people()).map((p: any) => p.has_link), [false, true, true]);
});

/** Waits until the request in flight is stopped by a lock of this database, or has already answered. */
async function heldUpOrAnswered(sql: any, answer: Promise<unknown>) {
  let answered = false;
  void answer.then(() => { answered = true; }, () => { answered = true; });
  for (const end = Date.now() + 20_000; !answered && Date.now() < end;) {
    const [{ n }] = await sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
    if (n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
/** Ahmed's password change, held open (not yet committed) while `during` sends a request, then committed. */
async function whileAPasswordChangeIsOpen(sql: any, during: () => Response | Promise<Response>): Promise<Response> {
  const change = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'cb-web' } });
  clients.push(change);
  let answer!: Promise<Response>;
  await change.begin(async (tx: any) => {
    await tx`select cb.user_password('ahmed', 'ahmed-pass-2', 'ahmed')`;
    await tx`select cb.sign_in_new('ahmed', true)`; // as /api/password does for an admin: every other way in ends
    answer = Promise.resolve(during());
    await heldUpOrAnswered(sql, answer);
  });
  return answer;
}

test('a sign-in with the old password, under way while it is changed, gets nothing', async () => {
  const sql = await db();
  await owner(sql);
  const r = await whileAPasswordChangeIsOpen(sql, () => web('/api/login', { body: { name: 'ahmed', password: 'ahmed-pass-1' } }));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal((await rows(sql)).length, 1, 'only the browser that changed the password is signed in');
});

test('a second password change that knew only the old password is refused, not applied after the first', async () => {
  const sql = await db();
  await owner(sql);
  const cookie = await login('ahmed');
  const r = await whileAPasswordChangeIsOpen(sql, () => web('/api/password', { cookie, body: { current: 'ahmed-pass-1', password: 'taken-over-1' } }));
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal((await rows(sql)).length, 1);
  await login('ahmed', 'ahmed-pass-2');
});

// The rollback in docs/ops/maintain.md, run as written there, then the parts of the code before #4868 that use the old
// column (cb.user_add and cb.user_rotate as of main a2f5bc9, cut to what touches it; the server's sign-in query).
const recovery = () => {
  const doc = readFileSync(new URL('../docs/ops/maintain.md', import.meta.url), 'utf8');
  const found = /\*\*Rolling the board back past that change\*\*[\s\S]*?<<'SQL'\r?\n([\s\S]*?)\r?\nSQL\r?\n/.exec(doc);
  assert.ok(found, 'maintain.md holds the rollback statements');
  return found[1]!;
};
const OLD_FUNCTIONS = `
create or replace function cb.user_add(name text, display text default null, actor text default null, role text default 'member') returns text language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); n text := lower(trim(name)); r text := lower(trim(coalesce(role, 'member'))); t text; now_r text;
begin
  insert into cb.users (name, display, role) values (n, coalesce(nullif(trim(display), ''), initcap(n)), r)
  on conflict on constraint users_pkey do update set role = case when r = 'admin' then 'admin' else cb.users.role end,
    token = case when r = 'admin' and cb.users.role <> 'admin' then gen_random_uuid()::text else cb.users.token end
  returning cb.users.token, cb.users.role into t, now_r;
  return case when current_setting('application_name') = 'cb-web' and now_r = 'member' then t end;
end $$;
create or replace function cb.user_rotate(name text, actor text default null) returns text language plpgsql as $$
#variable_conflict use_variable
declare n text := lower(trim(name)); t text;
begin
  perform cb.dashboard_only();
  update cb.users u set token = gen_random_uuid()::text where u.name = n returning u.token into t;
  return t;
end $$;
`;

for (const board of ['a board moved over from before', 'a board first set up with hashes']) {
  test(`rolled back on ${board}: the documented statements let the old code add and sign in users; forward again`, { timeout: 400_000 }, async () => {
    const sql = await db();
    if (board === 'a board moved over from before') {
      await boardFromBefore(sql);
      setup();
    } else {
      await sql`alter table cb.users drop column if exists token`; // as a new board has it
      await owner(sql);
    }
    await sql.unsafe(OLD_FUNCTIONS); // the old schema.sql replaces the functions and leaves the table as it is
    await sql.unsafe(recovery());
    /** the old server's sign-in: who has this value */
    const oldSignIn = async (value: string) => (await sql`select name from cb.users where token = ${value}`).map((r: any) => r.name);
    const [{ v: added }] = await sql`select cb.user_add('ben', 'Ben') as v`; // someone new, after the recovery
    assert.match(added ?? '', /^[0-9a-f-]{36}$/, 'a user added after the rollback gets a link');
    assert.deepEqual(await oldSignIn(added), ['ben']);
    const [{ v: remade }] = await sql`select cb.user_rotate('ben') as v`;
    assert.deepEqual(await oldSignIn(remade), ['ben']);
    assert.equal((await sql`select count(*)::int as n from cb.users where token is null`)[0].n, 0, 'every user, admins too');
    setup();
    assert.equal(await linkStatus(remade), 302, 'forward again: the link made meanwhile works');
    assert.equal(await linkStatus(added), 401, 'and the one it replaced does not');
    assert.equal((await sql`select count(*)::int as n from cb.users where token is not null`)[0].n, 0);
  });
}

test('only the server signs a browser in: not a session, and not the web API', async () => {
  const sql = await db();
  await owner(sql);
  await assert.rejects(session()`select cb.sign_in_new('ahmed')`, /only Ahmed can do this/);
  await assert.rejects(session()`select cb.sign_in_password('ahmed', 'ahmed-pass-1')`, /only Ahmed can do this/);
  const admin = await login('ahmed');
  const before = (await rows(sql)).length;
  for (const fn of ['sign_in_new', 'sign_in_password', 'sign_in_user', 'sign_out', '_sign_in_issue']) {
    assert.notEqual((await web(`/api/rpc/${fn}`, { cookie: admin, body: { name: 'ahmed' } })).status, 200, fn);
  }
  assert.equal((await rows(sql)).length, before);
});
