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
