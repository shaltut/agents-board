// The runner queue page (#4527): cb.runner_queue, moving, holding and re-running jobs, pausing and draining a runner,
// Ahmed's slot setting, and who may do each (Q2982-Q2984). Real database, in the style of test/jobs.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

const RECIPES = [
  { project: 'demo', recipe: 'test', params: { files: { min: 1, max: 20 } }, db: false },
  { project: 'demo', recipe: 'itest', params: { files: { min: 1, max: 20 } }, db: true },
  { project: 'other', recipe: 'test', params: { files: { min: 1, max: 20 } }, db: false },
];
const conn = (app: string) => { const c = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: app } }); clients.push(c); return c; };

async function setup() {
  const sql = await freshDb(); clients.push(sql); // cb-web: the dashboard
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.ensure_project('other')`;
  // L1 leads demo by role (any name); orch@x is bound to demo with no role: the board's lead too (cb._is_lead), as for cancel
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values
    ('mac','p2','B1@mac','demo','builder'), ('pc','p4','L1@pc','demo','lead'), ('pc','p5','L2@pc','other','lead'), ('mac','p6','B2@mac','other','builder')`;
  await sql`insert into cb.sessions (machine, pane, actor, project) values ('pc','p7','orch@x','demo')`;
  const runner = conn('cb-runner/test');
  await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1', ${runner.json(RECIPES as any)}, 4, 2)`;
  const session = conn('claude-session');
  const add = (actor: string, recipe = 'test', project = 'demo', file = 'a.test.ts') =>
    session`select cb.job_add(${project}, ${recipe}, 'abcdef1234', ${session.json({ files: [file] })}, null, ${actor}) as r`.then((r: any) => r[0].r);
  const claim = (db = true) => runner`select cb.job_claim('pc', ${db}) as j`.then((r: any) => r[0].j);
  const queue = async (project: string | null = null) => (await sql`select cb.runner_queue(${project}) as q`)[0].q;
  const order = async () => (await queue()).waiting.map((w: any) => w.id);
  return { sql, runner, session, add, claim, queue, order };
}

test('runner_queue lists waiting jobs in exactly the order job_claim takes them, before and after moves', async () => {
  const { sql, add, claim, order } = await setup();
  const [a, b, c] = [await add('B1@mac'), await add('B1@mac', 'test', 'demo', 'b.ts'), await add('B1@mac', 'test', 'demo', 'c.ts')];
  assert.deepEqual(await order(), [a.id, b.id, c.id]);
  await sql`select cb.job_move(${c.id}, 'next', 'ahmed')`;
  assert.deepEqual(await order(), [c.id, a.id, b.id]);
  await sql`select cb.job_move(${b.id}, 'up', 'ahmed')`;
  assert.deepEqual(await order(), [c.id, b.id, a.id]);
  await sql`select cb.job_move(${c.id}, 'back', 'ahmed')`;
  const want = await order();
  assert.deepEqual(want, [b.id, a.id, c.id]);
  const d = await add('B1@mac', 'test', 'demo', 'd.ts'); // a job queued later still goes after every moved one
  assert.equal((await order()).at(-1), d.id);
  assert.equal(d.ahead, 3);
  const got = [];
  for (let j; (j = await claim());) got.push(Number(j.id));
  assert.deepEqual(got, [...want, d.id]);
});

test('many moves between the same two neighbours keep a strict order and distinct places', async () => {
  const { sql, add, order } = await setup();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await add('B1@mac', 'test', 'demo', `f${i}.ts`)).id);
  for (let i = 0; i < 60; i++) {
    await sql`select cb.job_move(${ids[2]}, ${i % 2 ? 'down' : 'up'}, 'ahmed')`;
    const keys = (await sql`select coalesce(pos, id) as k from cb.jobs where state = 'queued'`).map((r: any) => String(r.k));
    assert.equal(new Set(keys).size, 4, 'no two waiting jobs share a place');
  }
  assert.deepEqual(await order(), ids, '30 ups and 30 downs of the same job end where they began');
  await sql`select cb.job_move(${ids[0]}, 'up', 'ahmed')`; // already first: nothing moves
  await sql`select cb.job_move(${ids[3]}, 'down', 'ahmed')`;
  assert.deepEqual(await order(), ids);
});

test('a lead moves only its own project\'s jobs, and only among them: other projects keep their places', async () => {
  const { sql, session, add, order } = await setup();
  const d1 = await add('B1@mac'), o1 = await add('B2@mac', 'test', 'other'), d2 = await add('B1@mac', 'test', 'demo', 'b.ts');
  await session`select cb.job_move(${d2.id}, 'next', 'L1@pc')`;
  assert.deepEqual(await order(), [d2.id, o1.id, d1.id], 'd2 takes d1\'s place; the other project\'s job stays second');
  await assert.rejects(session`select cb.job_move(${o1.id}, 'next', 'L1@pc')`, /only Ahmed or the lead of other/);
  await assert.rejects(session`select cb.job_move(${d1.id}, 'next', 'L2@pc')`, /only Ahmed or the lead of demo/);
  // review I1: a role-less orch session bound to the project is its lead (cb._is_lead), as job_cancel has it
  await session`select cb.job_move(${d1.id}, 'next', 'orch@x')`;
  assert.deepEqual(await order(), [d1.id, o1.id, d2.id], 'orch@x swapped its project\'s two jobs; the other project\'s stays second');
  await assert.rejects(session`select cb.job_move(${d1.id}, 'next', 'B1@mac')`, /only Ahmed or the lead/, 'the asker is not a manager');
  await assert.rejects(session`select cb.job_move(${d1.id}, 'next', 'ahmed')`, /only Ahmed's dashboard/);
  await assert.rejects(sql`select cb.job_move(${d1.id}, 'next', 'cai')`, /only Ahmed or the lead/, 'another admin on the dashboard');
  await assert.rejects(sql`select cb.job_move(${d1.id}, 'sideways', 'ahmed')`, /next, up, down or back/);
  await sql`select cb.job_move(${o1.id}, 'next', 'ahmed')`; // Ahmed moves over the whole queue
  assert.equal((await order())[0], o1.id);
});

test('a moved job no longer waiting is refused; a DB job moved to the front waits for a lane while plain jobs start', async () => {
  const { sql, add, claim } = await setup();
  const p1 = await add('B1@mac'), d1 = await add('B1@mac', 'itest');
  await sql`select cb.job_move(${d1.id}, 'next', 'ahmed')`;
  assert.equal(Number((await claim(false)).id), p1.id, 'no lane free: the plain job behind it starts');
  await assert.rejects(sql`select cb.job_move(${p1.id}, 'back', 'ahmed')`, /not waiting any more/);
  assert.equal(Number((await claim(true)).id), d1.id);
});

test('why it waits: held, no runner, not answering, paused, draining, no lane, no slot, next', async () => {
  const { sql, runner, add, claim, queue } = await setup();
  const why = async (id: number) => (await queue()).waiting.find((w: any) => w.id === id)?.why;
  const j = await add('B1@mac');
  assert.equal((await why(j.id)).reason, 'next');
  await sql`select cb.runner_set('pc', 'paused', 'ahmed')`;
  assert.deepEqual([(await why(j.id)).reason, (await why(j.id)).by], ['paused', 'ahmed']);
  await sql`select cb.runner_set('pc', 'draining', 'ahmed')`;
  assert.equal((await why(j.id)).reason, 'draining');
  await sql`select cb.runner_set('pc', 'on', 'ahmed')`;
  await sql`update cb.runners set last_seen = now() - interval '4 minutes'`;
  assert.equal((await why(j.id)).reason, 'down');
  await runner`select cb.runner_beat('pc')`;
  await sql`select cb.job_hold('demo', true, 'ahmed')`;
  assert.equal((await why(j.id)).reason, 'held');
  await sql`select cb.job_hold('demo', false, 'ahmed')`;
  // fill the 4 slots (2 lanes) the runner reported
  assert.equal(Number((await claim()).id), j.id);
  await add('B1@mac', 'itest', 'demo', 'i1.ts'); await add('B1@mac', 'itest', 'demo', 'i2.ts');
  for (let i = 0; i < 2; i++) assert.equal((await claim(true)).recipe, 'itest');
  const di = await add('B1@mac', 'itest', 'demo', 'i3.ts');
  assert.deepEqual(await why(di.id), { reason: 'lane', busy: 2, of: 2 });
  await sql`select cb.runner_limits_set('pc', 4, 3, 'ahmed')`;
  assert.equal((await why(di.id)).reason, 'lane', 'a higher lane setting than the runner reported counts only once it reports it');
  await add('B1@mac', 'test', 'demo', 'x.ts');
  assert.equal((await claim(false)).recipe, 'test');
  const k = await add('B1@mac', 'test', 'demo', 'k.ts');
  assert.deepEqual(await why(k.id), { reason: 'slot', busy: 4, of: 4 });
  await sql`delete from cb.runner_recipes where project = 'demo' and recipe = 'test'`;
  assert.equal((await why(k.id)).reason, 'no_runner');
});

test('the page read: runner card facts, counts of the whole queue, a project filter on the lists only, finished jobs', async () => {
  const { sql, runner, add, claim, queue } = await setup();
  await add('B1@mac'); await add('B2@mac', 'test', 'other');
  const r = await claim();
  await runner`select cb.job_finish(${r.id}, 'pc', 'failed', 1, '1 passed, 1 failed')`;
  await claim();
  const q = await queue('demo');
  assert.equal(q.runners.length, 1);
  assert.equal(q.runners[0].name, 'pc');
  assert.equal(q.runners[0].slots, 4);
  assert.equal(q.runners[0].db_lanes, 2);
  assert.equal(q.runners[0].mode, 'on');
  assert.equal(q.runners[0].busy, 1);
  assert.equal(q.counts.running, 1, 'the whole machine');
  assert.equal(q.counts.running_here, 0, 'the running job is the other project\'s');
  assert.equal(q.counts.failed_hour, 1);
  assert.equal(q.finished[0].summary, '1 passed, 1 failed');
  assert.ok(!('exit_code' in q.finished[0]), 'no exit code reaches the page');
  assert.equal(q.running.length, 0);
  assert.equal((await queue()).running[0].project, 'other');
  assert.equal(q.supervisor, false);
  await assert.rejects(sql`select cb.runner_queue('nope')`);
});

test('the supervisor flag is true while a connection holds the cb-supervisor advisory lock', async () => {
  const { queue } = await setup();
  const lock = conn('cb-supervisor/test');
  const c = await lock.reserve();
  await c`select pg_advisory_lock(hashtext('cb-supervisor'))`;
  assert.equal((await queue()).supervisor, true);
  await c`select pg_advisory_unlock(hashtext('cb-supervisor'))`;
  c.release();
  assert.equal((await queue()).supervisor, false);
});

test('pause and drain stop claims; a restart ends a drain but keeps a pause; resume wakes the runner; Ahmed only', async () => {
  const { sql, runner, session, add, claim } = await setup();
  await add('B1@mac');
  await sql`select cb.runner_set('pc', 'paused', 'ahmed')`;
  assert.equal(await claim(), null);
  await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1', ${runner.json(RECIPES as any)}, 4, 2)`;
  assert.equal((await sql`select mode from cb.runners`)[0].mode, 'paused', 'a pause stays across a restart');
  await sql`select cb.runner_set('pc', 'draining', 'ahmed')`;
  assert.equal(await claim(), null);
  await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1', ${runner.json(RECIPES as any)}, 4, 2)`;
  assert.equal((await sql`select mode from cb.runners`)[0].mode, 'on', 'the restart ended the drain');
  await sql`select cb.runner_set('pc', 'paused', 'ahmed')`;
  const heard: string[] = [];
  const listener = conn('listener');
  await listener.listen('cb_jobs', (x: string) => heard.push(x));
  await sql`select cb.runner_set('pc', 'on', 'ahmed')`;
  for (let i = 0; i < 50 && !heard.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(heard.length, 'resume tells the runner at once');
  assert.ok(await claim());
  await assert.rejects(session`select cb.runner_set('pc', 'paused', 'L1@pc')`, /only Ahmed can pause/, 'a lead never pauses the shared runner');
  await assert.rejects(sql`select cb.runner_set('pc', 'paused', 'cai')`, /only Ahmed can pause/, 'another admin');
  await assert.rejects(sql`select cb.runner_set('ghost', 'paused', 'ahmed')`, /no runner ghost/);
});

test('slot and lane settings: Ahmed only, a range, a lower number applies at the next claim, null clears', async () => {
  const { sql, session, add, claim } = await setup();
  await sql`select cb.runner_limits_set('pc', 1, 1, 'ahmed')`;
  await add('B1@mac'); await add('B1@mac', 'test', 'demo', 'b.ts');
  assert.ok(await claim());
  assert.equal(await claim(), null, 'one slot set, one running');
  await sql`select cb.runner_limits_set('pc', 3, 1, 'ahmed')`;
  await add('B1@mac', 'itest', 'demo', 'i1.ts'); await add('B1@mac', 'itest', 'demo', 'i2.ts');
  const got = [await claim(), await claim(), await claim()];
  assert.deepEqual(got.map((j: any) => j?.recipe ?? null), ['test', 'itest', null], 'one lane set: the second DB job waits; then the slots are full');
  await assert.rejects(sql`select cb.runner_limits_set('pc', 0, null, 'ahmed')`, /slots must be 1 to 64/);
  await assert.rejects(sql`select cb.runner_limits_set('pc', 4, 10, 'ahmed')`, /lanes must be 1 to 9/);
  await assert.rejects(sql`select cb.runner_limits_set('pc', 2, 3, 'ahmed')`, /cannot be more than slots/);
  await sql`select cb.runner_limits_set('pc', 20, 6, 'ahmed')`; // beyond the old code cap of 10
  assert.deepEqual({ ...(await sql`select slots_set, lanes_set, set_by from cb.runners`)[0] }, { slots_set: 20, lanes_set: 6, set_by: 'ahmed' });
  await sql`select cb.runner_limits_set('pc', 24, null, 'ahmed')`; // review minor 1: slots alone keep the lane setting
  assert.deepEqual({ ...(await sql`select slots_set, lanes_set from cb.runners`)[0] }, { slots_set: 24, lanes_set: 6 });
  await sql`select cb.runner_limits_set('pc', null, null, 'ahmed', clear_lanes => true)`;
  assert.deepEqual({ ...(await sql`select slots_set, lanes_set from cb.runners`)[0] }, { slots_set: 24, lanes_set: null });
  await sql`select cb.runner_limits_set('pc', null, null, 'ahmed', true, true)`;
  assert.deepEqual({ ...(await sql`select slots_set, lanes_set from cb.runners`)[0] }, { slots_set: null, lanes_set: null });
  // review M1: the range holds on the row itself, whatever writes it
  await assert.rejects(sql`update cb.runners set slots_set = 1000`, /runners_slots_set_check/);
  await assert.rejects(sql`update cb.runners set lanes_set = 0`, /runners_lanes_set_check/);
  await assert.rejects(sql`select cb.runner_limits_set('pc', 65, null, 'ahmed')`, /slots must be 1 to 64/);
  await assert.rejects(session`select cb.runner_limits_set('pc', 2, 1, 'L1@pc')`, /only Ahmed/);
  await assert.rejects(sql`select cb.runner_limits_set('pc', 2, 1, 'cai')`, /only Ahmed/);
});

test('a lead holds its own project\'s jobs (never another\'s); the runner keeps serving the rest', async () => {
  const { sql, session, add, claim, queue } = await setup();
  const d = await add('B1@mac'), o = await add('B2@mac', 'test', 'other');
  await session`select cb.job_hold('demo', true, 'L1@pc')`;
  assert.equal((await add('B1@mac', 'test', 'demo', 'z.ts')).held, true, 'a new job is told its project is held');
  assert.equal(Number((await claim()).id), o.id);
  assert.equal(await claim(), null);
  assert.equal((await queue()).holds[0].held_by, 'L1@pc');
  await assert.rejects(session`select cb.job_hold('demo', false, 'L2@pc')`, /only Ahmed or the lead of demo/);
  await assert.rejects(session`select cb.job_hold('other', true, 'orch@x')`, /only Ahmed or the lead of other/);
  await session`select cb.job_hold('demo', false, 'orch@x')`; // a role-less orch session is its project's lead
  assert.equal((await queue()).holds.length, 0);
  await session`select cb.job_hold('demo', true, 'orch@x')`;
  await sql`select cb.job_hold('demo', false, 'ahmed')`;
  assert.equal(Number((await claim()).id), d.id);
});

test('run again: a new job linked to the old one, for its requester; refused while running, twice, or for a gone recipe', async () => {
  const { sql, runner, session, add, claim } = await setup();
  const a = await add('B1@mac');
  await assert.rejects(session`select cb.job_retry(${a.id}, 'B1@mac')`, /has not ended/);
  const j = await claim();
  await runner`select cb.job_finish(${j.id}, 'pc', 'failed', 1, 'x')`;
  await assert.rejects(session`select cb.job_retry(${a.id}, 'B2@mac')`, /only the requester, the lead of demo or Ahmed/);
  await assert.rejects(sql`select cb.job_retry(${a.id}, 'cai')`, /only the requester/);
  const r = (await session`select cb.job_retry(${a.id}, 'L1@pc') as r`)[0].r;
  const row = (await sql`select * from cb.jobs where id = ${r.id}`)[0];
  assert.deepEqual([row.retry_of, row.requester, row.sha, row.params, row.state], [String(a.id), 'B1@mac', 'abcdef1234', { files: ['a.test.ts'] }, 'queued']);
  await assert.rejects(sql`select cb.job_retry(${a.id}, 'ahmed')`, new RegExp(`already waiting or running as job #${r.id}`));
  await sql`select cb.job_cancel(${r.id}, 'ahmed')`;
  await sql`select cb.job_retry(${r.id}, 'ahmed')`; // a stopped job runs again too
  await sql`update cb.jobs set state = 'cancelled' where state = 'queued'`;
  await sql`delete from cb.runner_recipes where recipe = 'test' and project = 'demo'`;
  await assert.rejects(session`select cb.job_retry(${a.id}, 'B1@mac')`, /no recipe test for demo/);
});

test('cancel from the dashboard is Ahmed\'s: another admin\'s name is refused (the page is for every admin)', async () => {
  const { sql, add } = await setup();
  const a = await add('B1@mac');
  await assert.rejects(sql`select cb.job_cancel(${a.id}, 'cai')`, /only the requester, the project's lead or Ahmed/);
  await sql`select cb.job_cancel(${a.id}, 'ahmed')`;
});

test('job_add tells a new job when the runner is paused; the old 3-argument hello and 2-argument claim still work', async () => {
  const { sql, runner, add } = await setup();
  await sql`select cb.runner_set('pc', 'paused', 'ahmed')`;
  const r = await add('B1@mac');
  assert.deepEqual([r.runner_paused, r.held, r.ahead], [true, false, 0]);
  await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1', ${runner.json(RECIPES as any)})`;
  assert.deepEqual({ ...(await sql`select slots, db_lanes, mode from cb.runners`)[0] }, { slots: null, db_lanes: null, mode: 'paused' });
  await sql`select cb.runner_set('pc', 'on', 'ahmed')`;
  assert.ok((await runner`select cb.job_claim('pc', false) as j`)[0].j);
});

test('the page\'s channel: adding, claiming and finishing a job notify cb_queue; the 30 s beat does not', async () => {
  const { runner, add, claim } = await setup();
  const heard: string[] = [];
  const listener = conn('listener');
  await listener.listen('cb_queue', (x: string) => heard.push(x));
  const settle = () => new Promise((r) => setTimeout(r, 150));
  await runner`select cb.runner_beat('pc')`;
  await settle();
  assert.deepEqual(heard, [], 'a beat says nothing');
  await add('B1@mac');
  await settle();
  assert.ok(heard.includes('jobs'));
  heard.length = 0;
  const j = await claim();
  await runner`select cb.job_finish(${j.id}, 'pc', 'passed', 0, 'ok')`;
  await settle();
  assert.ok(heard.length >= 2);
});
