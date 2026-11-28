// #4868: a sign-in (a member's link, or a signed-in browser's cookie) is stored as a hash only, so reading the database
// gives nothing that signs anyone in. Every value here is made up by the test.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

test('only the server signs a browser in: not a session, and not the web API', async () => {
  const sql = await db();
  await owner(sql);
  await assert.rejects(session()`select cb.sign_in_new('ahmed')`, /only Ahmed can do this/);
  const admin = await login('ahmed');
  const before = (await rows(sql)).length;
  for (const fn of ['sign_in_new', 'sign_in_user', 'sign_out', '_sign_in_issue']) {
    assert.notEqual((await web(`/api/rpc/${fn}`, { cookie: admin, body: { name: 'ahmed' } })).status, 200, fn);
  }
  assert.equal((await rows(sql)).length, before);
});
