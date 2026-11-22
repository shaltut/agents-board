import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

// demo has the pipeline on; B1 builds (live), card 1 is staged at build and held in progress by B1
async function setup(o: { type?: string } = {}) {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p2','B1@mac','demo','builder'), ('pc','p4','orch@pc','demo',null)`;
  await sql`select cb.task_add(project => 'demo', title => 'Fix the thing', type => ${o.type ?? 'bug'}, stage => ${o.type === 'research' ? null : 'build'}, why => 'small', actor => 'orch@pc')`;
  await sql`update cb.tasks set status = 'in_progress', assignee = 'B1@mac' where id = 1`;
  const age = (mins: number) => sql`update cb.tasks set updated_at = now() - ${mins + ' minutes'}::interval where id = 1`
    .then(() => sql`update cb.events set at = now() - ${mins + ' minutes'}::interval where (task_id = 1 or actor = 'B1@mac') and not (data ? 'nudge')`);
  const nudges = async () => (await sql`select data ->> 'to' as to_, summary from cb.events where data ? 'stall' and kind = 'message' order by id`) as any[];
  const due = async () => (await sql`select cb.stage_stalls_due() as n`)[0].n;
  return { sql, age, nudges, due };
}

test('a quiet card is nudged at 30 minutes and freed at 90 if nobody answers', async () => {
  const { sql, age, nudges, due } = await setup();
  await age(20);
  assert.equal(await due(), 0);
  await age(31);
  assert.equal(await due(), 1);
  let m = await nudges();
  assert.equal(m.length, 1);
  assert.equal(m[0].to_, 'B1@mac');
  assert.match(m[0].summary, /#1 "Fix the thing" has had no update for 0h 31m at Building\. Say where it stands \(cb log 1 "\.\.\."\) or it goes back to the queue in an hour\./);
  assert.equal(await due(), 0, 'one nudge only');
  await age(91);
  await sql`update cb.stage_nudges set nudged_at = now() - interval '60 minutes'`;
  assert.equal(await due(), 2, 'a note to the holder and the release');
  const [t] = await sql`select status, assignee, stage from cb.tasks where id = 1`;
  assert.deepEqual({ ...t }, { status: 'next', assignee: null, stage: 'build' });
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = 1 and summary like 'freed from B1@mac: %'`)[0].n, 1);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = 1 and kind = 'message' and summary like '#1 went back to the queue: %' and data ->> 'to' = 'B1@mac'`)[0].n, 1);
  assert.equal((await sql`select count(*)::int n from cb.stage_nudges`)[0].n, 0);
});

test('work elsewhere is not quiet', async () => {
  const { sql, age, due } = await setup();
  await age(31);
  assert.equal(await due(), 1);
  await sql`select cb.task_add(project => 'demo', title => 'other', actor => 'B1@mac')`; // holder acts on another card
  await age(91);
  await sql`update cb.events set at = now() - interval '50 minutes' where actor = 'B1@mac' and task_id = 2`;
  await sql`update cb.stage_nudges set nudged_at = now() - interval '45 minutes'`;
  assert.equal(await due(), 0);
  assert.equal((await sql`select assignee from cb.tasks where id = 1`)[0].assignee, 'B1@mac');
});

test('a session that is down keeps its cards (Q2324)', async () => {
  const { sql, age, nudges, due } = await setup();
  await sql`update cb.sessions set last_seen = now() - interval '3 hours' where actor = 'B1@mac'`;
  await age(180);
  assert.equal(await due(), 0);
  assert.equal((await nudges()).length, 0);
  await sql`update cb.tasks set status = 'next' where id = 1`; // a hold
  await age(180);
  assert.equal(await due(), 0);
  assert.equal((await sql`select assignee from cb.tasks where id = 1`)[0].assignee, 'B1@mac');
});

test('a hold whose live holder is quiet for 90 minutes is released', async () => {
  const { sql, age, due } = await setup();
  await sql`update cb.tasks set status = 'next' where id = 1`;
  await age(89);
  assert.equal(await due(), 0);
  await age(91);
  assert.equal(await due(), 2, 'the release and its message');
  const [t] = await sql`select status, assignee from cb.tasks where id = 1`;
  assert.deepEqual({ ...t }, { status: 'next', assignee: null });
});

test('a released card goes to the head of Next', async () => {
  const { sql, age, due } = await setup();
  await sql`select cb.task_add(project => 'demo', title => 'queued', status => 'next', actor => 'orch@pc')`;
  const [{ r }] = await sql`select rank as r from cb.tasks where id = 2`;
  await age(91);
  await sql`insert into cb.stage_nudges (task_id, nudged_at) values (1, now() - interval '60 minutes')`;
  await due();
  assert.ok(Number((await sql`select rank from cb.tasks where id = 1`)[0].rank) < Number(r));
});

test('approval, investigation and non-pipeline cards are never touched', async () => {
  const { sql, age, nudges, due } = await setup({ type: 'research' });
  await age(180);
  assert.equal(await due(), 0);
  assert.equal((await nudges()).length, 0);
  assert.equal((await sql`select assignee from cb.tasks where id = 1`)[0].assignee, 'B1@mac');
  // a card waiting at approval, held by its designer
  await sql`select cb.task_add(project => 'demo', title => 'wait', type => 'bug', stage => 'build', why => 'small', actor => 'orch@pc')`;
  await sql`select cb._stage_move(2, 'approval', 'B1@mac', 'design done')`;
  await sql`update cb.tasks set updated_at = now() - interval '5 hours' where id = 2`;
  // a card in a project without the pipeline
  await sql`select cb.ensure_project('old')`;
  await sql`select cb.task_add(project => 'old', title => 'plain', status => 'in_progress', assignee => 'B1@mac', actor => 'B1@mac')`;
  await sql`update cb.tasks set updated_at = now() - interval '5 hours' where id = 3`;
  await sql`update cb.events set at = now() - interval '5 hours'`;
  assert.equal(await due(), 0);
});

test('nudge rows of cards that left the pipeline are cleaned up', async () => {
  const { sql, due } = await setup();
  await sql`insert into cb.stage_nudges (task_id, nudged_at) values (1, now())`;
  await sql`update cb.tasks set stage = null where id = 1`;
  await due();
  assert.equal((await sql`select count(*)::int n from cb.stage_nudges`)[0].n, 0);
});
