// Login for everyone (#1749): the board on a VPS has no "this PC" to trust. Admins (Ahmed, the owner, and anyone he
// makes admin) sign in with a password and get the full board; members get the guest page, as before.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, onProject } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app, loginFails } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
afterEach(() => { delete process.env.CB_TRUST_LOCAL; delete process.env.HOST; delete process.env.CB_BEHIND_CLOUDFLARE; loginFails.clear(); });
async function db() { const s = await freshDb(); clients.push(s); return s; }

const SITE = 'board.example.com';
/** A browser on the public URL, behind the proxy: X-Forwarded-* set, the public Host passed through. */
const web = (path: string, o: { cookie?: string; method?: string; body?: object; ip?: string; headers?: Record<string, string> } = {}) =>
  app.request(path, { method: o.method ?? (o.body ? 'POST' : 'GET'), headers: {
    host: SITE, 'x-forwarded-for': o.ip ?? '203.0.113.7', 'x-forwarded-proto': 'https', origin: `https://${SITE}`, 'sec-fetch-site': 'same-origin',
    ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: `cb_user=${o.cookie}` } : {}), ...o.headers },
    body: o.body ? JSON.stringify(o.body) : undefined });
const cookieOf = (r: Response) => /cb_user=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
async function login(name: string, password: string, ip?: string) {
  const r = await web('/api/login', { body: { name, password }, ip });
  return { status: r.status, cookie: cookieOf(r), set: r.headers.get('set-cookie') ?? '' };
}
/** The owner, as setup on a fresh VPS makes him: user ahmed, admin, with a password. */
async function owner(sql: any, pw = 'owner-pass-1') {
  await sql`select cb.user_add('ahmed', 'Ahmed', role => 'admin')`;
  await sql`select cb.user_password('ahmed', ${pw})`;
}

test('roles: members by default; only the dashboard makes admins; ahmed is the owner and only an admin', async () => {
  const sql = await db();
  await sql`select cb.user_add('cai', 'Cai')`;
  assert.equal((await sql`select role from cb.users where name = 'cai'`)[0].role, 'member');
  await assert.rejects(sql`select cb.user_add('ahmed', 'Ahmed')`, /ahmed is the board owner: add him as admin/);
  for (const n of ['ahmed-m', 'ahmed2', 'mr-ahmed']) await assert.rejects(sql`select cb.user_add(${n}, 'X')`, /reserved for the owner/, n);
  await owner(sql);
  assert.equal((await sql`select role from cb.users where name = 'ahmed'`)[0].role, 'admin');

  const session = postgresAs('W1@pc'); // a session: no cb-web
  await assert.rejects(session`select cb.user_add('ana', 'Ana', role => 'admin')`, /only Ahmed can do this/);
  await assert.rejects(session`select cb.user_set_role('cai', 'admin')`, /only Ahmed can do this/);
  await session`select cb.user_add('ana', 'Ana')`; // a member, as before
  await sql`select cb.user_set_role('cai', 'admin')`;
  assert.equal((await sql`select role from cb.users where name = 'cai'`)[0].role, 'admin');
  await assert.rejects(sql`select cb.user_set_role('cai', 'owner')`, /role: admin or member/);
  await assert.rejects(sql`select cb.user_set_role('ahmed', 'member')`, /ahmed is the owner: always an admin/);
  // the last admin standing can't be removed or demoted (on a VPS nobody could sign in to fix it)
  await sql`select cb.user_set_role('cai', 'member')`;
  await assert.rejects(sql`select cb.user_remove('ahmed')`, /ahmed is the owner: can't be removed/);
  const events = await sql`select summary from cb.events where kind = 'user' order by id`;
  assert.ok(events.some((e: any) => e.summary === 'Cai (cai) is now admin'));
  assert.ok(events.some((e: any) => e.summary === 'Cai (cai) is now member'));
});

test('the owner is not one of "the people": not in pickers, not assignable, cb assign ahmed hands back', async () => {
  const sql = await db();
  await owner(sql);
  await sql`select cb.user_add('cai', 'Cai')`;
  await onProject(sql, 'cai', 'iris');
  const [{ id }] = await sql`select cb.ask(project => 'iris', body => 'Scope?', to_user => 'cai', actor => 'orch@shaltoot') as id`;
  await sql`select cb.question_assign(${String(id)}, 'ahmed')`;
  assert.equal((await sql`select assigned_to from cb.questions where id = ${id}`)[0].assigned_to, null, 'ahmed = back to Ahmed');
  // a task can still be left with ahmed (on no project): the owner is exempt from the project check
  const [{ t }] = await sql`select cb.task_add(project => 'iris', title => 'x', assignee => 'ahmed', actor => 'orch@shaltoot') as t`;
  assert.ok(t);
  await owner(sql).catch(() => {}); // idempotent re-add does not throw on the second run of setup
  const users = await (await web('/api/users', { cookie: await adminCookie() })).json();
  assert.deepEqual(users.map((u: any) => u.name), ['cai'], 'pickers offer people, not the owner');
});

async function adminCookie(name = 'ahmed', pw = 'owner-pass-1') { return (await login(name, pw)).cookie!; }

test('through the proxy, nothing without signing in; the owner signs in with his password and gets the whole board', async () => {
  const sql = await db();
  await owner(sql);
  for (const p of ['/api/tasks', '/api/people', '/api/users', '/api/today']) assert.equal((await web(p)).status, 401, p);
  assert.deepEqual(await (await web('/api/whoami')).json(), { role: 'anonymous' });
  assert.equal((await login('ahmed', 'wrong-pass')).status, 401);
  const l = await login('Ahmed ', 'owner-pass-1'); // name: case and spaces don't matter
  assert.equal(l.status, 200);
  assert.match(l.set, /HttpOnly/i);
  assert.match(l.set, /Secure/i, 'https behind the proxy: a Secure cookie');
  assert.match(l.set, /SameSite=Lax/i);
  assert.deepEqual(await (await web('/api/whoami', { cookie: l.cookie })).json(), { role: 'admin', user: { name: 'ahmed', display: 'Ahmed' } });
  for (const p of ['/api/tasks', '/api/today', '/api/users', '/api/sessions', '/api/memories']) assert.equal((await web(p, { cookie: l.cookie })).status, 200, p);
  const people = await (await web('/api/people', { cookie: l.cookie })).json();
  assert.ok(people.people.some((p: any) => p.name === 'ahmed'), 'the Users page lists the owner (to set his password)');
  // the owner acts as ahmed, as his dashboard always has: an answer from his browser is his
  const [{ id }] = await sql`select cb.ask(project => 'demo', body => 'Go?', options => '["Yes","No"]', actor => 'W1@pc') as id`;
  const r = await web('/api/rpc/answer', { cookie: l.cookie, body: { id: String(id), answer: 'Yes', actor: 'someone-else' } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await sql`select answered_by from cb.questions where id = ${id}`)[0].answered_by, 'ahmed', 'the actor is who signed in, not what the page says');
});

test('a second admin gets the whole board but acts under their own name, never as Ahmed', async () => {
  const sql = await db();
  await owner(sql);
  await sql`select cb.user_add('cai', 'Cai', role => 'admin')`;
  await sql`select cb.user_password('cai', 'cai-pass-1')`;
  const c = await adminCookie('cai', 'cai-pass-1');
  assert.deepEqual(await (await web('/api/whoami', { cookie: c })).json(), { role: 'admin', user: { name: 'cai', display: 'Cai' } });
  const [{ id }] = await sql`select cb.ask(project => 'demo', body => 'Go?', options => '["Yes","No"]', actor => 'W1@pc') as id`;
  const r = await web('/api/rpc/answer', { cookie: c, body: { id: String(id), answer: 'No', actor: 'ahmed' } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await sql`select answered_by from cb.questions where id = ${id}`)[0].answered_by, 'cai');
  // admin powers: the Users page's calls (dashboard_only) work for any admin
  assert.equal((await web('/api/rpc/user_add', { cookie: c, body: { name: 'ana', display: 'Ana' } })).status, 200);
  // no sign-in value is on the Users page, an admin's or a member's, not even for another admin (#4868: hashes only)
  const people = (await (await web('/api/people', { cookie: c })).json()).people;
  for (const p of people) assert.ok(!('token' in p), p.name);
  assert.equal(people.find((x: any) => x.name === 'ana').has_link, true, 'it says a member has a link');
});

test('admins sign in by password only: a link never signs in an admin', async () => {
  const sql = await db();
  await owner(sql);
  const r = await web(`/?u=${await adminCookie()}`);
  assert.equal(r.status, 401);
  assert.match(await r.text(), /admins sign in with their password/);
  assert.equal(cookieOf(r), undefined);
  const [{ t2 }] = await sql`select cb.user_add('cai', 'Cai') as t2`;
  assert.ok(cookieOf(await web(`/?u=${t2}`)), 'a member\'s link still signs in');
});

test('trusting this PC: on by default (the live board), off when HOST is not loopback or CB_TRUST_LOCAL=0', async () => {
  await db();
  const local = () => app.request('/api/tasks', { headers: { host: 'localhost:4747' } });
  assert.equal((await local()).status, 200, 'today\'s PC board keeps working');
  process.env.HOST = '0.0.0.0'; // a container: anyone reaching the port could say Host: localhost
  assert.equal((await local()).status, 401);
  assert.deepEqual(await (await app.request('/api/whoami', { headers: { host: 'localhost:4747' } })).json(), { role: 'anonymous' });
  delete process.env.HOST;
  process.env.CB_TRUST_LOCAL = '0';
  assert.equal((await local()).status, 401);
});

test('lockout is per name and address: a stranger cannot lock the owner out', async () => {
  const sql = await db();
  await owner(sql);
  for (let i = 0; i < 5; i++) await login('ahmed', 'nope-nope', '198.51.100.9');
  assert.equal((await login('ahmed', 'owner-pass-1', '198.51.100.9')).status, 429, 'that address is locked');
  assert.equal((await login('ahmed', 'owner-pass-1', '203.0.113.7')).status, 200, 'Ahmed, elsewhere, is not');
  loginFails.clear();
  // nginx (NPM) in front, reachable directly: the address is the last X-Forwarded-For hop (the one nginx adds);
  // a cf-connecting-ip the client made up is ignored, so rotating it does not get past the lockout
  for (let i = 0; i < 5; i++) await web('/api/login', { body: { name: 'ahmed', password: 'nope-nope' }, headers: { 'cf-connecting-ip': `192.0.2.${i}`, 'x-forwarded-for': '198.51.100.20' } });
  let r = await web('/api/login', { body: { name: 'ahmed', password: 'owner-pass-1' }, headers: { 'cf-connecting-ip': '192.0.2.99', 'x-forwarded-for': '198.51.100.20' } });
  assert.equal(r.status, 429, 'a made-up cf-connecting-ip does not get past it');
  loginFails.clear();
  // CB_BEHIND_CLOUDFLARE=1 (every request comes through Cloudflare): the address is cf-connecting-ip, which Cloudflare sets
  process.env.CB_BEHIND_CLOUDFLARE = '1';
  for (let i = 0; i < 5; i++) await web('/api/login', { body: { name: 'ahmed', password: 'nope-nope' }, headers: { 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': `10.0.0.${i}` } });
  r = await web('/api/login', { body: { name: 'ahmed', password: 'owner-pass-1' }, headers: { 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '10.9.9.9' } });
  assert.equal(r.status, 429, 'a rotating X-Forwarded-For does not get past it');
});

test('live updates through nginx: the stream tells the proxy not to buffer it', async () => {
  const sql = await db();
  await owner(sql);
  const r = await web('/api/stream', { cookie: (await login('ahmed', 'owner-pass-1')).cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-accel-buffering'), 'no');
  await r.body?.cancel();
});

test('API answers are gzipped for a browser that asks; the live stream never is (compression would hold events back)', async () => {
  const sql = await db();
  await owner(sql);
  const cookie = (await login('ahmed', 'owner-pass-1')).cookie;
  for (let i = 0; i < 10; i++) await sql`select cb.task_add(project => 'demo', title => ${'card ' + i}, body => ${'x'.repeat(300)}, actor => 'W1')`;
  const tasks = await web('/api/tasks', { cookie, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(tasks.status, 200);
  assert.equal(tasks.headers.get('content-encoding'), 'gzip');
  assert.ok(Array.isArray(JSON.parse(Buffer.from(await new Response(tasks.body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()).toString())));
  const plain = await web('/api/tasks', { cookie });
  assert.equal(plain.headers.get('content-encoding'), null, 'no Accept-Encoding: plain JSON');
  const stream = await web('/api/stream', { cookie, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(stream.headers.get('content-encoding'), null);
  await stream.body?.cancel();
});

test('an unchanged API answer is a 304: the page re-checks often, and most checks find nothing new', async () => {
  const sql = await db();
  await owner(sql);
  const cookie = (await login('ahmed', 'owner-pass-1')).cookie;
  await sql`select cb.task_add(project => 'demo', title => 'one', actor => 'W1')`;
  const first = await web('/api/tasks', { cookie });
  const tag = first.headers.get('etag');
  assert.ok(tag, 'an ETag');
  // the browser keeps it but always asks again (private: never a shared cache)
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  await first.body?.cancel();
  const same = await web('/api/tasks', { cookie, headers: { 'if-none-match': tag! } });
  assert.equal(same.status, 304);
  await sql`select cb.task_add(project => 'demo', title => 'two', actor => 'W1')`;
  const changed = await web('/api/tasks', { cookie, headers: { 'if-none-match': tag! } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), tag);
  assert.equal((await changed.json()).length, 2);
});

test('anyone signed in changes their own password; the current one is required', async () => {
  const sql = await db();
  await owner(sql);
  await sql`select cb.user_add('cai', 'Cai')`;
  await sql`select cb.user_password('cai', 'cai-pass-1')`;
  const c = (await login('cai', 'cai-pass-1')).cookie!;
  assert.equal((await web('/api/password', { body: { current: 'cai-pass-1', password: 'new-pass-22' } })).status, 401, 'signed in only');
  const bad = await web('/api/password', { cookie: c, body: { current: 'wrong-pass', password: 'new-pass-22' } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /current password is wrong/);
  assert.match((await (await web('/api/password', { cookie: c, body: { current: 'cai-pass-1', password: 'short' } })).json()).error, /at least 8/);
  assert.equal((await web('/api/password', { cookie: c, body: { current: 'cai-pass-1', password: 'new-pass-22' } })).status, 200);
  assert.equal((await login('cai', 'cai-pass-1')).status, 401);
  assert.equal((await login('cai', 'new-pass-22')).status, 200);
  // a member with only a link (no password yet) sets a first one without a current password
  const [{ token }] = await sql`select cb.user_add('ana', 'Ana') as token`;
  assert.equal((await web('/api/password', { cookie: token, body: { password: 'ana-pass-1' } })).status, 200);
  assert.equal((await login('ana', 'ana-pass-1')).status, 200);
  const cross = await web('/api/password', { cookie: c, body: { current: 'new-pass-22', password: 'x-pass-333' }, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403, 'CSRF: another site cannot change it');
});

test('health: unauthenticated, says only whether the database answers', async () => {
  await db();
  const r = await web('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('members keep the guest page: their own questions and tasks, nothing board-wide', async () => {
  const sql = await db();
  await owner(sql);
  await sql`select cb.user_add('cai', 'Cai')`;
  await sql`select cb.user_password('cai', 'cai-pass-1')`;
  const c = (await login('cai', 'cai-pass-1')).cookie!;
  assert.deepEqual(await (await web('/api/whoami', { cookie: c })).json(), { role: 'guest', user: { name: 'cai', display: 'Cai' } });
  assert.equal((await web('/api/tasks', { cookie: c })).status, 403);
  assert.equal((await web('/api/rpc/user_add', { cookie: c, body: { name: 'x1' } })).status, 403);
  assert.equal((await web('/api/rpc/task_find', { cookie: c, body: { q: 'x' } })).status, 403, 'card search crosses projects: not for a member (#4339)');
  assert.equal((await web('/api/me', { cookie: c })).status, 200);
});

// A connection that is a session (no cb-web), for the SQL guards.
import postgres from 'postgres';
import { TEST_URL } from './helpers.ts';
function postgresAs(_actor: string) {
  const s = postgres(TEST_URL, { onnotice: () => {} });
  clients.push(s);
  return s;
}

import { spawnSync } from 'node:child_process';
const cb = (args: string[], o: { env?: Record<string, string>; input?: string } = {}) => {
  const r = spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8', input: o.input,
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@pc', HERDR_PANE_ID: '', PGAPPNAME: '', ...o.env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

test('cb on a fresh VPS: the first admin and his password from the shell; never from a session', async () => {
  const sql = await db();
  const SHELL = { PGAPPNAME: 'cb-web' }; // the VPS shell, as docs/ops/deploy.md has it
  assert.match(cb(['user', 'add', 'ahmed', 'Ahmed', '--admin']).err, /only Ahmed can do this/);
  const add = cb(['user', 'add', 'ahmed', 'Ahmed', '--admin'], { env: SHELL });
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /added ahmed \(Ahmed\) as admin: set a password/);
  assert.match(cb(['user', 'password', 'ahmed'], { input: 'owner-pass-1\n' }).err, /only Ahmed can do this/);
  assert.equal(cb(['user', 'password', 'ahmed'], { env: SHELL, input: 'owner-pass-1\n' }).code, 0);
  assert.equal((await login('ahmed', 'owner-pass-1')).status, 200, 'the trailing newline is not part of it');
  assert.equal(cb(['user', 'add', 'cai', 'Cai']).code, 0, 'a session still adds members');
  assert.match(cb(['user', 'role', 'cai', 'admin']).err, /only Ahmed can do this/);
  assert.equal(cb(['user', 'role', 'cai', 'admin'], { env: SHELL }).code, 0);
  assert.match(cb(['users']).out, /^cai\s+Cai \(admin\): 0 questions, 0 tasks open$/m);
});

// Review of the vps branch (2026-11-12): what a second admin must not be able to do.
async function twoAdmins(sql: any) {
  await owner(sql);
  await sql`select cb.user_add('cai', 'Cai', role => 'admin')`;
  await sql`select cb.user_password('cai', 'cai-pass-1')`;
  return { ahmed: await adminCookie('ahmed', 'owner-pass-1'), cai: await adminCookie('cai', 'cai-pass-1') };
}
const whoami = async (cookie: string) => (await web('/api/whoami', { cookie })).json();

test('an admin who leaves out the actor still acts under their own name, never as the default ahmed', async () => {
  const sql = await db();
  const { cai } = await twoAdmins(sql);
  const [{ id }] = await sql`select cb.ask(project => 'demo', body => 'Go?', options => '["Yes","No"]', actor => 'W1@pc') as id`;
  const r = await web('/api/rpc/answer', { cookie: cai, body: { id: String(id), answer: 'Yes' } }); // no actor at all
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await sql`select answered_by from cb.questions where id = ${id}`)[0].answered_by, 'cai');
  // functions without an actor argument still work for admins
  const s = await web('/api/rpc/seen', { cookie: cai, body: {} });
  assert.equal(s.status, 200, await s.clone().text());
});

test('another admin cannot take over the owner: no new link, no password reset for ahmed', async () => {
  const sql = await db();
  const { ahmed, cai } = await twoAdmins(sql);
  const rot = await web('/api/rpc/user_rotate', { cookie: cai, body: { name: 'ahmed' } });
  assert.equal(rot.status, 403, await rot.clone().text());
  const pw = await web('/api/rpc/user_password', { cookie: cai, body: { name: 'ahmed', password: 'taken-over-1' } });
  assert.equal(pw.status, 403);
  assert.equal((await login('ahmed', 'owner-pass-1')).status, 200, "the owner's password is unchanged");
  assert.equal((await whoami(ahmed)).user?.name, 'ahmed', 'his sign-in still works');
  // a token is never handed out for an admin, even to the owner rotating it ("sign out everywhere")
  const own = await web('/api/rpc/user_rotate', { cookie: ahmed, body: { name: 'cai' } });
  assert.equal(own.status, 200, await own.clone().text());
  assert.equal((await own.json()).result, null);
  assert.deepEqual(await whoami(cai), { role: 'anonymous' }, 'cai is signed out everywhere');
  // nobody sets their own password this way (that is /api/password, with the current one)
  assert.equal((await web('/api/rpc/user_password', { cookie: ahmed, body: { name: 'ahmed', password: 'no-current-1' } })).status, 403);
  // members' links still rotate, by any admin
  await sql`select cb.user_add('ana', 'Ana')`;
  const m = await web('/api/rpc/user_rotate', { cookie: await adminCookie('cai', 'cai-pass-1'), body: { name: 'ana' } });
  assert.equal(m.status, 200, await m.clone().text());
  assert.match((await m.json()).result, /^[0-9a-f-]{36}$/, "a member's new link, to send");
});

test("Telegram pairing is the owner's alone: another admin cannot re-pair the bot to themselves", async () => {
  const sql = await db();
  const { ahmed, cai } = await twoAdmins(sql);
  assert.equal((await web('/api/telegram/connect', { cookie: cai, method: 'POST' })).status, 403);
  assert.equal((await web('/api/telegram/disconnect', { cookie: cai, method: 'POST' })).status, 403);
  assert.notEqual((await web('/api/telegram/connect', { cookie: ahmed, method: 'POST' })).status, 403);
});

test('a role change issues a new token: an old member link never becomes an admin credential', async () => {
  const sql = await db();
  await owner(sql);
  const [{ token }] = await sql`select cb.user_add('ana', 'Ana') as token`;
  await sql.begin(async (tx: any) => { await tx`set local application_name = 'cb-web'`; await tx`select cb.user_set_role('ana', 'admin')`; });
  assert.deepEqual(await whoami(token), { role: 'anonymous' });
  const [{ k }] = await sql`select cb.user_add('ben', 'Ben') as k`;
  assert.equal((await whoami(k)).role, 'guest', 'signed in before the promotion');
  await sql`select cb.user_add('ben', 'Ben', role => 'admin')`; // promotion by adding again
  assert.deepEqual(await whoami(k), { role: 'anonymous' });
});

test('lockout counters survive the prune: a flood of junk names does not reset them', async () => {
  const sql = await db();
  await owner(sql);
  for (let i = 0; i < 4; i++) await login('ahmed', 'nope-nope', '198.51.100.9');
  for (let i = 0; i < 1001; i++) loginFails.set(`junk${i}|198.51.100.9`, { n: 1, until: 0, last: Date.now() } as any);
  await login('ahmed', 'nope-nope', '198.51.100.9'); // the 5th: the prune runs here
  assert.equal((await login('ahmed', 'owner-pass-1', '198.51.100.9')).status, 429);
});

test("an admin changing their password signs out every other browser; a member's link keeps working", async () => {
  const sql = await db();
  await owner(sql);
  const old = await adminCookie('ahmed', 'owner-pass-1');
  const r = await web('/api/password', { cookie: old, body: { current: 'owner-pass-1', password: 'owner-pass-2' } });
  assert.equal(r.status, 200, await r.clone().text());
  const fresh = cookieOf(r);
  assert.ok(fresh && fresh !== old, 'this browser gets a new cookie');
  assert.deepEqual(await whoami(old), { role: 'anonymous' });
  assert.equal((await whoami(fresh!)).role, 'admin');
  const [{ token }] = await sql`select cb.user_add('ana', 'Ana') as token`;
  assert.equal((await web('/api/password', { cookie: token, body: { password: 'ana-pass-1' } })).status, 200);
  assert.ok(cookieOf(await web(`/?u=${token}`)), 'her link still signs her in');
});

test("another admin's role and removal are the owner's: no demote-reset-promote takeover", async () => {
  const sql = await db();
  const { ahmed, cai } = await twoAdmins(sql);
  await sql`select cb.user_add('ana', 'Ana', role => 'admin')`;
  await sql`select cb.user_password('ana', 'ana-pass-1')`;
  // cai demotes ana, resets her (now member) password, promotes her again, signs in as her: refused at the first step
  const demote = await web('/api/rpc/user_set_role', { cookie: cai, body: { name: 'ana', role: 'member' } });
  assert.equal(demote.status, 403, await demote.clone().text());
  assert.equal((await web('/api/rpc/user_remove', { cookie: cai, body: { name: 'ana' } })).status, 403);
  assert.equal((await sql`select role from cb.users where name = 'ana'`)[0].role, 'admin');
  // cai still manages members, and himself; the owner manages everyone
  await sql`select cb.user_add('ben', 'Ben')`;
  assert.equal((await web('/api/rpc/user_set_role', { cookie: cai, body: { name: 'ben', role: 'admin' } })).status, 200);
  const own = await web('/api/rpc/user_set_role', { cookie: ahmed, body: { name: 'ben', role: 'member' } });
  assert.equal(own.status, 200, await own.clone().text());
  assert.equal((await web('/api/rpc/user_set_role', { cookie: cai, body: { name: 'cai', role: 'member' } })).status, 200, 'stepping down');
});
