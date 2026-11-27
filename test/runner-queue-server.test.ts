// The Runners page over HTTP (#4527): who reads /api/runners, who may manage the queue from the web, and the live
// event a job change sends. In the style of test/server.test.ts and test/settings.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app, fanQueue } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }

const SITE = 'board.example.com';
const web = (path: string, o: { cookie?: string; body?: object } = {}) =>
  app.request(path, { method: o.body ? 'POST' : 'GET', headers: {
    host: SITE, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', origin: `https://${SITE}`, 'sec-fetch-site': 'same-origin',
    ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: `cb_user=${o.cookie}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined });
async function signIn(name: string, password: string) {
  const r = await web('/api/login', { body: { name, password } });
  return /cb_user=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1]!;
}

async function setup() {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p2','B1@mac','demo','builder')`;
  const runner = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'cb-runner/test' } }); clients.push(runner);
  await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1', ${runner.json([{ project: 'demo', recipe: 'test', params: { files: { min: 1, max: 20 } }, db: false }] as any)}, 2, 1)`;
  const [{ r: job }] = await sql`select cb.job_add('demo', 'test', 'abcdef1', '{"files":["a.ts"]}'::jsonb, null, 'ahmed') as r`;
  for (const [name, role, pw] of [['ahmed', 'admin', 'owner-pass-1'], ['cai', 'admin', 'cai-pass-1'], ['ana', 'member', 'ana-pass-1']]) {
    await sql`select cb.user_add(${name}, ${name}, role => ${role})`;
    await sql`select cb.user_password(${name}, ${pw})`;
  }
  return { sql, job, ahmed: await signIn('ahmed', 'owner-pass-1'), cai: await signIn('cai', 'cai-pass-1'), ana: await signIn('ana', 'ana-pass-1') };
}

test('/api/runners: every admin and the PC\'s own screen read it; a guest gets 403, a stranger 401', async () => {
  const { cai, ana, job } = await setup();
  const local = await (await app.request('/api/runners')).json();
  assert.deepEqual(local.waiting.map((w: any) => w.id), [job.id]);
  assert.equal(local.runners[0].slots, 2);
  assert.equal((await web('/api/runners', { cookie: cai })).status, 200, 'another admin reads the page (Q2978)');
  assert.equal((await web('/api/runners', { cookie: ana })).status, 403);
  assert.equal((await web('/api/runners')).status, 401);
  assert.equal((await app.request('/api/runners?project=nope')).status, 400);
});

test('managing the queue from the web is Ahmed\'s: another admin gets 403 before the database is asked', async () => {
  const { sql, ahmed, cai, job } = await setup();
  const writes: [string, object][] = [
    ['job_move', { id: job.id, place: 'back' }], ['job_hold', { project: 'demo', held: true }], ['runner_set', { runner: 'pc', mode: 'paused' }],
    ['runner_limits_set', { runner: 'pc', slots: 3, db_lanes: 1 }], ['job_cancel', { id: job.id }],
  ];
  for (const [fn, body] of writes) {
    const r = await web(`/api/rpc/${fn}`, { cookie: cai, body: { ...body, actor: 'ahmed' } });
    assert.equal(r.status, 403, fn);
    assert.match((await r.json()).error, /Only Ahmed manages the runner queue/, fn);
  }
  assert.deepEqual({ ...(await sql`select mode, slots_set from cb.runners`)[0] }, { mode: 'on', slots_set: null });
  for (const [fn, body] of writes) {
    const r = await web(`/api/rpc/${fn}`, { cookie: ahmed, body });
    assert.equal(r.status, 200, `${fn}: ${await r.clone().text()}`);
  }
  assert.deepEqual({ ...(await sql`select mode, slots_set from cb.runners`)[0] }, { mode: 'paused', slots_set: 3 });
  // the page's Save: an empty field clears that number (clear_*), a filled one replaces it; the other is kept
  const save = async (body: object) => {
    const r = await web('/api/rpc/runner_limits_set', { cookie: ahmed, body: { runner: 'pc', ...body } });
    assert.equal(r.status, 200, await r.clone().text());
    return { ...(await sql`select slots_set, lanes_set from cb.runners`)[0] };
  };
  assert.deepEqual(await save({ slots: 5, db_lanes: null, clear_slots: false, clear_lanes: true }), { slots_set: 5, lanes_set: null });
  assert.deepEqual(await save({ slots: null, db_lanes: null, clear_slots: true, clear_lanes: true }), { slots_set: null, lanes_set: null });
  const retry = await web('/api/rpc/job_retry', { cookie: ahmed, body: { id: job.id } });
  assert.equal(retry.status, 200, await retry.clone().text());
});

test('a job change reaches open pages as one queue event a second, under its own name (never a change event)', async () => {
  await setup();
  const res = await app.request('/api/stream');
  const reader = res.body!.getReader();
  const seen: string[] = [];
  const pump = (async () => {
    const dec = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; seen.push(dec.decode(value)); }
  })();
  const text = () => seen.join('');
  for (let i = 0; i < 100 && !text().includes('event: hello'); i++) await new Promise((r) => setTimeout(r, 20));
  fanQueue(50); fanQueue(50); fanQueue(50);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(text().match(/event: queue\ndata: jobs/g)?.length, 1, text());
  assert.ok(!/event: change\ndata: jobs/.test(text()));
  // and from the database: a job queued notifies cb_queue, which the server turns into the same event
  const sql = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'cb-web' } }); clients.push(sql);
  await sql`select cb.job_add('demo', 'test', 'abcdef2', '{"files":["b.ts"]}'::jsonb, null, 'ahmed')`;
  for (let i = 0; i < 100 && (text().match(/event: queue/g)?.length ?? 0) < 2; i++) await new Promise((r) => setTimeout(r, 30));
  assert.equal(text().match(/event: queue/g)?.length, 2);
  await reader.cancel();
  await pump.catch(() => {});
});
