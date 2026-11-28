// #3222 S1c: the functions the runner's, cb triage's and the supervisor's own SQL became. Their suites pin what they do;
// this pins the rules that now live in SQL, above all where cb triage may write (Q3001).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

const TMPL = 'ft-0123456789ab';
const MARK = `fault:${TMPL}`;

async function board() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('claude-board'), cb.ensure_project('demo')`;
  const file = async (over: Record<string, unknown> = {}) => {
    const a: any = { tmpl: TMPL, seen: 'seen 2 more times', last: new Date().toISOString(), title: 'cb mine crashes',
      body: 'It crashes.', facts: `Facts\n${MARK}`, ...over };
    const [r] = await sql`select cb.fault_file(tmpl => ${a.tmpl}, seen => ${a.seen}, last => ${a.last}, title => ${a.title},
      body => ${a.body}, facts => ${a.facts}, actor => 'W1@test') as r`;
    return r.r as { action: string; id: number | null };
  };
  const cards = () => sql`select id, project, status, type, priority, title, body from cb.tasks order by id`;
  const notes = (id: number) => sql`select summary from cb.events where task_id = ${id} and kind = 'note' order by id`;
  return { sql, file, cards, notes };
}

test('fault_file files a bug in claude-board once, then notes that card', async () => {
  const { file, cards, notes } = await board();
  const first = await file();
  assert.equal(first.action, 'filed');
  const [c] = await cards();
  assert.deepEqual([c.project, c.status, c.type, c.priority, c.title], ['claude-board', 'next', 'bug', 'P2', 'cb mine crashes']);
  assert.equal(c.body, `It crashes.\n\nFacts\n${MARK}`);
  assert.deepEqual(await file(), { action: 'noted', id: first.id });
  assert.deepEqual((await notes(first.id!)).map((n: any) => n.summary), ['seen 2 more times']);
  assert.equal((await cards()).length, 1);
});

test('fault_file writes nothing for a text the caller held back', async () => {
  const { file, cards, notes } = await board();
  assert.deepEqual(await file({ title: null, body: null }), { action: 'none', id: null });
  assert.equal((await cards()).length, 0);
  const { id } = await file();
  assert.deepEqual(await file({ seen: null }), { action: 'held', id });
  assert.equal((await notes(id!)).length, 0);
});

test('fault_file leaves a cancelled card alone, calls an older fault fixed, and files a newer one again', async () => {
  const { sql, file, cards } = await board();
  const { id } = await file();
  await sql`select cb.task_move(${String(id)}, 'cancelled', null, 'ahmed')`;
  assert.deepEqual(await file(), { action: 'cancelled', id });
  await sql`update cb.tasks set status = 'done', done_at = now() where id = ${id}`;
  assert.deepEqual(await file({ last: '2000-01-01T00:00:00Z' }), { action: 'fixed', id });
  const again = await file({ last: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(again.action, 'filed');
  assert.equal((await cards()).at(-1)!.body, `It crashes.\n\nSeen again after #${id} was done.\n\nFacts\n${MARK}`);
});

test('fault_file never writes on another project\'s card, and refuses a marker that would match any card', async () => {
  const { sql, file, notes } = await board();
  const [{ id: other }] = await sql`select cb.task_add(project => 'demo', title => 'quotes the marker', body => ${MARK}, status => 'next', actor => 'W1@test') as id`;
  assert.equal((await file()).action, 'filed');
  assert.equal((await notes(other)).length, 0);
  for (const tmpl of ['', 'ft-', 'ft-0123456789AB', `${TMPL}x`]) await assert.rejects(file({ tmpl }), /not a fault template/);
  await assert.rejects(file({ facts: 'Facts without it' }), /must carry its marker/);
});

test('the runner\'s reads and its reconcile take their lists as jsonb', async () => {
  const { sql } = await board();
  const runner = postgres(TEST_URL, { onnotice: () => {}, max: 1, connection: { application_name: 'cb-runner/test' } }); clients.push(runner);
  assert.equal((await runner`select cb.runner_settings('pc') as s`)[0].s, null);
  await runner`select cb.runner_hello('pc', 'http://h:1', ${runner.json([])})`;
  await sql`update cb.runners set slots_set = 6, stack_gap_set = 45 where name = 'pc'`;
  assert.deepEqual((await runner`select cb.runner_settings('pc') as s`)[0].s, { slots_set: 6, lanes_set: null, stack_gap_set: 45 });
  const add = async (state: string) => (await sql`insert into cb.jobs (project, recipe, sha, requester, runner, state)
    values ('demo', 'test', ${'a'.repeat(40)}, 'W1@test', 'pc', ${state}) returning id`)[0].id as number;
  const held = await add('running'), lost = await add('running'), stopped = await add('cancelled');
  assert.deepEqual((await runner`select * from cb.jobs_cancelled(${runner.json([Number(held), Number(stopped)])})`).map((j: any) => String(j.id)), [String(stopped)]);
  assert.equal((await runner`select cb.runner_reconcile_held('pc', ${runner.json([Number(held)])}) as n`)[0].n, 1);
  const states = await sql`select id, state from cb.jobs where id in ${sql([held, lost])} order by id`;
  assert.equal(states[0].state, 'running');
  assert.notEqual(states[1].state, 'running');
});

test('the reads of the supervisor: projects with a squad, sessions seen in the last 90 s, earlier saved squads', async () => {
  const { sql } = await board();
  await sql`select cb.ensure_project('zed'), cb.ensure_project('bare')`;
  await sql`update cb.projects set squad = '{}'::jsonb where slug in ('zed', 'demo')`;
  assert.deepEqual((await sql`select * from cb.supervised_projects()`).map((r: any) => r.slug), ['demo', 'zed']);

  await sql`select cb.iam('pc', 'p1', 'W1@pc', 'demo'), cb.iam('mac', 'p2', 'W2@mac', 'zed')`;
  await sql`update cb.sessions set last_seen = now() - interval '91 seconds' where actor = 'W1@pc'`;
  assert.deepEqual((await sql`select * from cb.sessions_live()`).map((r: any) => ({ ...r })), [{ actor: 'W2@mac', machine: 'mac' }]);

  const saved = (project: string, summary: string, i: number) => sql`insert into cb.events (actor, project, kind, summary, data)
    values ('ahmed', ${project}, 'updated', ${summary}, ${sql.json({ squad: { i } })})`;
  for (let i = 1; i <= 22; i++) await saved('demo', 'squad updated', i);
  await saved('zed', 'squad updated', 99);
  await saved('demo', 'something else', 98);
  assert.deepEqual((await sql`select * from cb.squad_history('demo')`).map((r: any) => r.squad.i), Array.from({ length: 20 }, (_, k) => 22 - k));
});
