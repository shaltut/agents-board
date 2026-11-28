// #4353: cb.sessions_overview built each session's row three times: the planner copied the row expression, with all its
// per-actor subqueries, into both sort keys. It must build each once, and give the same rows in the same order.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

async function setup() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo'), cb.ensure_project('other')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, last_seen) values
    ('pc', 'p1', 'W2@pc', 'demo', 'builder', now()), ('pc', 'p2', 'W1@pc', 'demo', 'builder', now() - interval '1 hour'),
    ('pc', 'p3', 'orch@pc', 'demo', 'lead', now()), ('pc', 'p4', 'X1@pc', 'other', null, now())`;
  await sql`select cb.task_add(project => 'demo', title => 'doing', status => 'in_progress', assignee => 'W1@pc', actor => 'orch@pc')`;
  await sql`select cb.task_add(project => 'demo', title => 'queued', status => 'next', assignee => 'W2@pc', actor => 'orch@pc')`;
  await sql`select cb.log('demo', 'a note', null, '{}', 'Gone@pc')`; // an actor known only by its events
  return sql;
}

test('sessions_overview builds each session once', async () => {
  const sql = await setup();
  for (const project of [null, 'demo']) {
    const { rows, calls } = await sql.begin(async (tx) => {
      await tx`set local track_functions = 'all'`;
      // the view also holds this connection's not yet flushed calls from earlier transactions: count the difference
      const count = async () => (await tx`select coalesce(sum(calls), 0)::int as n from pg_stat_xact_user_functions where schemaname = 'cb' and funcname = '_is_lead'`)[0].n;
      const before = await count();
      const [{ o }] = await tx`select cb.sessions_overview(${project}) as o`;
      return { rows: (o as any[]).length, calls: (await count()) - before };
    });
    assert.ok(rows >= 4, `${rows} rows`);
    assert.equal(calls, rows, `project ${project}: cb._is_lead runs once per row`);
  }
});

// the oracle: the same function without the fence, so the planner is free to copy the row expression as before
test('sessions_overview gives the same rows in the same order as without its fence: live first, then by name', async () => {
  const sql = await setup();
  const [{ def }] = await sql`select pg_get_functiondef('cb.sessions_overview(text)'::regprocedure) as def`;
  const oracle = (def as string).replace('cb.sessions_overview(', 'pg_temp.overview_oracle(').replace(/^\s*offset 0\b.*$/m, '');
  assert.notEqual(oracle.includes('offset 0'), true);
  const one = await sql.reserve();
  try {
    await one.unsafe(oracle);
    for (const project of [null, 'demo', 'other']) {
      const [r] = await one`select cb.sessions_overview(${project}) as now, pg_temp.overview_oracle(${project}) as was`;
      assert.deepEqual(r.now, r.was, `project ${project}`);
    }
    const [{ o }] = await one`select cb.sessions_overview('demo') as o`;
    assert.deepEqual((o as any[]).map((x) => [x.actor, x.live]),
      [['W2@pc', true], ['orch@pc', true], ['Gone@pc', false], ['W1@pc', false]]);
  } finally { one.release(); }
});
