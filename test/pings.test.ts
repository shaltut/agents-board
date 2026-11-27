import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

// "Why is this card not moving?": opt-in per card; an hour of silence, then every 30 minutes, to the worker and its orchestrator.
test('pings_due: stale pinged cards ask their worker and orchestrator every 30 minutes until something happens', async () => {
  const sql = await freshDb(); clients.push(sql); // the dashboard connection (cb-web)
  await sql`select cb.ensure_project('demo')`; // cb.iam refuses a project that does not exist
  await sql`select cb.iam('pc', 'p1', 'W1@pc', 'demo')`;
  await sql`select cb.iam('pc', 'p2', 'orch@pc', 'demo')`;
  await sql`select cb.task_add(project => 'demo', title => 'Fix the thing', status => 'in_progress', assignee => 'W1@pc', actor => 'W1@pc')`;
  const age = (mins: number) => sql`update cb.tasks set updated_at = now() - ${mins + ' minutes'}::interval where id = 1`
    .then(() => sql`update cb.events set at = now() - ${mins + ' minutes'}::interval where task_id = 1 and not (data ? 'nudge')`);
  const sent = async () => (await sql`select data ->> 'to' as to_, summary from cb.events where data ? 'nudge' order by id`) as any[];

  // not opted in: silence is not pinged
  await age(120);
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 0);

  // only the dashboard opts a card in
  const session = postgres(TEST_URL, { onnotice: () => {} }); clients.push(session);
  await assert.rejects(() => session`select cb.task_ping_set('1', true, 'W1@pc')`, /only Ahmed/);
  await sql`select cb.task_ping_set('1', true, 'ahmed')`;

  // 30 minutes idle: under the hour, nothing yet
  await age(30);
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 0);

  // 2 hours idle: the worker and the orchestrator, once
  await age(120);
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 2);
  let m = await sent();
  assert.deepEqual(m.map((x) => x.to_).sort(), ['W1@pc', 'orch@pc']);
  assert.match(m.find((x) => x.to_ === 'W1@pc').summary, /#1 "Fix the thing" \(in_progress\) has had no update for 2h 0m\. Why is it not moving\?.*cb log 1/);
  assert.match(m.find((x) => x.to_ === 'orch@pc').summary, /assigned to W1@pc/);

  // not again within 30 minutes; the board's own asks do not count as an update
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 0);
  await sql`update cb.task_pings set last_ping_at = now() - interval '31 minutes'`;
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 2);

  // a note on the card is an update: the pings stop until another quiet hour
  await sql`update cb.task_pings set last_ping_at = now() - interval '31 minutes'`;
  await sql`select cb.log('demo', 'on it, waiting for CI', '1', '{}', 'W1@pc')`;
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 0);

  // #4665: a card in review waits on Ahmed by definition: never asked about; back in progress it is again. Turning the
  // option off stops it
  await age(120);
  await sql`update cb.task_pings set last_ping_at = null`;
  await sql`select cb.task_move('1', 'review', null, 'W1@pc')`;
  await age(120);
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 0, 'review: waiting on Ahmed');
  await sql`select cb.task_move('1', 'in_progress', null, 'W1@pc')`;
  await age(120);
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 2);
  await sql`update cb.task_pings set last_ping_at = null`;
  await sql`select cb.task_move('1', 'done', null, 'W1@pc')`;
  await age(120);
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 0, 'a done card is never asked about');
  await sql`select cb.task_move('1', 'next', null, 'W1@pc')`;
  await age(120);
  await sql`select cb.task_ping_set('1', false, 'ahmed')`;
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 0);
});

test('task_ping_bulk: many cards at once, by ids or a whole project; unassigned cards ask the orchestrator only', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`; // cb.iam refuses a project that does not exist
  await sql`select cb.iam('pc', 'p2', 'orch@pc', 'demo')`;
  for (const [t, st] of [['A', 'backlog'], ['B', 'next'], ['C', 'blocked'], ['D', 'done']])
    await sql`select cb.task_add(project => 'demo', title => ${t}, status => ${st}, actor => 'orch@pc')`;
  await sql`update cb.tasks set updated_at = now() - interval '3 hours', assignee = '' where id = 1`; // cards made unassigned hold ''
  await sql`update cb.tasks set updated_at = now() - interval '3 hours'`;
  await sql`update cb.events set at = now() - interval '3 hours'`;
  const session = postgres(TEST_URL, { onnotice: () => {} }); clients.push(session);
  await assert.rejects(() => session`select cb.task_ping_bulk(null, 'demo', true, 'orch@pc')`, /only Ahmed/);
  await assert.rejects(() => sql`select cb.task_ping_bulk(null, null, true, 'ahmed')`, /say which cards/);
  assert.equal((await sql`select cb.task_ping_bulk(${sql.json([1, 2])}, null, true, 'ahmed') as n`)[0].n, 2);
  assert.equal((await sql`select cb.task_ping_bulk(null, 'demo', true, 'ahmed') as n`)[0].n, 1, 'C only: A and B were on, D is done');
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 2, 'one line per card to the orchestrator; nobody is assigned; #4665: A, unassigned backlog, is parked');
  const m = await sql`select summary from cb.events where data ? 'nudge' order by id`;
  assert.match(m.find((x) => x.summary.includes('"B"'))?.summary ?? '', /"B" \(unassigned, next\) has had no update for 3h 0m\./, 'no "assigned to ," and no session-gone note for a card nobody holds');
  assert.ok(!m.some((x) => x.summary.includes('"A"')), '#4665: an unassigned backlog card is parked, not asked about');
  assert.equal((await sql`select cb.task_ping_bulk(null, 'demo', false, 'ahmed') as n`)[0].n, 3);
  assert.equal((await sql`select count(*)::int as n from cb.task_pings`)[0].n, 0);
});

test('pings_due: a worker whose session is gone is not pinged, its orchestrator is told so', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`; // cb.iam refuses a project that does not exist
  await sql`select cb.iam('pc', 'p1', 'W1@pc', 'demo')`;
  await sql`select cb.iam('pc', 'p2', 'orch@pc', 'demo')`;
  await sql`select cb.task_add(project => 'demo', title => 'Stuck', status => 'in_progress', assignee => 'W1@pc', actor => 'W1@pc')`;
  await sql`update cb.sessions set last_seen = now() - interval '1 hour' where actor = 'W1@pc'`;
  await sql`update cb.tasks set updated_at = now() - interval '3 hours' where id = 1`;
  await sql`update cb.events set at = now() - interval '3 hours' where task_id = 1`;
  await sql`select cb.task_ping_set('1', true, 'ahmed')`;
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 1);
  const [m] = await sql`select data ->> 'to' as to_, summary from cb.events where data ? 'nudge'`;
  assert.equal(m.to_, 'orch@pc');
  assert.match(m.summary, /its session has not checked in for 10 minutes/);
});

// #3746: the lead's copy goes to the project's lead-role session, whatever its name; bound elsewhere, it leads elsewhere
for (const [who, role, bound, leads] of [['QO@pc', 'lead', 'p', true], ['QO@pc', 'lead', 'q', false], ['orch@pc', null, 'p', true]] as [string, string | null, string, boolean][]) {
  test(`pings_due: ${who} (role ${role ?? 'unset'}) bound to ${bound} ${leads ? 'gets' : 'does not get'} the lead's copy for a card in p`, async () => {
    const sql = await freshDb(); clients.push(sql);
    await sql`select cb.ensure_project('p'), cb.ensure_project('q')`;
    await sql`select cb.iam('pc', 'p1', 'W1@pc', 'p')`;
    await sql`select cb.iam('pc', 'p2', ${who}, 'p', ${role})`;
    if (bound !== 'p') await sql`select cb.iam('pc', 'p2', ${who}, ${bound})`;
    await sql`select cb.task_add(project => 'p', title => 'Stuck', status => 'in_progress', assignee => 'W1@pc', actor => 'W1@pc')`;
    await sql`update cb.tasks set updated_at = now() - interval '3 hours' where id = 1`;
    await sql`update cb.events set at = now() - interval '3 hours' where task_id = 1`;
    await sql`select cb.task_ping_set('1', true, 'ahmed')`;
    await sql`select cb.pings_due()`;
    const to = (await sql`select data ->> 'to' as to_ from cb.events where data ? 'nudge' order by id`).map((x: any) => x.to_);
    assert.deepEqual(to.sort(), leads ? ['W1@pc', who].sort() : ['W1@pc']);
  });
}

// #4665: an in_progress card nobody holds is asked about once per quiet stretch, with the fix (move it back or assign it),
// not every 30 minutes; an assigned backlog card is still asked about
test('pings_due: an unowned in_progress card is asked about once, with the fix; an assigned backlog card still is', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('pc', 'p1', 'W1@pc', 'demo')`;
  await sql`select cb.iam('pc', 'p2', 'orch@pc', 'demo')`;
  await sql`select cb.task_add(project => 'demo', title => 'Orphan', status => 'in_progress', actor => 'orch@pc')`;
  await sql`select cb.task_add(project => 'demo', title => 'Mine later', status => 'backlog', assignee => 'W1@pc', actor => 'orch@pc')`;
  await sql`update cb.tasks set updated_at = now() - interval '3 hours', assignee = case when id = 1 then '' else assignee end`; // task_add gives an in_progress card to its maker; unassigned holds ''
  await sql`update cb.events set at = now() - interval '3 hours'`;
  await sql`select cb.task_ping_bulk(null, 'demo', true, 'ahmed')`;
  const orphans = async () => (await sql`select count(*)::int as n from cb.events where data ? 'nudge' and summary like '%Orphan%'`)[0].n;
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 3, 'orphan: the lead; assigned backlog: the worker and the lead');
  const [o] = await sql`select summary from cb.events where data ? 'nudge' and summary like '%Orphan%'`;
  assert.match(o.summary, /nobody holds it: move it back \(cb move 1 next\) or assign it/);
  await sql`update cb.task_pings set last_ping_at = now() - interval '31 minutes'`;
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 2, 'the orphan once only; the assigned backlog card again');
  assert.equal(await orphans(), 1);
  // asked (2.5 h ago), then an update (2 h ago), then quiet: a new stretch, asked once more
  await sql`select cb.log('demo', 'looked at it', '1', '{}', 'orch@pc')`;
  await sql`update cb.tasks set updated_at = now() - interval '2 hours' where id = 1`;
  await sql`update cb.events set at = now() - interval '2 hours' where task_id = 1 and not (data ? 'nudge')`;
  await sql`update cb.task_pings set last_ping_at = now() - interval '150 minutes' where task_id = 1`;
  await sql`select cb.pings_due()`;
  assert.equal(await orphans(), 2);
});
