import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

test('project_pipeline: only the dashboard switches it, and roles read from sessions', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  const session = postgres(TEST_URL, { onnotice: () => {} }); clients.push(session);
  await assert.rejects(() => session`select cb.project_pipeline('demo', true, 'W1@mac')`, /only Ahmed/);
  assert.equal((await sql`select cb.project_pipeline('demo', true, 'ahmed') as r`)[0].r, true);
  assert.equal((await sql`select cb._pipeline('demo') as r`)[0].r, true);
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area) values ('mac','p1','W1@mac','demo','builder',null), ('pc','p2','orch@pc','demo',null,null)`;
  assert.equal((await sql`select cb._role('W1@mac') as r`)[0].r, 'builder');
  assert.equal((await sql`select cb._role('orch@pc') as r`)[0].r, 'lead');
  await sql`insert into cb.tasks (project, title) values ('demo', 'x')`;
  await assert.rejects(() => sql`update cb.tasks set stage = 'coding'`, /stage/);
});

test('_role picks the most recently seen session, _area reads the stored area, project_pipeline off leaves a note', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area, last_seen) values
    ('mac','p1','W1@mac','demo','builder','claims', now() - interval '1 hour'),
    ('mac','p2','W1@mac','demo','reviewer','preauth', now())`;
  assert.equal((await sql`select cb._role('W1@mac') as r`)[0].r, 'reviewer');
  assert.equal((await sql`select cb._area('W1@mac') as r`)[0].r, 'preauth');
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  assert.equal((await sql`select cb._pipeline('demo') as r`)[0].r, false);
  assert.equal((await sql`select count(*)::int as n from cb.events where kind = 'note' and summary = 'pipeline off for demo'`)[0].n, 1);
});

test('iam: stores role, area and model; rejects an unknown role; keeps them on a plain re-bind', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('mac', 'p1', 'W1@mac', 'demo', role => 'builder', area => 'Claims RI', model => 'sonnet')`;
  assert.equal((await sql`select cb._role('W1@mac') as r`)[0].r, 'builder');
  assert.equal((await sql`select cb._area('W1@mac') as r`)[0].r, 'claims-ri');
  await assert.rejects(() => sql`select cb.iam('mac', 'p1', 'W1@mac', null, role => 'boss')`, /one of lead, architect, owner, builder, reviewer, qa, investigator/);
  await sql`select cb.iam('mac', 'p1', 'W1@mac')`;
  assert.equal((await sql`select cb._role('W1@mac') as r`)[0].r, 'builder');
  const [row] = await sql`select role, area, model from cb.sessions where actor = 'W1@mac'`;
  assert.deepEqual({ ...row }, { role: 'builder', area: 'claims-ri', model: 'sonnet' });
  const [o] = (await sql`select cb.sessions_overview('demo') as r`)[0].r.filter((x: any) => x.actor === 'W1@mac');
  assert.deepEqual([o.role, o.area, o.model], ['builder', 'claims-ri', 'sonnet']);
});

// demo has the pipeline on; O1 owns area claims, B1 builds, R1 reviews, orch@pc leads, Q1 is qa
async function setup() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area) values
    ('mac','p1','O1@mac','demo','owner','claims'), ('mac','p2','B1@mac','demo','builder',null),
    ('mac','p3','R1@mac','demo','reviewer',null), ('pc','p4','orch@pc','demo',null,null), ('mac','p5','Q1@mac','demo','qa',null)`;
  return sql;
}
const card = async (sql: any, o: { type?: string; status?: string; actor?: string } = {}) =>
  Number((await sql`select cb.task_add(project => 'demo', title => 'c', type => ${o.type ?? 'bug'}, status => ${o.status ?? 'next'}, actor => ${o.actor ?? 'B1@mac'}) as id`)[0].id);

test('new cards start at design; PR cards stay unstaged', async () => {
  const sql = await setup();
  const add = async (extra: any) => (await sql`select t.stage, t.status, t.stage_since is not null as since from cb.tasks t where t.id = ${Number((await sql`select cb.task_add(project => 'demo', title => 'x', actor => ${extra.actor ?? 'B1@mac'}, status => ${extra.status ?? null}, type => ${extra.type ?? null}) as id`)[0].id)}`)[0];
  assert.deepEqual({ ...(await add({})) }, { stage: 'design', status: 'next', since: true });
  assert.deepEqual({ ...(await add({ status: 'backlog' })) }, { stage: 'design', status: 'backlog', since: true });
  assert.equal((await add({ actor: 'github' })).stage, null);
  assert.equal((await add({ type: 'research' })).stage, null);
  await sql`select cb.ensure_project('old')`;
  const [{ id: oid }] = await sql`select cb.task_add(project => 'old', title => 'x', actor => 'B1@mac') as id`;
  const [o] = await sql`select t.stage, t.status from cb.tasks t where t.id = ${oid}`;
  assert.deepEqual({ ...o }, { stage: null, status: 'backlog' });
  await assert.rejects(() => sql`select cb.task_add(project => 'old', title => 'x', stage => 'build', why => 'y', actor => 'orch@pc')`, /pipeline/);
});

test('small found work goes to build only from the lead, with a reason', async () => {
  const sql = await setup();
  const bug = await card(sql);
  await assert.rejects(() => sql`select cb.stage_set(${bug}, 'build', 'one-line fix', 'B1@mac')`, /lead/);
  await assert.rejects(() => sql`select cb.stage_set(${bug}, 'build', null, 'orch@pc')`, /why/);
  const feat = await card(sql, { type: 'feature' });
  await assert.rejects(() => sql`select cb.stage_set(${feat}, 'build', 'small', 'orch@pc')`, /bug or chore/);
  const claimed = await card(sql);
  await sql`update cb.tasks set assignee = 'B1@mac', status = 'in_progress' where id = ${claimed}`;
  await assert.rejects(() => sql`select cb.stage_set(${claimed}, 'build', 'small', 'orch@pc')`, /unclaimed/);
  await sql`select cb.stage_set(${bug}, 'build', 'one-line fix', 'orch@pc')`;
  assert.equal((await sql`select stage from cb.tasks where id = ${bug}`)[0].stage, 'build');
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${bug} and data ->> 'small' = 'true' and summary = 'small work, skipped design: one-line fix'`)[0].n, 1);
  const [{ id }] = await sql`select cb.task_add(project => 'demo', title => 'direct', stage => 'build', why => 'one-line fix', type => 'bug', actor => 'orch@pc') as id`;
  assert.equal((await sql`select stage from cb.tasks where id = ${id}`)[0].stage, 'build');
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and data ->> 'small' = 'true'`)[0].n, 1);
  const des = await card(sql);
  await assert.rejects(() => sql`select cb.stage_set(${des}, 'none', 'restart only', 'B1@mac')`, /lead/);
  await sql`select cb.stage_set(${des}, 'none', 'restart only', 'orch@pc')`;
  assert.equal((await sql`select stage from cb.tasks where id = ${des}`)[0].stage, null);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${des} and data ->> 'unstaged' = 'true'`)[0].n, 1);
});

test('sessions_overview reports the stored role when the pipeline is off', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.sessions (machine, pane, actor, project) values ('pc','p1','orch@pc','demo')`;
  const role = async () => (await sql`select cb.sessions_overview('demo') as r`)[0].r.find((x: any) => x.actor === 'orch@pc').role;
  assert.equal(await role(), null);
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  assert.equal(await role(), 'lead');
});
