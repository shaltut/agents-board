// #3222 S1b: the functions the SQL of the relay, the hooks, jobs and stage words became. Their own suites pin what each
// of those does; this pins what only the functions can get wrong.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { call } from '../cli/board.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

async function board() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('pc', 'p1', 'B1@pc', 'demo', 'builder')`;
  await sql`select cb.iam('pc', 'p2', 'orch@pc', 'demo', 'lead')`;
  await sql`select cb.inbox('pc', 'p2', 0)`; // the lead's relay was just here
  return sql;
}

test('inbox_ping returns what inbox returns and sends the pane\'s ping, built on the board', async () => {
  const sql = await board();
  const other = postgres(TEST_URL, { onnotice: () => {}, max: 1 }); clients.push(other);
  const heard: string[] = [];
  await other.listen('cb_bind', (p) => { heard.push(p); });
  const i = await call('inbox_ping', { machine: 'pc', pane: 'p1', after_event: 0, session: null, n: 7 }, sql);
  assert.deepEqual([i.actor, i.project], ['B1@pc', 'demo']);
  const [{ plain }] = await sql`select cb.inbox('pc', 'p1', 0) as plain`;
  assert.deepEqual(Object.keys(i).sort(), Object.keys(plain).sort());
  for (const end = Date.now() + 5000; !heard.includes('ping:pc:p1#7') && Date.now() < end;) await new Promise((r) => setTimeout(r, 25));
  assert.ok(heard.includes('ping:pc:p1#7'), `heard ${JSON.stringify(heard)}`);
});

test('work_still_open takes its card numbers through call(), as an array', async () => {
  const sql = await board();
  const [{ id }] = await sql`select cb.task_add(project => 'demo', title => 'Fix month parse', status => 'next', actor => 'B1@pc') as id`;
  const open = await call('work_still_open', { ids: `{${id},999999}`, actor: 'B1@pc' }, sql);
  assert.deepEqual(open.map(Number), [Number(id)]);
  assert.deepEqual(await call('work_still_open', { ids: '{}', actor: 'B1@pc' }, sql), []);
});

test('refusal_targets names the seat bound in the pane and who is told; nothing for an unknown pane', async () => {
  await board();
  const sql = clients.at(-1);
  assert.deepEqual(await call('refusal_targets', { machine: ' PC ', pane: ' p1 ' }, sql),
    { actor: 'B1@pc', project: 'demo', to: ['orch@pc'] });
  assert.equal(await call('refusal_targets', { machine: 'pc', pane: 'p9' }, sql), null);
  await sql`select cb.inbox('pc', 'p3', 0)`; // a relay's own row: no name given, no project yet
  assert.equal((await call('refusal_targets', { machine: 'pc', pane: 'p3' }, sql)).project, null);
});

test('resume_for_pane is cb.resume of the pane\'s name, and null for a pane bound to no project', async () => {
  const sql = await board();
  const r = await call('resume_for_pane', { machine: 'pc', pane: 'p1' }, sql);
  assert.deepEqual(r, (await sql`select cb.resume('B1@pc') as r`)[0].r);
  await sql`select cb.inbox('pc', 'p3', 0)`;
  assert.equal(await call('resume_for_pane', { machine: 'pc', pane: 'p3' }, sql), null);
  assert.equal(await call('resume_for_pane', { machine: 'pc', pane: 'p9' }, sql), null);
});

test('job_log_url is the address the runner announced, null for an unknown runner', async () => {
  const sql = await board();
  const runner = postgres(TEST_URL, { onnotice: () => {}, max: 1, connection: { application_name: 'cb-runner' } }); clients.push(runner);
  await runner`select cb.runner_hello('box', 'http://100.64.0.1:4748/', '[]'::jsonb)`;
  assert.equal(await call('job_log_url', { runner: 'box' }, sql), 'http://100.64.0.1:4748/');
  assert.equal(await call('job_log_url', { runner: 'nobody' }, sql), null);
});

test('stage_words_for answers in the order asked, with null where no stage is shown', async () => {
  const sql = await board();
  await sql`select cb.ensure_project('old')`;
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  const want = async (stage: string) => (await sql`select cb._stage_words(${stage}) as w`)[0].w;
  assert.deepEqual(await call('stage_words_for', { pairs: [['demo', 'review'], ['old', 'build'], ['demo', 'build']] }, sql),
    [await want('review'), null, await want('build')]);
  assert.deepEqual(await call('stage_words_for', { pairs: [] }, sql), []);
});
