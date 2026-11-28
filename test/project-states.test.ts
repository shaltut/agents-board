// Project states (#4559, slice 1): enabled, disabled, archived. Who changes it, every rule that stops handing out work,
// the quiet clocks, filing, the notices, the runner and the supervisor's read, the server and the CLI words. Made-up
// project names; real test database, in the style of test/projects.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
const conn = (app: string) => { const c = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: app } }); clients.push(c); return c; };

/** cedar (the one we disable) and atlas (stays enabled). W1 and W2 work in cedar (W1 holds #1), A1 in atlas. */
async function setup() {
  const sql = await freshDb(); clients.push(sql); // cb-web: Ahmed's dashboard
  await sql`select cb.ensure_project('cedar'), cb.ensure_project('atlas')`;
  await sql`insert into cb.sessions (machine, pane, actor, project) values ('pc','p1','W1@pc','cedar'), ('pc','p2','W2@pc','cedar'), ('pc','p3','A1@pc','atlas')`;
  await sql`select cb.task_add(project => 'cedar', title => 'held card', status => 'in_progress', assignee => 'W1@pc', actor => 'W1@pc')`;   // #1
  await sql`select cb.task_add(project => 'cedar', title => 'waiting card', status => 'next', actor => 'W2@pc')`;                          // #2
  await sql`select cb.task_add(project => 'atlas', title => 'atlas card', status => 'next', actor => 'A1@pc')`;                            // #3
  const session = conn('claude-session');
  const set = (state: string, project = 'cedar') => sql`select cb.project_state(${project}, ${state}, 'ahmed') as r`.then((r: any) => r[0].r);
  return { sql, session, set };
}

test('project_state: only exactly ahmed, from his dashboard; enabled <-> disabled <-> archived; archived mirrors the state', async () => {
  const { sql, session, set } = await setup();
  await assert.rejects(session`select cb.project_state('cedar', 'disabled', 'W1@pc')`, /only Ahmed can do this, on the Projects page/);
  await assert.rejects(sql`select cb.project_state('cedar', 'disabled', 'cai')`, /only Ahmed changes a project's state/, 'another admin');
  await assert.rejects(sql`select cb.project_state('cedar', 'disabled', 'Ahmed (boss)')`, /only Ahmed changes a project's state/, 'not ahmed_like');
  await assert.rejects(set('archived'), /Cedar is enabled: disable it first/);
  await assert.rejects(set('paused'), /state must be enabled, disabled or archived/);
  const row = async () => (await sql`select state, state_by, archived, state_at is not null as at from cb.projects where slug = 'cedar'`)[0];

  const d = await set('disabled');
  assert.equal(d.changed, true);
  assert.deepEqual({ ...(await row()) }, { state: 'disabled', state_by: 'ahmed', archived: false, at: true });
  assert.equal((await set('disabled')).changed, false, 'the same state again changes nothing');
  await set('archived');
  assert.deepEqual({ ...(await row()) }, { state: 'archived', state_by: 'ahmed', archived: true, at: true });
  await assert.rejects(set('enabled'), /Cedar is archived: unarchive it first \(it goes back to disabled\)/);
  await set('disabled');
  assert.equal((await row()).archived, false);
  await set('enabled');
  assert.equal((await row()).state, 'enabled');
  const notes = (await sql`select actor, summary, data ->> 'state' as s from cb.events where project = 'cedar' and kind = 'note' and data ? 'state' order by id`) as any[];
  assert.deepEqual(notes.map((n) => n.summary), ['Ahmed disabled Cedar', 'Ahmed archived Cedar', 'Ahmed unarchived Cedar', 'Ahmed enabled Cedar']);
  assert.ok(notes.every((n) => n.actor === 'ahmed'));
});

test('the one-time mapping: a project archived before #4559 is archived; a re-run never archives one Ahmed enabled again', async () => {
  const { sql, set } = await setup();
  const mapping = readFileSync('db/schema.sql', 'utf8').split('\n').find((l) => l.startsWith("update cb.projects set state = 'archived'"))!;
  assert.ok(mapping, 'the mapping line is in the schema');
  await sql`update cb.projects set archived = true where slug = 'atlas'`; // archived by hand, as before
  await sql.unsafe(mapping);
  assert.deepEqual({ ...(await sql`select state, state_by, archived from cb.projects where slug = 'atlas'`)[0] }, { state: 'archived', state_by: 'board', archived: true });
  await set('disabled', 'atlas');
  await set('enabled', 'atlas');
  await sql`update cb.projects set archived = true where slug = 'atlas'`; // even a stray flag
  await sql.unsafe(mapping);
  assert.equal((await sql`select state from cb.projects where slug = 'atlas'`)[0].state, 'enabled');
});

test('disabled: nothing is claimed, previewed, offered or triaged; messages and answers still reach the seat', async () => {
  const { sql, session, set } = await setup();
  const [{ id: bug }] = await session`select cb.task_add(project => 'cedar', title => 'a bug', type => 'bug', status => 'next', actor => 'A1@pc') as id`; // #4
  const [{ q }] = await session`select cb.ask(project => 'cedar', body => 'which way?', actor => 'W2@pc', reply_to => '{"machine":"pc","pane":"p2"}'::jsonb) as q`;
  await set('disabled');
  assert.equal((await session`select * from cb.task_claim('cedar', 'W2@pc')`).length, 0);
  assert.equal((await session`select * from cb.task_queue('cedar', 'W2@pc', null)`).length, 0);
  assert.deepEqual((await session`select cb.work_still_open(array[2, ${bug}]::bigint[], 'W2@pc') as w`)[0].w, []);
  await sql`select cb.tell('W2@pc', 'wrap up please', 'ahmed')`;
  await sql`select cb.answer(${q}, 'left', 'ahmed')`;
  await session`select cb.task_add(project => 'cedar', title => 'new in next', status => 'next', actor => 'A1@pc')`;
  const box = (await session`select cb.inbox('pc', 'p2', 0) as b`)[0].b;
  assert.deepEqual(box.next_work, [], 'no new-work offers');
  assert.deepEqual(box.bugs, [], 'no triage offers');
  assert.ok(box.messages.some((m: any) => m.summary === 'wrap up please'), 'Ahmed still reaches the seat');
  assert.ok(box.answers.some((a: any) => Number(a.id) === Number(q)), 'an answer already given is delivered');
  // the other project is untouched
  assert.equal((await session`select * from cb.task_claim('atlas', 'A1@pc')`)[0].id, '3');
  // enable: the same seat may claim again
  await set('enabled');
  assert.equal((await session`select * from cb.task_claim('cedar', 'W2@pc')`)[0].id, '2');
});

test('brief and tick say so first; with no project given, the disabled project is left out', async () => {
  const { sql, session, set } = await setup();
  await session`select cb.ask(project => 'cedar', body => 'cedar question', actor => 'W2@pc')`;
  await set('disabled');
  const b = (await session`select cb.brief('cedar') as b`)[0].b;
  assert.match(b.disabled, /^Cedar is disabled by Ahmed since \d\d \w{3} \d\d:\d\d UTC: no work is handed out there\. Write where you stopped/);
  assert.equal(b.in_progress.length, 1, 'its own brief keeps its cards');
  assert.equal(b.open_questions.length, 1);
  const all = (await session`select cb.brief(null) as b`)[0].b;
  assert.equal(all.disabled, undefined);
  assert.deepEqual([...all.in_progress, ...all.next].map((t: any) => t.project), ['atlas']);
  assert.equal(all.open_questions.length, 0);
  assert.equal((await session`select cb.brief('atlas') as b`)[0].b.disabled, undefined, 'an enabled project carries no key');
  const t = (await session`select cb.tick('cedar', 'W1@pc') as t`)[0].t;
  assert.match(t.disabled, /^Cedar is disabled/);
  for (const k of ['silent', 'blocked', 'unreviewed', 'misheld', 'idle', 'next', 'huddles', 'prs']) assert.deepEqual(t[k], [], k);
  assert.equal(t.my_questions.length, 0); // W1 asked nothing; the list itself is still read
  const w2 = (await session`select cb.tick('cedar', 'W2@pc') as t`)[0].t;
  assert.equal(w2.my_questions.length, 1, 'my questions stay');
  const none = (await session`select cb.tick(null, 'ahmed') as t`)[0].t;
  assert.deepEqual(none.next.map((x: any) => Number(x.id)), [3]);
});

test('clocks: no reminder or stall while disabled, none straight after enable, and both run again once quiet since the enable', async () => {
  const { sql, set } = await setup();
  await sql`select cb.project_pipeline('cedar', true, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p9','B1@mac','cedar','builder'), ('pc','p4','orch@pc','cedar',null)`;
  await sql`select cb.task_add(project => 'cedar', title => 'staged', type => 'bug', stage => 'build', why => 'small', actor => 'orch@pc')`; // #4
  await sql`update cb.tasks set status = 'in_progress', assignee = 'B1@mac' where id = 4`;
  await sql`select cb.task_ping_set('1', true, 'ahmed')`;
  const age = (mins: number) => sql`update cb.tasks set updated_at = now() - ${mins + ' minutes'}::interval where id in (1, 4)`
    .then(() => sql`update cb.sessions set started_at = now() - ${mins + ' minutes'}::interval`)
    .then(() => sql`update cb.events set at = now() - ${mins + ' minutes'}::interval where not (data ? 'nudge')`);
  const pings = async () => (await sql`select cb.pings_due() as n`)[0].n;
  const stalls = async () => (await sql`select cb.stage_stalls_due() as n`)[0].n;
  await set('disabled');
  await age(180);
  assert.equal(await pings(), 0, 'no reminder while disabled');
  assert.equal(await stalls(), 0, 'no stall nudge or freeing while disabled');
  await sql`update cb.tasks set status = 'next' where id = 4`; // a hold quiet 3 hours: would be freed at once if enabled
  await age(180);
  assert.equal(await stalls(), 0);
  assert.equal((await sql`select assignee from cb.tasks where id = 4`)[0].assignee, 'B1@mac', 'the holder keeps it (Q3017)');
  await set('enabled');
  assert.equal(await pings(), 0, 'enable is no burst');
  assert.equal(await stalls(), 0, 'nothing freed straight after enable');
  // quiet for 2 hours since the enable: the clocks run again (a reset, not a mute)
  await age(180); // the cards and their holders quiet 3 hours (the hold above touched card 4)
  await sql`update cb.projects set state_at = now() - interval '2 hours' where slug = 'cedar'`;
  assert.ok(await pings() >= 1, 'the reminder fires again');
  assert.equal(await stalls(), 2, 'the quiet hold is freed again');
  assert.equal((await sql`select assignee from cb.tasks where id = 4`)[0].assignee, null);
});

test('digest: skipped while disabled; after an enable it covers only the time since then', async () => {
  const { sql, set } = await setup();
  await sql`select cb.project_pipeline('cedar', true, 'ahmed')`;
  await sql`update cb.sessions set role = 'lead' where actor = 'W2@pc'`;
  await sql`select cb.task_add(project => 'cedar', title => 'urgent', priority => 'P0', actor => 'W1@pc')`;
  await set('disabled');
  assert.equal((await sql`select cb.digests_due() as n`)[0].n, 0);
  await set('enabled');
  assert.equal((await sql`select cb.digests_due() as n`)[0].n, 0, 'the first digest waits its 15 minutes from the enable');
  await sql`update cb.projects set state_at = now() - interval '16 minutes' where slug = 'cedar'`;
  assert.equal((await sql`select cb.digests_due() as n`)[0].n, 1);
});

test('filing: a disabled project parks a card in its Backlog; an archived one refuses; ask, iam, huddles and merges are refused in words', async () => {
  const { sql, session, set } = await setup();
  await set('disabled');
  const [{ id }] = await session`select cb.task_add(project => 'cedar', title => 'found a bug', type => 'bug', status => 'in_progress', assignee => 'W1@pc', actor => 'A1@pc') as id`;
  assert.deepEqual({ ...(await sql`select status, assignee from cb.tasks where id = ${id}`)[0] }, { status: 'backlog', assignee: null });
  // the dashboard files as Ahmed chooses
  const [{ id: mine }] = await sql`select cb.task_add(project => 'cedar', title => 'mine', status => 'next', actor => 'ahmed') as id`;
  assert.equal((await sql`select status from cb.tasks where id = ${mine}`)[0].status, 'next');
  await assert.rejects(session`select cb.ask(project => 'cedar', body => 'x?', actor => 'W1@pc')`, /Cedar is disabled by Ahmed .*: nothing is asked there until Ahmed enables it/);
  await assert.rejects(session`select cb.iam('pc', 'p8', 'W8@pc', 'cedar')`, /Cedar is disabled .*: no new seat binds to it/);
  await session`select cb.iam('pc', 'p1', 'W1@pc', 'cedar')`; // already bound there: a re-bind keeps it
  await session`select cb.iam('pc', 'p2', 'W2@pc')`;          // no project named: keeps the pane's
  await assert.rejects(session`select cb.huddle_open('sync', '[]', null, 'W1@pc', 'cedar')`, /Cedar is disabled .*: no new huddle starts there/);
  await assert.rejects(sql`select cb.project_alias('old-cedar-name', 'cedar')`, /Cedar is disabled .*: nothing is merged into it/);
  // wrapping up still works
  await session`select cb.log('cedar', 'stopped at the parser; branch pushed', '1', '{}', 'W1@pc')`;
  await session`select cb.task_move('1', 'next', 'parked', 'W1@pc')`;
  await session`select cb.task_done('2', 'finished', '{}', 'W2@pc')`;
  // archived: refused for everyone, the dashboard too
  await set('archived');
  await assert.rejects(session`select cb.task_add(project => 'cedar', title => 'x', actor => 'A1@pc')`, /Cedar is archived: nothing new goes there\. File it elsewhere/);
  await assert.rejects(sql`select cb.task_add(project => 'cedar', title => 'x', actor => 'ahmed')`, /Cedar is archived/);
  await assert.rejects(session`select cb.task_update('3', '{"project":"cedar"}'::jsonb, 'A1@pc')`, /Cedar is archived: nothing new goes there\. Move it elsewhere/);
});

test('a design passed while disabled still asks for its approval: the stage_pass call is the one exempt ask', async () => {
  const { sql, session, set } = await setup();
  await sql`select cb.project_pipeline('cedar', true, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p7','AR1@mac','cedar','architect')`;
  for (const title of ['design me', 'and me']) // #4 and #5, at design, held by the architect
    await sql`select cb.task_add(project => 'cedar', title => ${title}, type => 'feature', actor => 'W2@pc')`;
  await sql`update cb.tasks set status = 'in_progress', assignee = 'AR1@mac' where id in (4, 5)`;
  for (const id of ['4', '5']) await session`select cb.page_set(task => ${id}, body => '# the design', actor => 'AR1@mac')`;
  await set('disabled');
  await session`select cb.stage_pass('4', 'designed', '{}', 'AR1@mac')`;
  const [q] = await sql`select status, approval_for from cb.questions where task_id = 4`;
  assert.deepEqual({ ...q }, { status: 'open', approval_for: '4' });
  // and the exemption does not outlive that call in the same transaction
  await assert.rejects(session.begin(async (tx: any) => {
    await tx`select cb.stage_pass('5', 'designed', '{}', 'AR1@mac')`;
    await tx`select cb.ask(project => 'cedar', body => 'sneaky?', actor => 'AR1@mac')`;
  }), /nothing is asked there/);
});

test('starting work outside a claim: a session may not move a card into In progress or give it a holder; clearing one is fine; the dashboard may', async () => {
  const { sql, session, set } = await setup();
  await set('disabled');
  await assert.rejects(session`select cb.task_move('2', 'in_progress', null, 'W2@pc')`, /Cedar is disabled .*Write where you stopped/);
  await assert.rejects(session`select cb.task_update('2', '{"assignee":"W2@pc"}'::jsonb, 'W2@pc')`, /Cedar is disabled/);
  await session`select cb.task_move('1', 'in_progress', 'still mine', 'W1@pc')`; // already in progress: a restatement
  await session`select cb.task_update('1', '{"assignee":null}'::jsonb, 'W1@pc')`;
  await session`select cb.task_update('2', '{"title":"renamed"}'::jsonb, 'W2@pc')`;
  await sql`select cb.task_update('2', '{"assignee":"W2@pc"}'::jsonb, 'ahmed')`;
  await sql`select cb.task_move('2', 'in_progress', null, 'ahmed')`;
  // a card moved into a disabled project lands and waits
  await session`select cb.task_update('3', '{"project":"cedar"}'::jsonb, 'A1@pc')`;
  assert.equal((await sql`select project from cb.tasks where id = 3`)[0].project, 'cedar');
});

test('notices: one message per seat bound to the project or holding its cards, on disable and on enable; none elsewhere', async () => {
  const { sql, set } = await setup();
  await sql`update cb.tasks set assignee = 'W9@mac' where id = 2`; // a holder with no session row in cedar
  await sql`update cb.sessions set last_seen = now() - interval '3 days' where actor = 'W2@pc'`; // gone for days, holds nothing: not told
  const told = async (s: string) => (await sql`select data ->> 'to' as to_, summary from cb.events where kind = 'message' and data ->> 'state' = ${s} order by data ->> 'to'`) as any[];
  const d = await set('disabled');
  assert.equal(d.told, 2);
  const off = await told('disabled');
  assert.deepEqual(off.map((m) => m.to_), ['W1@pc', 'W9@mac']);
  assert.match(off[0].summary, /^Ahmed disabled Cedar\. Stop at a safe point: push your work, write where it stands \(cb log <card> "\.\.\."\), and release any lock you hold\. Take no new card\. Your cards stay yours/);
  await set('archived');
  await set('disabled');
  assert.equal((await told('disabled')).length, 2, 'archive and unarchive tell nobody');
  await set('enabled');
  const on = await told('enabled');
  assert.deepEqual(on.map((m) => m.to_), ['W1@pc', 'W9@mac']);
  assert.equal(on[0].summary, 'Ahmed enabled Cedar again. Carry on: cb resume, then cb next.');
});

test('runner: cb run is refused in words, job_claim skips the project\'s jobs and takes the next project\'s, enable wakes the runner', async () => {
  const { sql, session, set } = await setup();
  const runner = conn('cb-runner/test');
  const recipe = (p: string) => ({ project: p, recipe: 'test', params: { files: { min: 1, max: 20 } }, db: false });
  await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1', ${runner.json([recipe('cedar'), recipe('atlas')] as any)}, 4, 2)`;
  const add = (actor: string, p: string) => session`select cb.job_add(${p}, 'test', 'abcdef1234', ${session.json({ files: ['a.ts'] })}, null, ${actor}) as r`.then((r: any) => r[0].r);
  const waiting = await add('W1@pc', 'cedar');
  const other = await add('A1@pc', 'atlas');
  await set('disabled');
  await assert.rejects(add('W1@pc', 'cedar'), /Cedar is disabled by Ahmed .*: its runner jobs wait, and no new one is queued until Ahmed enables it/);
  const claim = () => runner`select cb.job_claim('pc', true) as j`.then((r: any) => r[0].j);
  assert.equal(Number((await claim()).id), Number(other.id), 'the next project\'s job');
  assert.equal(await claim(), null, 'the disabled project\'s job waits');
  assert.equal((await sql`select state from cb.jobs where id = ${waiting.id}`)[0].state, 'queued');
  assert.equal((await sql`select count(*)::int n from cb.job_holds`)[0].n, 0, 'no hold row a lead could release');
  const heard: string[] = [];
  const listener = conn('listener');
  await listener.listen('cb_jobs', (x: string) => heard.push(x));
  await set('enabled');
  for (let i = 0; i < 40 && !heard.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(heard.length > 0, 'the runner is woken');
  assert.equal(Number((await claim()).id), Number(waiting.id));
});

// two cedar jobs waiting and one running, one atlas job waiting
async function jobs() {
  const s = await setup();
  const runner = conn('cb-runner/test');
  const recipe = (p: string) => ({ project: p, recipe: 'test', params: { files: { min: 1, max: 20 } }, db: false });
  await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1', ${runner.json([recipe('cedar'), recipe('atlas')] as any)}, 4, 2)`;
  const add = async (actor: string, p: string, file: string) => Number((await s.session`select cb.job_add(${p}, 'test', 'abcdef1234', ${s.session.json({ files: [file] })}, null, ${actor}) as r`)[0].r.id);
  const claim = () => runner`select cb.job_claim('pc', true) as j`.then((r: any) => r[0].j);
  const running = await add('W1@pc', 'cedar', 'a.ts');
  assert.equal(Number((await claim()).id), running);
  const first = await add('W1@pc', 'cedar', 'b.ts'), second = await add('W2@pc', 'cedar', 'c.ts'), other = await add('A1@pc', 'atlas', 'd.ts');
  const why = async (id: number) => (await s.sql`select cb.runner_queue() as q`)[0].q.waiting.find((w: any) => Number(w.id) === id)?.why;
  const job = async (id: number) => ({ ...(await s.sql`select state, summary, finished_at is not null as ended from cb.jobs where id = ${id}`)[0] });
  return { ...s, runner, claim, why, job, running, first, second, other };
}

test('runner_queue: a waiting job of a project that gets no work says so, ahead of a hold and the runner\'s state', async () => {
  const { sql, set, why, first, other } = await jobs();
  await set('disabled');
  const w = await why(first);
  assert.deepEqual([w.reason, w.state], ['project', 'disabled']);
  assert.match(w.words, /^Cedar is disabled by Ahmed since .+ UTC: no work is handed out there$/);
  assert.equal((await why(other)).reason, 'next', 'another project\'s job is not touched');
  await sql`insert into cb.job_holds (project, held_by) values ('cedar', 'L1@pc')`;
  await sql`update cb.runners set mode = 'paused'`;
  assert.equal((await why(first)).reason, 'project', 'releasing the hold or resuming the runner would not start it');
  await sql`delete from cb.job_holds`;
  await sql`update cb.runners set mode = 'on'`;
  await set('enabled');
  assert.equal((await why(first)).reason, 'next');
});

test('disable keeps the waiting jobs; archive cancels them, tells who asked and counts them; a running one finishes', async () => {
  const { sql, runner, set, why, job, claim, running, first, second, other } = await jobs();
  assert.equal((await set('disabled')).jobs_cancelled, 0);
  assert.equal((await job(first)).state, 'queued');
  assert.equal((await set('archived')).jobs_cancelled, 2);
  for (const id of [first, second]) assert.deepEqual(await job(id), { state: 'cancelled', summary: 'cancelled: the project was archived', ended: true });
  assert.equal((await job(running)).state, 'running');
  assert.equal((await job(other)).state, 'queued', 'another project\'s job');
  assert.equal(await why(first), undefined);
  for (const [who, id] of [['W1@pc', first], ['W2@pc', second]] as const) {
    const told = await sql`select summary from cb.events where kind = 'message' and data ->> 'to' = ${who} and summary like ${`%job #${id} %cancelled%`}`;
    assert.equal(told.length, 1, `${who} is told about job #${id}`);
  }
  assert.equal((await runner`select cb.job_finish(${running}, 'pc', 'passed', 0, 'ok') as ok`)[0].ok, true, 'the running job still ends');
  assert.equal((await set('disabled')).jobs_cancelled, 0, 'unarchive cancels nothing');
  await set('enabled');
  assert.equal((await job(first)).state, 'cancelled', 'a cancelled job stays cancelled');
  assert.equal(Number((await claim()).id), other);
});

test('supervise_state: a disabled project is not supervised and says its state', async () => {
  const { sql, set } = await setup();
  await sql`select cb.project_pipeline('cedar', true, 'ahmed')`;
  await sql`update cb.projects set squad = '{"supervise": true, "roles": {}}'::jsonb where slug = 'cedar'`;
  const sup = conn('cb-supervisor/test');
  const state = async () => (await sup`select cb.supervise_state('cedar') as s`)[0].s;
  assert.equal((await state()).supervised, true);
  await set('disabled');
  const s = await state();
  assert.deepEqual([s.supervised, s.state], [false, 'disabled']);
});

test('resume (and so the SessionStart hook) says the bound project is disabled', async () => {
  const { session, set } = await setup();
  await set('disabled');
  const r = (await session`select cb.resume('W1@pc') as r`)[0].r;
  assert.match(r.disabled, /^Cedar is disabled/);
  const { resumeText } = await import('../cli/resume-text.ts');
  assert.match(resumeText(r), /^PROJECT DISABLED: Cedar is disabled by Ahmed/);
  assert.equal((await session`select cb.resume('A1@pc') as r`)[0].r.disabled, undefined);
});

// ---------------------------------------------------------------- the server
const SITE = 'board.example.com';
const web = (path: string, o: { cookie?: string; body?: object } = {}) =>
  app.request(path, { method: o.body ? 'POST' : 'GET', headers: {
    host: SITE, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', origin: `https://${SITE}`, 'sec-fetch-site': 'same-origin',
    ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: `cb_user=${o.cookie}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined });
async function signIn(name: string, password: string) {
  const r = await web('/api/login', { body: { name, password } });
  return /cb_user=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1]!;
}

test('server: project_state is Ahmed\'s (another admin 403), the preview counts, /api/projects lists every state, Today leaves a disabled project\'s questions out', async () => {
  const { sql, session } = await setup();
  await session`select cb.ask(project => 'cedar', body => 'cedar q', actor => 'W2@pc'), cb.ask(project => 'atlas', body => 'atlas q', actor => 'A1@pc')`;
  for (const [name, pw] of [['ahmed', 'owner-pass-1'], ['cai', 'cai-pass-1']]) {
    await sql`select cb.user_add(${name}, ${name}, role => 'admin')`;
    await sql`select cb.user_password(${name}, ${pw})`;
  }
  const ahmed = await signIn('ahmed', 'owner-pass-1'), cai = await signIn('cai', 'cai-pass-1');
  const r403 = await web('/api/rpc/project_state', { cookie: cai, body: { project: 'cedar', state: 'disabled' } });
  assert.equal(r403.status, 403);
  assert.match((await r403.json()).error, /Only Ahmed changes project settings/);
  const pre = await (await web('/api/rpc/project_state_preview', { cookie: cai, body: { project: 'cedar' } })).json();
  assert.equal(pre.ok, true);
  assert.deepEqual([pre.result.state, pre.result.in_progress, pre.result.held, pre.result.open, pre.result.questions], ['enabled', 1, 1, 2, 1]);
  const ok = await (await web('/api/rpc/project_state', { cookie: ahmed, body: { project: 'cedar', state: 'disabled' } })).json();
  assert.equal(ok.result.state, 'disabled');
  await sql`select cb.project_state('atlas', 'disabled', 'ahmed'), cb.project_state('atlas', 'archived', 'ahmed')`;
  const projects = await (await web('/api/projects', { cookie: cai })).json();
  assert.deepEqual(projects.map((p: any) => [p.slug, p.state, p.state_by]), [['atlas', 'archived', 'ahmed'], ['cedar', 'disabled', 'ahmed']]);
  await sql`select cb.project_state('atlas', 'disabled', 'ahmed'), cb.project_state('atlas', 'enabled', 'ahmed')`;
  const open = await (await web('/api/questions?status=open', { cookie: ahmed })).json();
  assert.deepEqual(open.map((q: any) => q.project), ['atlas'], 'Today and the lamp: not the disabled one');
  const own = await (await web('/api/questions?project=cedar&status=open', { cookie: ahmed })).json();
  assert.deepEqual(own.map((q: any) => q.body), ['cedar q'], 'its own page still shows it');
});

// ---------------------------------------------------------------- the CLI words
function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W2@pc', HERDR_PANE_ID: '', CB_MACHINE: 'pc', CB_AGENT: '', CLAUDE_CODE_MESSAGING_SOCKET: '', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('cb next, cb start, cb add, cb bug, cb brief and cb tick say a project is disabled, in words', async () => {
  const { sql, set } = await setup();
  await set('disabled');
  assert.match(cb(['next', 'cedar']).out, /^Cedar is disabled by Ahmed since .*: no work is handed out there\. Write where you stopped \(cb log <card> "\.\.\."\) and wait/);
  assert.equal(cb(['next', 'atlas'], { CB_ACTOR: 'A1@pc' }).out.startsWith('#3'), true);
  const P = `p-states-${process.pid}`;
  await sql`insert into cb.sessions (machine, pane, actor, project) values ('pc', ${P}, 'W5@pc', 'cedar')`;
  const st = cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: P });
  assert.match(st.out, /PROJECT DISABLED\n {2}Cedar is disabled by Ahmed/);
  assert.match(st.out, /NEXT\n {2}wait: take no new card/);
  assert.doesNotMatch(st.out, /cb next +claim/);
  // an unbound pane is offered enabled projects only
  const un = cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: `${P}-x` });
  assert.match(un.out, /atlas/);
  assert.doesNotMatch(un.out, /^ +cedar /m);
  assert.match(cb(['add', 'cedar', 'parked one']).out, /^#\d+ filed in cedar's Backlog: Cedar is disabled by Ahmed .*; nobody picks it up until Ahmed enables it$/);
  assert.match(cb(['bug', 'cedar', 'a bug', '-b', 'what happened']).out, /^#\d+ bug filed in cedar's Backlog: Cedar is disabled/);
  assert.match(cb(['brief', 'cedar']).out, /^PROJECT DISABLED: Cedar is disabled/);
  assert.match(cb(['tick', 'cedar']).out, /^PROJECT DISABLED: Cedar is disabled/);
  assert.equal(cb(['add', 'atlas', 'normal one'], { CB_ACTOR: 'A1@pc' }).out.match(/^#\d+$/)?.length, 1, 'an enabled project prints only the id');
});

test('tick after an enable: silent, long-blocked and quiet-huddle clocks count from the enable, not from the wrap-up (review M4)', async () => {
  const { sql, session, set } = await setup();
  await sql`select cb.task_add(project => 'cedar', title => 'blocked one', status => 'blocked', assignee => 'W2@pc', actor => 'W2@pc')`; // #4
  const [{ h }] = await session`select cb.huddle_open('sync', '[]', null, 'W1@pc', 'cedar') as h`;
  await set('disabled');
  await set('enabled');
  await sql`update cb.events set at = now() - interval '3 hours'`;
  await sql`update cb.tasks set updated_at = now() - interval '3 hours'`;
  await sql`update cb.huddles set opened_at = now() - interval '3 hours' where id = ${h}`;
  const tick = async () => (await session`select cb.tick('cedar', 'lead@pc') as t`)[0].t;
  let t = await tick();
  assert.deepEqual([t.silent.length, t.blocked.length, t.huddles.length], [0, 0, 0], 'just enabled: nothing reads as stuck');
  await sql`update cb.projects set state_at = now() - interval '2 hours' where slug = 'cedar'`;
  t = await tick();
  assert.deepEqual(t.silent.map((x: any) => Number(x.id)), [1]);
  assert.deepEqual(t.blocked.map((x: any) => Number(x.id)), [4]);
  assert.equal(t.huddles.length, 1);
});

test('the per-project lamp count leaves a disabled project\'s questions out (review M5)', async () => {
  const { session, set } = await setup();
  await session`select cb.ask(project => 'cedar', body => 'q?', actor => 'W2@pc')`;
  const count = async () => {
    const r = await (await app.request('/api/projects')).json();
    return r.find((p: any) => p.slug === 'cedar').question_count;
  };
  assert.equal(await count(), 1);
  await set('disabled');
  assert.equal(await count(), 0);
});
