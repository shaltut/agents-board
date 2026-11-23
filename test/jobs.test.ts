import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

const RECIPES = [
  { project: 'demo', recipe: 'test', params: { files: { min: 1, max: 20 } }, db: false },
  { project: 'demo', recipe: 'itest', params: { files: { min: 1, max: 20 } }, db: true },
];
const runnerConn = () => { const c = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'cb-runner/test' } }); clients.push(c); return c; };

async function setup() {
  const sql = await freshDb(); clients.push(sql); // cb-web: Ahmed's dashboard
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p2','B1@mac','demo','builder'), ('pc','p4','orch@pc','demo','lead')`;
  const runner = runnerConn();
  await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1', ${runner.json(RECIPES as any)})`;
  const session = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'claude-session' } }); clients.push(session);
  const add = (actor: string, recipe = 'test', params: any = { files: ['a.test.ts'] }, sha = 'abcdef1234') =>
    session`select cb.job_add('demo', ${recipe}, ${sha}, ${session.json(params)}, null, ${actor}) as r`.then((r: any) => r[0].r);
  return { sql, runner, session, add };
}

test('queues a job for a bound session and counts the ones ahead', async () => {
  const { sql, add } = await setup();
  const a = await add('B1@mac', 'test', { files: ['a.test.ts'] }, 'ABCDEF1');
  assert.equal(a.ahead, 0);
  assert.equal((await add('B1@mac')).ahead, 1);
  assert.equal((await sql`select sha from cb.jobs where id = ${a.id}`)[0].sha, 'abcdef1');
});

test('refuses unknown recipes, unknown or missing params and bad values, naming the param', async () => {
  const { add } = await setup();
  await assert.rejects(add('B1@mac', 'ghost'), /no recipe ghost/);
  await assert.rejects(add('B1@mac', 'test', { other: ['a'] }), /unknown parameter other/);
  await assert.rejects(add('B1@mac', 'test', {}), /files needs at least 1/);
  for (const bad of ['-r', '../x', 'a/../b', 'C:/x', '/etc', 'a b', 'x\\y']) {
    await assert.rejects(add('B1@mac', 'test', { files: [bad] }), /bad value for files/, bad);
  }
  await assert.rejects(add('B1@mac', 'test', { files: Array.from({ length: 21 }, (_, i) => `f${i}.ts`) }), /at most 20/);
  await assert.rejects(add('B1@mac', 'test', { files: ['a'] }, 'xyz'), /sha/);
});

test('only a bound session of the project, or the dashboard, may queue', async () => {
  const { sql, add } = await setup();
  await assert.rejects(add('stranger@mac'), /bound session/);
  await sql`update cb.sessions set last_seen = now() - interval '2 days' where actor = 'B1@mac'`;
  await assert.rejects(add('B1@mac'), /bound session/);
  await sql`select cb.ensure_project('other')`;
  await sql`update cb.sessions set last_seen = now(), project = 'other' where actor = 'B1@mac'`;
  await assert.rejects(add('B1@mac'), /bound session/);
  const r = (await sql`select cb.job_add('demo', 'test', 'abcdef1', '{"files":["a"]}'::jsonb, null, 'ahmed') as r`)[0].r;
  assert.equal(r.ahead, 0);
});

test('claim is exclusive and skips DB jobs when told to', async () => {
  const { add, runner } = await setup();
  const r2 = runnerConn();
  await add('B1@mac');
  const got = await Promise.all([runner`select cb.job_claim('pc', false) as j`, r2`select cb.job_claim('pc', false) as j`]);
  assert.equal(got.filter((g: any) => g[0].j !== null).length, 1);
  await add('B1@mac', 'itest');
  assert.equal((await runner`select cb.job_claim('pc', false) as j`)[0].j, null);
  const j = (await runner`select cb.job_claim('pc', true) as j`)[0].j;
  assert.equal(j.recipe, 'itest');
  assert.equal(j.state, 'running');
  assert.equal(j.db, true);
});

test('a session connection cannot claim or finish', async () => {
  const { session } = await setup();
  await assert.rejects(session`select cb.job_claim('pc', true)`, /only the runner/);
  await assert.rejects(session`select cb.job_finish(1, 'pc', 'passed', 0, 'ok')`, /only the runner/);
  await assert.rejects(session`select cb.runner_hello('pc', null, '[]'::jsonb)`, /only the runner/);
});

test('finish sends the requester one message and ends the job once', async () => {
  const { sql, add, runner } = await setup();
  const { id } = await add('B1@mac');
  await runner`select cb.job_claim('pc', false)`;
  assert.equal((await runner`select cb.job_finish(${id}, 'pc', 'failed', 1, '1 passed, 1 failed. Failing: breaks') as ok`)[0].ok, true);
  const ev = await sql`select actor, summary, data from cb.events where kind = 'message' and data->>'to' = 'B1@mac'`;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, 'runner');
  for (const frag of [`job #${id}`, 'test', 'abcdef1', 'failed (exit 1)', '1 passed, 1 failed. Failing: breaks', `cb job log ${id}`]) {
    assert.ok(ev[0].summary.includes(frag), `${frag} in ${ev[0].summary}`);
  }
  assert.equal((await runner`select cb.job_finish(${id}, 'pc', 'passed', 0, 'x') as ok`)[0].ok, false);
});

test('finish refuses a summary the board would flag or one over 1000 chars', async () => {
  const { sql, add, runner } = await setup();
  const { id } = await add('B1@mac');
  await runner`select cb.job_claim('pc', false)`;
  await assert.rejects(runner`select cb.job_finish(${id}, 'pc', 'failed', 1, 'mail user@example.org now')`, /looks like/);
  await assert.rejects(runner`select cb.job_finish(${id}, 'pc', 'failed', 1, ${'x'.repeat(1001)})`, /1000/);
  assert.equal((await sql`select state from cb.jobs where id = ${id}`)[0].state, 'running');
});

test('cancel: requester, lead or dashboard; queued or running only', async () => {
  const { sql, session, add, runner } = await setup();
  const { id } = await add('B1@mac');
  await assert.rejects(session`select cb.job_cancel(${id}, 'stranger@mac')`, /only the requester/);
  await session`select cb.job_cancel(${id}, 'orch@pc')`;
  const [j] = await sql`select state, finished_at from cb.jobs where id = ${id}`;
  assert.equal(j.state, 'cancelled');
  assert.ok(j.finished_at);
  await assert.rejects(session`select cb.job_cancel(${id}, 'orch@pc')`, /already ended/);
  assert.equal((await runner`select cb.job_finish(${id}, 'pc', 'passed', 0, 'x') as ok`)[0].ok, false);
  const b = await add('B1@mac');
  await sql`select cb.job_cancel(${b.id}, 'ahmed')`; // dashboard
  assert.equal((await sql`select state from cb.jobs where id = ${b.id}`)[0].state, 'cancelled');
});

test('runner restart ends its running jobs and tells the requesters; queued jobs stay', async () => {
  const { sql, add, runner } = await setup();
  const a = await add('B1@mac'); const b = await add('B1@mac');
  await runner`select cb.job_claim('pc', false)`;
  assert.equal((await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1', ${runner.json(RECIPES as any)}) as n`)[0].n, 1);
  const [ra] = await sql`select state, summary from cb.jobs where id = ${a.id}`;
  assert.deepEqual({ ...ra }, { state: 'error', summary: 'error: runner restarted' });
  assert.equal((await sql`select count(*)::int n from cb.events where kind = 'message' and data->>'to' = 'B1@mac'`)[0].n, 1);
  assert.equal((await sql`select state from cb.jobs where id = ${b.id}`)[0].state, 'queued');
});

test('the end survives a requester the board no longer knows', async () => {
  const { sql, add, runner } = await setup();
  const a = await add('B1@mac'); const b = await add('B1@mac');
  await runner`select cb.job_claim('pc', false)`;
  await runner`select cb.job_claim('pc', false)`;
  const forget = async () => {
    await sql`delete from cb.sessions where actor = 'B1@mac'`;
    await sql`delete from cb.events where actor = 'B1@mac' or data->>'to' = 'B1@mac'`;
  };
  await forget();
  assert.equal((await runner`select cb.job_finish(${a.id}, 'pc', 'passed', 0, 'ok') as ok`)[0].ok, true);
  assert.equal((await sql`select state from cb.jobs where id = ${a.id}`)[0].state, 'passed');
  assert.equal((await runner`select cb.runner_hello('pc', null, ${runner.json(RECIPES as any)}) as n`)[0].n, 1);
  assert.equal((await sql`select state from cb.jobs where id = ${b.id}`)[0].state, 'error');
});

test('jobs_list shows queued and running jobs and the runner\'s last beat', async () => {
  const { sql, add, runner } = await setup();
  const a = await add('B1@mac'); const b = await add('B1@mac');
  await runner`select cb.job_claim('pc', false)`;
  const c = await add('B1@mac');
  await runner`select cb.job_finish(${c.id}, 'pc', 'passed', 0, 'x')`; // not running: stays queued, false
  await sql`update cb.runners set last_seen = now() - interval '1 hour'`;
  await runner`select cb.runner_beat('pc')`;
  const l = (await sql`select cb.jobs_list('demo') as l`)[0].l;
  assert.deepEqual(l.jobs.map((j: any) => [j.id, j.state]), [[a.id, 'running'], [b.id, 'queued'], [c.id, 'queued']]);
  assert.equal(l.runners.length, 1);
  assert.equal(l.runners[0].name, 'pc');
  assert.equal(l.runners[0].recipes.length, 2);
  assert.ok(Date.now() - new Date(l.runners[0].last_seen).getTime() < 60_000);
});
