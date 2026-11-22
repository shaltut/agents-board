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
