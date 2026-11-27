import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { stageWordsFor } from '../cli/stage-words.ts';

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

test('a staged new card never starts claimed: an explicit in_progress becomes next', async () => {
  const sql = await setup();
  const [{ id }] = await sql`select cb.task_add(project => 'demo', title => 'x', status => 'in_progress', actor => 'B1@mac') as id`;
  const [t] = await sql`select stage, status, assignee from cb.tasks where id = ${id}`;
  assert.deepEqual({ ...t }, { stage: 'design', status: 'next', assignee: null });
});

// --- pass / fail / approval (Task 5)
const claim = (sql: any, id: number, actor: string) => sql`update cb.tasks set status = 'in_progress', assignee = ${actor} where id = ${id}`;
const pass = (sql: any, id: number, actor: string, summary = 'ok', links: any = {}) =>
  sql`select cb.stage_pass(${id}::text, ${summary}, ${sql.json(links)}, ${actor}) as r`;
const row = async (sql: any, id: number) => (await sql`select stage, status, assignee, approved_version, crew from cb.tasks where id = ${id}`)[0];
// a card at design, the owner holding it, page written
async function atDesign(sql: any) {
  const id = await card(sql);
  await claim(sql, id, 'O1@mac');
  await sql`select cb.page_set('the design', task => ${id}::text, actor => 'O1@mac')`;
  return id;
}
async function atApproval(sql: any) {
  const id = await atDesign(sql);
  await pass(sql, id, 'O1@mac', 'designed');
  const [q] = await sql`select id from cb.questions where approval_for = ${id}`;
  return { id, q: Number(q.id) };
}

test('a card walks every stage', async () => {
  const sql = await setup();
  const id = await card(sql);
  await claim(sql, id, 'O1@mac');
  await assert.rejects(() => pass(sql, id, 'O1@mac'), /page/);
  await sql`select cb.page_set('the design', task => ${id}::text, actor => 'O1@mac')`;
  assert.equal((await pass(sql, id, 'O1@mac', 'designed'))[0].r, 'approval');
  assert.deepEqual({ ...(await row(sql, id)) }, { stage: 'approval', status: 'review', assignee: null, approved_version: null, crew: { design: 'O1@mac' } });
  const qs = await sql`select id, approval_for, page_version, status from cb.questions`;
  assert.equal(qs.length, 1);
  assert.equal(Number(qs[0].approval_for), id); assert.equal(qs[0].page_version, 1);
  await sql`select cb.answer(${qs[0].id}::text, 'Approve', 'ahmed')`;
  assert.deepEqual({ ...(await row(sql, id)) }, { stage: 'build', status: 'next', assignee: null, approved_version: 1, crew: { design: 'O1@mac' } });
  assert.equal((await sql`select status from cb.questions where id = ${qs[0].id}`)[0].status, 'delivered');
  const pg = (await sql`select cb.page_get(${id}::text) as r`)[0].r;
  assert.deepEqual([pg.approved_by, pg.approved_at != null], ['O1@mac', true]);
  await claim(sql, id, 'B1@mac');
  await assert.rejects(() => pass(sql, id, 'B1@mac'), /--pr/);
  assert.equal((await pass(sql, id, 'B1@mac', 'built', { pr: 'https://x/pull/1' }))[0].r, 'review');
  await claim(sql, id, 'R1@mac');
  assert.equal((await pass(sql, id, 'R1@mac', 'reviewed'))[0].r, 'merge');
  await claim(sql, id, 'orch@pc');
  await assert.rejects(() => pass(sql, id, 'orch@pc'), /--commit/);
  assert.equal((await pass(sql, id, 'orch@pc', 'merged', { commit: 'abc1234' }))[0].r, 'qa');
  await claim(sql, id, 'Q1@mac');
  assert.equal((await pass(sql, id, 'Q1@mac', 'checked'))[0].r, 'done');
  const r = await row(sql, id);
  assert.deepEqual([r.status, r.stage], ['done', null]);
  assert.deepEqual(r.crew, { design: 'O1@mac', build: 'B1@mac', review: 'R1@mac' });
  const [t] = await sql`select links from cb.tasks where id = ${id}`;
  assert.deepEqual({ ...t.links }, { pr: 'https://x/pull/1', commit: 'abc1234' });
});

test('fail returns the card to the same builder or designer', async () => {
  const sql = await setup();
  const { id, q } = await atApproval(sql);
  await sql`select cb.answer(${q}::text, 'Approve', 'ahmed')`;
  await claim(sql, id, 'B1@mac'); await pass(sql, id, 'B1@mac', 'built', { pr: '#1' });
  await claim(sql, id, 'R1@mac');
  assert.equal((await sql`select cb.stage_fail(${id}::text, 'wrong', null, 'R1@mac') as r`)[0].r, 'build');
  const b1 = await row(sql, id);
  assert.deepEqual([b1.stage, b1.status, b1.assignee], ['build', 'next', 'B1@mac']);
  await claim(sql, id, 'B1@mac'); await pass(sql, id, 'B1@mac', 'again');
  await claim(sql, id, 'R1@mac'); await pass(sql, id, 'R1@mac'); await claim(sql, id, 'orch@pc'); await pass(sql, id, 'orch@pc', 'm', { commit: 'abc' });
  await claim(sql, id, 'Q1@mac');
  await sql`select cb.stage_fail(${id}::text, 'design is off', 'design', 'Q1@mac')`;
  const r = await row(sql, id);
  assert.deepEqual([r.stage, r.assignee], ['design', 'O1@mac']);
  // Changes needed
  const b = await atApproval(sql);
  await sql`select cb.answer(${b.q}::text, 'Changes needed — add the error path', 'ahmed')`;
  const c = await row(sql, b.id);
  assert.deepEqual([c.stage, c.status, c.assignee], ['design', 'next', 'O1@mac']);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${b.id} and summary like '%add the error path%' and data ? 'stage'`)[0].n, 1);
  // the designer takes it back
  const d = await atApproval(sql);
  await sql`select cb.stage_fail(${d.id}::text, 'fix the page', null, 'O1@mac')`;
  const dr = await row(sql, d.id);
  assert.deepEqual([dr.stage, dr.assignee], ['design', 'O1@mac']);
  assert.equal((await sql`select status from cb.questions where id = ${d.q}`)[0].status, 'withdrawn');
  const e = await atApproval(sql);
  await assert.rejects(() => sql`select cb.stage_fail(${e.id}::text, 'x', null, 'B1@mac')`, /./);
});

test('only Ahmed approves, and only what he saw', async () => {
  const sql = await setup();
  const { id, q } = await atApproval(sql);
  const session = postgres(TEST_URL, { onnotice: () => {} }); clients.push(session);
  await assert.rejects(() => session`select cb.answer(${q}::text, 'Approve', 'R1@mac')`, /only Ahmed approves/);
  await assert.rejects(() => session`select cb.answer(${q}::text, 'Approve', 'ahmed')`, /only Ahmed/);
  assert.equal((await row(sql, id)).stage, 'approval');
  await assert.rejects(() => sql`select cb.page_set('new text', task => ${id}::text, actor => 'O1@mac')`, /waits for Ahmed's approval of v1/);
});

test('the wrong role and the builder reviewing are refused', async () => {
  const sql = await setup();
  const id = await card(sql);
  await claim(sql, id, 'B1@mac');
  await assert.rejects(() => pass(sql, id, 'B1@mac'), /owner or architect/);
  const { id: a, q } = await atApproval(sql);
  await assert.rejects(() => pass(sql, a, 'O1@mac'), /waiting for Ahmed/);
  await sql`select cb.answer(${q}::text, 'Approve', 'ahmed')`;
  await claim(sql, a, 'B1@mac'); await pass(sql, a, 'B1@mac', 'built', { pr: '#2' });
  await sql`update cb.sessions set role = 'reviewer' where actor = 'B1@mac'`;
  await claim(sql, a, 'B1@mac');
  await assert.rejects(() => pass(sql, a, 'B1@mac'), /built it/);
});

test('a changed approval answer never moves the card twice', async () => {
  const sql = await setup();
  const { id, q } = await atApproval(sql);
  await sql`select cb.answer(${q}::text, 'Approve', 'ahmed')`;
  await claim(sql, id, 'B1@mac');
  await sql`select cb.answer(${q}::text, 'Changes needed', 'ahmed')`;
  const r = await row(sql, id);
  assert.deepEqual([r.stage, r.assignee], ['build', 'B1@mac']);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and data ? 'digest'`)[0].n, 1);
});

test('a typed approval answer sends the design back', async () => {
  const sql = await setup();
  const { id, q } = await atApproval(sql);
  await sql`select cb.answer(${q}::text, 'tighten the error messages', 'ahmed')`;
  const r = await row(sql, id);
  assert.deepEqual([r.stage, r.assignee], ['design', 'O1@mac']);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and summary like '%tighten the error messages%' and data ? 'stage'`)[0].n, 1);
});

test('only the current approval question moves the card', async () => {
  const sql = await setup();
  const { id, q: q1 } = await atApproval(sql);
  await sql`select cb.answer(${q1}::text, 'Changes needed', 'ahmed')`;
  await claim(sql, id, 'O1@mac');
  await sql`select cb.page_set('the design v2', task => ${id}::text, actor => 'O1@mac')`;
  await pass(sql, id, 'O1@mac', 'redesigned');
  const [{ id: q2 }] = await sql`select id from cb.questions where approval_for = ${id} and id <> ${q1}`;
  await sql`select cb.answer(${q1}::text, 'Approve', 'ahmed')`;
  const r = await row(sql, id);
  assert.deepEqual([r.stage, r.approved_version], ['approval', null]);
  assert.equal((await sql`select status from cb.questions where id = ${q2}`)[0].status, 'open');
  assert.equal((await sql`select status from cb.questions where id = ${q1}`)[0].status, 'delivered');
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and data ? 'digest'`)[0].n, 1);
});

test('a dashboard connection answering as a non-Ahmed name cannot approve', async () => {
  const sql = await setup();
  const { id, q } = await atApproval(sql);
  await assert.rejects(() => sql`select cb.answer(${q}::text, 'Approve', 'G1')`, /only Ahmed approves designs/);
  assert.equal((await row(sql, id)).stage, 'approval');
});

// --- the guard (Task 6): a staged card leaves the pipeline only through Ahmed or the lead
const session = () => { const s = postgres(TEST_URL, { onnotice: () => {} }); clients.push(s); return s; }; // not the dashboard
const atBuild = async (sql: any) => { const id = await card(sql); await sql`select cb.stage_set(${id}::text, 'build', 'small', 'orch@pc')`; return id; };

test('done and cancel outside the pipeline', async () => {
  const sql = await setup(); const s = session();
  const a = await atBuild(sql);
  await assert.rejects(() => s`select cb.task_done(${a}::text, 'done', '{}', 'B1@mac')`, /is at build: finish it with cb pass/);
  await assert.rejects(() => s`select cb.task_move(${a}::text, 'cancelled', 'x', 'B1@mac')`, /is at build/);
  await assert.rejects(() => s`select cb.task_move(${a}::text, 'cancelled', null, 'orch@pc')`, /is at build/); // lead needs a note
  await s`select cb.task_move(${a}::text, 'cancelled', 'dup of #9', 'orch@pc')`;
  assert.deepEqual([(await row(sql, a)).stage, (await row(sql, a)).status], [null, 'cancelled']);
  const b = await atBuild(sql);
  await sql`select cb.task_move(${b}::text, 'done', null, 'ahmed')`;
  assert.deepEqual([(await row(sql, b)).stage, (await row(sql, b)).status], [null, 'done']);
  assert.equal((await row(sql, await atBuild(sql))).stage, 'build'); // insert-time stage unaffected
});

test('a staged card cannot leave by a project move', async () => {
  const sql = await setup(); const s = session();
  await sql`select cb.ensure_project('other')`;
  const id = await atBuild(sql);
  await assert.rejects(() => s`select cb.task_update(${id}::text, '{"project":"other"}', 'B1@mac')`, /stays in its project/);
  await sql`select cb.task_update(${id}::text, '{"project":"other"}', 'ahmed')`;
  assert.equal((await sql`select project from cb.tasks where id = ${id}`)[0].project, 'other');
});

test('pipeline off: staged cards behave as normal cards', async () => {
  const sql = await setup(); const s = session();
  const id = await atBuild(sql);
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  await s`select cb.task_done(${id}::text, 'done', '{}', 'B1@mac')`;
  assert.equal((await row(sql, id)).status, 'done');
  await assert.rejects(() => pass(sql, id, 'B1@mac'), /pipeline is off/);
  assert.equal((await row(sql, await card(sql))).stage, null);
});

test('an approval question is withdrawn, sent back or reassigned only by the designer taking the card back', async () => {
  const sql = await setup(); const s = session();
  const { id, q } = await atApproval(sql);
  const msg = new RegExp(`Q${q} is the approval for #${id}: the designer takes it back with cb fail ${id} "<why>"`);
  await assert.rejects(() => s`select cb.withdraw(${q}::text, 'B1@mac')`, msg);
  await assert.rejects(() => sql`select cb.send_back(${q}::text, 'details', null, 'ahmed')`, msg);
  await assert.rejects(() => sql`select cb.question_assign(${q}::text, 'ahmed', 'ahmed')`, msg);
  assert.equal((await sql`select status from cb.questions where id = ${q}`)[0].status, 'open');
  await s`select cb.stage_fail(${id}::text, 'rework', null, 'O1@mac')`; // the designer's own path still withdraws it
  assert.equal((await sql`select status from cb.questions where id = ${q}`)[0].status, 'withdrawn');
});

// --- role-aware claiming and pushes (Task 7)
const take = async (sql: any, actor: string) => (await sql`select * from cb.task_claim('demo', ${actor})`).map((r: any) => Number(r.id));
const addCard = async (sql: any, o: { type?: string; labels?: string[]; actor?: string } = {}) =>
  Number((await sql`select cb.task_add(project => 'demo', title => 'c', type => ${o.type ?? 'feature'}, labels => ${sql.json(o.labels ?? [])}, status => 'next', actor => ${o.actor ?? 'orch@pc'}) as id`)[0].id);
const toStage = (sql: any, id: number, st: string) => sql`select cb._stage_move(${id}, ${st}, null, 'x')`;
const extraSessions = (sql: any) => sql`insert into cb.sessions (machine, pane, actor, project, role, area) values
  ('mac','p6','A1@mac','demo','architect',null), ('mac','p7','I1@mac','demo','investigator',null),
  ('mac','p8','X1@mac','demo',null,null), ('mac','p9','B2@mac','demo','builder',null)`;

test('next gives each role only its stage', async () => {
  const sql = await setup(); await extraSessions(sql);
  const design = await addCard(sql, { labels: ['claims'] });
  const build = await addCard(sql); await toStage(sql, build, 'build');
  const review = await addCard(sql); await toStage(sql, review, 'review');
  const merge = await addCard(sql); await toStage(sql, merge, 'merge');
  const qa = await addCard(sql); await toStage(sql, qa, 'qa');
  const approval = await addCard(sql); await toStage(sql, approval, 'approval');
  const research = await addCard(sql, { type: 'research' });
  const plain = Number((await sql`select cb.task_add(project => 'demo', title => 'pr', type => 'feature', status => 'next', actor => 'github') as id`)[0].id);
  const handed = await addCard(sql, { labels: ['other'] });
  await sql`update cb.tasks set assignee = 'B1@mac' where id = ${handed}`; // the lead handed a design card to a builder
  assert.deepEqual(await take(sql, 'X1@mac'), [plain]);      // roleless: unstaged only
  assert.deepEqual(await take(sql, 'X1@mac'), []);
  assert.deepEqual(await take(sql, 'I1@mac'), [research]);
  assert.deepEqual(await take(sql, 'I1@mac'), []);
  assert.deepEqual(await take(sql, 'R1@mac'), [review]);
  assert.deepEqual(await take(sql, 'Q1@mac'), [qa]);
  assert.deepEqual(await take(sql, 'orch@pc'), [merge]);
  assert.deepEqual(await take(sql, 'B1@mac'), [build]);       // never the design card it was handed
  assert.deepEqual(await take(sql, 'B1@mac'), []);
  assert.deepEqual(await take(sql, 'O1@mac'), [design]);
  assert.equal((await row(sql, approval)).status, 'review');
});

test('a hold is only for the right role: a wrong-role holder is refused, a right-role holder skips the area wait', async () => {
  const sql = await setup(); await extraSessions(sql);
  const b = await addCard(sql); await toStage(sql, b, 'build');
  await sql`update cb.tasks set assignee = 'R1@mac' where id = ${b}`; // reviewer holds a build card
  assert.deepEqual(await take(sql, 'R1@mac'), []);
  const d = await addCard(sql, { labels: ['claims'] });
  await sql`update cb.tasks set assignee = 'A1@mac' where id = ${d}`; // live owner O1 has area claims, but the hold wins
  assert.deepEqual(await take(sql, 'A1@mac'), [d]);
});

test('design goes to the area owner first, an architect after 15 minutes', async () => {
  const sql = await setup(); await extraSessions(sql);
  const d = await addCard(sql, { labels: ['claims'] });
  assert.deepEqual(await take(sql, 'A1@mac'), []);
  await sql`update cb.tasks set stage_since = now() - interval '16 minutes' where id = ${d}`;
  assert.deepEqual(await take(sql, 'A1@mac'), [d]);
  // an owner session that is down no longer holds the card back
  const e = await addCard(sql, { labels: ['claims'] });
  await sql`update cb.sessions set last_seen = now() - interval '11 minutes' where actor = 'O1@mac'`;
  assert.deepEqual(await take(sql, 'A1@mac'), [e]);
});

test('two sessions claiming at once get one card each or nothing', async () => {
  const sql = await setup(); await extraSessions(sql);
  const b = await addCard(sql); await toStage(sql, b, 'build');
  const s1 = session(), s2 = session();
  const got = await Promise.all([take(s1, 'B1@mac'), take(s2, 'B2@mac')]);
  assert.deepEqual(got.flat(), [b]);
});

test('the push of new work reaches only sessions that can claim it', async () => {
  const sql = await setup();
  const b = await addCard(sql); await toStage(sql, b, 'build');
  const inbox = async (pane: string) => (await sql`select cb.inbox('mac', ${pane}, 0) as r`)[0].r.next_work.map((w: any) => Number(w.id));
  assert.deepEqual(await inbox('p2'), [b]);  // B1 builds
  assert.deepEqual(await inbox('p3'), []);   // R1 reviews
});

test('outside a pipeline project an area never reorders claims, and staged bugs go to triage once it is off', async () => {
  const sql = await setup();
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  const lo = Number((await sql`select cb.task_add(project => 'demo', title => 'lo', priority => 'P3', labels => '["claims"]', status => 'next', actor => 'orch@pc') as id`)[0].id);
  const hi = Number((await sql`select cb.task_add(project => 'demo', title => 'hi', priority => 'P1', status => 'next', actor => 'orch@pc') as id`)[0].id);
  assert.deepEqual(await take(sql, 'O1@mac'), [hi]); // O1 has area claims
  assert.deepEqual(await take(sql, 'O1@mac'), [lo]);
  // a bug staged while the pipeline was on stays out of next_work when it is off
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  const bug = await card(sql, { actor: 'orch@pc' });
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  const nw = (await sql`select cb.inbox('mac', 'p2', 0) as r`)[0].r.next_work.map((w: any) => Number(w.id));
  assert.ok(!nw.includes(bug)); // p2 is B1 (bound to demo)
});

// ---- Task 10: agent-native output
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'B1@mac', HERDR_PANE_ID: '', CB_MACHINE: 'mac', CLAUDE_CODE_MESSAGING_SOCKET: '', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const PR = 'https://github.com/o/r/pull/9';

test('resume gives back each card with its stage, finish line, page and notes', async () => {
  const sql = await setup();
  const id = await atBuild(sql);
  await sql`select cb.page_set('v1 text', task => ${String(id)}, actor => 'O1@mac')`;
  await sql`select cb.page_set('v2 text', task => ${String(id)}, actor => 'O1@mac')`;
  await sql`update cb.tasks set approved_version = 1, assignee = 'B1@mac', status = 'in_progress' where id = ${id}`;
  await sql`select cb.log('demo', 'tried the obvious fix', ${String(id)}, actor => 'B1@mac')`;
  await sql`select cb.ask('demo', 'Which table holds it?', null, task_id => ${String(id)}, actor => 'B1@mac')`;
  const r = (await sql`select cb.resume('B1@mac') as r`)[0].r;
  assert.deepEqual([r.actor, r.role, r.project], ['B1@mac', 'builder', 'demo']);
  const c = r.cards[0];
  assert.equal(r.cards.length, 1);
  assert.equal(c.stage_words, 'Building');
  assert.match(c.finish, /cb pass \d+ .*--pr/);
  assert.equal(c.page.version, 1);
  assert.equal(c.page.body, 'v1 text');
  assert.equal(c.notes[0].summary, 'tried the obvious fix');
  assert.equal(c.questions[0].body, 'Which table holds it?');
  // the designer sees the newest version, not the approved one
  await sql`update cb.tasks set assignee = 'O1@mac' where id = ${id}`;
  assert.equal((await sql`select cb.resume('O1@mac') as r`)[0].r.cards[0].page.version, 2);
});

test('stage words come from SQL only, and finish lines name the next command', async () => {
  const sql = await setup();
  const w = async (s: string | null) => (await sql`select cb._stage_words(${s}) as w`)[0].w;
  assert.deepEqual(await Promise.all(['design', 'approval', 'build', 'review', 'merge', 'qa'].map(w)),
    ['Design', 'Waiting for your approval', 'Building', 'In review', 'Merging to dev', 'Checking on dev against the design']);
  assert.equal(await w(null), 'Not staged');
  // the dashboard's chip keeps its own copy of the words (the web cannot call SQL per render): it must not drift
  const chips = readFileSync('web/src/components/Chips.tsx', 'utf8');
  for (const st of ['design', 'approval', 'build', 'review', 'merge', 'qa']) assert.ok(chips.includes(`${st}: '${await w(st)}'`), `StageChip maps ${st} to its words`);
  assert.ok(!/STAGE_WORDS/.test(readFileSync('cli/cb.ts', 'utf8')), 'the CLI keeps no copy of the words');
  const id = await atBuild(sql);
  const f = async (st: string | null) => (await sql`select cb._finish_line(jsonb_populate_record(null::cb.tasks,
    to_jsonb(t) || jsonb_build_object('stage', ${st}::text))) as f from cb.tasks t where t.id = ${id}`)[0].f;
  assert.match(await f('design'), /cb page set \d+ -f page\.md, then cb pass \d+ "<summary>"/);
  assert.match(await f('build'), /cb pass \d+ "<summary>" --pr <url>/);
  assert.match(await f('review'), /cb pass \d+ "<verdict>" or cb fail \d+ "<what is wrong>"/);
  assert.match(await f('merge'), /cb pass \d+ .*--commit <sha>/);
  assert.match(await f('qa'), /cb fail \d+ "<what fails>"/);
  assert.match(await f(null), /cb done \d+ "<summary>"/);
});

test('cb pass, fail and stage say where the card went and who takes it', async () => {
  const sql = await setup();
  const id = await atBuild(sql);
  await sql`update cb.tasks set assignee = 'B1@mac', status = 'in_progress' where id = ${id}`;
  const p = cb(['pass', String(id), 'built', '--pr', PR]);
  assert.match(p.out, /→ In review; a reviewer takes it\. You: cb next/, p.err);
  await sql`update cb.tasks set assignee = 'R1@mac', status = 'in_progress' where id = ${id}`;
  const f = cb(['fail', String(id), 'the error path is missing'], { CB_ACTOR: 'R1@mac' });
  assert.match(f.out, /→ Building; B1@mac takes it\. You: cb next/, f.err);
  const b = await card(sql, { actor: 'orch@pc' });
  const s = cb(['stage', String(b), 'build', '--why', 'small'], { CB_ACTOR: 'orch@pc' });
  assert.match(s.out, new RegExp(`#${b} → Building; a builder takes it\\. You: cb next`), s.err);
  const n = await card(sql, { actor: 'orch@pc' });
  const none = cb(['stage', String(n), 'none', '--why', 'ops'], { CB_ACTOR: 'orch@pc' });
  assert.match(none.out, /→ Not staged; /, none.err);
  const again = cb(['stage', String(n), 'none', '--why', 'ops'], { CB_ACTOR: 'orch@pc' });
  assert.notEqual(again.code, 0);
  assert.match(again.err, new RegExp(`#${n} is not in the pipeline`));
});

test('cb resume, cb next and cb start point agents at what to do', async () => {
  const sql = await setup();
  const id = await atBuild(sql);
  await sql`select cb.page_set('the design text', task => ${String(id)}, actor => 'O1@mac')`;
  const nx = cb(['next', 'demo']);
  assert.match(nx.out, /stage: Building/, nx.err);
  assert.match(nx.out, /finish with: cb pass \d+ .*--pr/);
  assert.match(nx.out, /the design text/);
  const r = cb(['resume']);
  assert.match(r.out, /finish with:/, r.err);
  assert.match(r.out, /the design text/);
  assert.equal(JSON.parse(cb(['resume', '--json']).out).cards[0].id, id);
  assert.match(cb(['start']).out, /after a compaction or restart: cb resume/);
});

test('deferred output fixes: bug hint, stage case, why without stage, add help', async () => {
  await setup();
  const L = { CB_ACTOR: 'orch@pc' };
  const b = cb(['bug', 'demo', 'broken', '-b', 'what happened', '--stage', 'build', '--why', 'small'], L);
  assert.equal(b.code, 0, b.err);
  assert.ok(!/starts at design/.test(b.out), b.out);
  const d = cb(['bug', 'demo', 'broken2', '-b', 'what happened'], L);
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /starts at design; a small fix can skip it/);
  const up = cb(['add', 'demo', 'x', '--type', 'bug', '--stage', 'Build', '--why', 'small'], L);
  assert.equal(up.code, 0, up.err);
  const nw = cb(['add', 'demo', 'x', '--why', 'small'], L);
  assert.notEqual(nw.code, 0);
  assert.match(nw.err, /--stage build/);
  const nb = cb(['bug', 'demo', 'y', '-b', 'z', '--why', 'small'], L);
  assert.notEqual(nb.code, 0);
  assert.match(nb.err, /--stage build/);
  assert.ok(!/Defaults: -s backlog, -p/.test(readFileSync('cli/help.ts', 'utf8')));
});

test('start lists only cards this session can claim, in claim order', async () => {
  const sql = await setup();
  const mine = await atBuild(sql);                        // a builder can claim it
  await card(sql, { actor: 'orch@pc' });                  // a design card: B1 cannot
  const q = (await sql`select id from cb.task_queue('demo', 'B1@mac', 3)`).map((r: any) => Number(r.id));
  assert.deepEqual(q, [mine]);
  const s = cb(['start'], { HERDR_PANE_ID: 'p2' });
  const head = s.out.split('QUEUE HEAD')[1].split('\nNEXT')[0];
  assert.match(head, new RegExp(`#${mine} `), s.err);
  assert.equal((head.match(/#\d+ /g) ?? []).length, 1, head);
  assert.deepEqual(await take(sql, 'B1@mac'), q);         // the preview is what next takes
});

test('claim order: start previews exactly what successive claims take (P0, then area first, then queue order)', async () => {
  const sql = await setup();
  await sql`update cb.sessions set area = 'claims' where actor = 'B1@mac'`;
  const c1 = await atBuild(sql);
  const c2 = await atBuild(sql); await sql`update cb.tasks set labels = '{claims}' where id = ${c2}`;
  const c3 = await atBuild(sql); await sql`update cb.tasks set priority = 'P0' where id = ${c3}`;
  const q = (await sql`select id from cb.task_queue('demo', 'B1@mac', 3)`).map((r: any) => Number(r.id));
  assert.deepEqual(q, [c3, c2, c1]);
  const s = cb(['start'], { HERDR_PANE_ID: 'p2' });
  const shown = [...s.out.split('QUEUE HEAD')[1].split('\nNEXT')[0].matchAll(/#(\d+) /g)].map((m) => Number(m[1]));
  assert.deepEqual(shown, q, s.err);
  const taken = [...(await take(sql, 'B1@mac')), ...(await take(sql, 'B1@mac')), ...(await take(sql, 'B1@mac'))];
  assert.deepEqual(taken, q);
});

test('pipeline off: a staged card is shown and finished the old way', async () => {
  const sql = await setup();
  const id = await atBuild(sql);
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  await sql`update cb.sessions set role = null where actor = 'B1@mac'`; // roleless: it can claim an unstaged card
  const nx = cb(['next', 'demo']);
  assert.equal(nx.code, 0, nx.err);
  assert.match(nx.out, /stage: Not staged/);
  assert.match(nx.out, new RegExp(`finish with: cb done ${id} "<summary>"`));
  assert.ok(!/--pr/.test(nx.out), nx.out);
  const r = JSON.parse(cb(['resume', '--json']).out).cards[0];
  assert.deepEqual([r.stage, r.stage_words], [null, 'Not staged']);
  assert.match((await sql`select cb.next_step(${String(id)}) as s`)[0].s.takes_it, /B1@mac/);
});

test('--json on pass, fail and stage; resume header, answered questions', async () => {
  const sql = await setup();
  const id = await atBuild(sql);
  await sql`update cb.tasks set assignee = 'B1@mac', status = 'in_progress' where id = ${id}`;
  const p = JSON.parse(cb(['pass', String(id), 'built', '--pr', PR, '--json']).out);
  assert.deepEqual([p.id, p.stage, p.stage_words, p.takes_it], [id, 'review', 'In review', 'a reviewer']);
  const b = await card(sql, { actor: 'orch@pc' });
  assert.equal(JSON.parse(cb(['stage', String(b), 'build', '--why', 'small', '--json'], { CB_ACTOR: 'orch@pc' }).out).stage, 'build');
  const c = await atBuild(sql);
  await sql`update cb.tasks set assignee = 'B1@mac', status = 'in_progress' where id = ${c}`;
  await sql`update cb.sessions set area = 'claims', model = 'sonnet' where actor = 'B1@mac'`;
  const qid = Number((await sql`select cb.ask('demo', 'Which table holds it?', null, task_id => ${String(c)}, actor => 'B1@mac') as id`)[0].id);
  await sql`select cb.answer(${String(qid)}, 'the claims table', 'ahmed')`;
  const r = cb(['resume']);
  assert.match(r.out, /\(builder\) in demo, area claims, sonnet/, r.err);
  assert.match(r.out, new RegExp(`Q${qid} answered: Which table`));
  assert.match(cb(['resume'], { CB_ACTOR: 'R1@mac' }).out, /^R1@mac \(reviewer\) holds no cards\. Next: cb next/);
});

// --- final-review fix wave (#3598)
test('fix 2: a leftover approval question never reopens a closed card, and closing withdraws it', async () => {
  const sql = await setup(); const s = session();
  const { id, q } = await atApproval(sql);
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  await sql`select cb.task_done(${id}::text, 'done anyway', '{}', 'B1@mac')`;
  assert.deepEqual([(await row(sql, id)).status, (await row(sql, id)).stage], ['done', null]);
  assert.equal((await sql`select status from cb.questions where id = ${q}`)[0].status, 'withdrawn');
  // the answer path itself: a stale open question answered later leaves the closed card alone
  await sql`update cb.questions set status = 'open' where id = ${q}`;
  await sql`select cb.answer(${q}::text, 'Approve', 'ahmed')`;
  const r = await row(sql, id);
  assert.deepEqual([r.status, r.stage], ['done', null]);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and data ? 'digest'`)[0].n, 0);
  assert.equal((await sql`select status from cb.questions where id = ${q}`)[0].status, 'delivered');
  // pipeline on: the dashboard closes a card at approval, its question leaves Today
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  const b = await atApproval(sql);
  await sql`select cb.task_move(${b.id}::text, 'cancelled', 'not needed', 'ahmed')`;
  assert.equal((await sql`select status from cb.questions where id = ${b.q}`)[0].status, 'withdrawn');
  assert.equal((await row(sql, b.id)).stage, null);
  // the guard still holds while a card waits at approval
  const c = await atApproval(sql);
  await assert.rejects(() => s`select cb.withdraw(${c.q}::text, 'B1@mac')`, /is the approval for/);
});

test('fix 3: re-binding a pane as another actor takes the new role, area and model', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('mac', 'p1', 'W1@mac', 'demo', role => 'builder', area => 'claims', model => 'sonnet')`;
  await sql`select cb.iam('mac', 'p1', 'orch@mac', 'demo', model => 'opus')`;
  assert.equal((await sql`select cb._role('orch@mac') as r`)[0].r, 'lead');
  const [s] = await sql`select role, area, model from cb.sessions where pane = 'p1'`;
  assert.deepEqual({ ...s }, { role: null, area: null, model: 'opus' });
});

test('fix 4: re-approval after a send back to design goes to the same builder', async () => {
  const sql = await setup();
  const { id, q } = await atApproval(sql);
  await sql`select cb.answer(${q}::text, 'Approve', 'ahmed')`;
  assert.equal((await row(sql, id)).assignee, null); // first approval: unassigned
  await claim(sql, id, 'B1@mac'); await pass(sql, id, 'B1@mac', 'built', { pr: '#1' });
  await claim(sql, id, 'R1@mac'); await pass(sql, id, 'R1@mac');
  await claim(sql, id, 'orch@pc'); await pass(sql, id, 'orch@pc', 'm', { commit: 'abc' });
  await claim(sql, id, 'Q1@mac');
  await sql`select cb.stage_fail(${id}::text, 'design is off', 'design', 'Q1@mac')`;
  await claim(sql, id, 'O1@mac'); await pass(sql, id, 'O1@mac', 'redesigned');
  const [{ id: q2 }] = await sql`select id from cb.questions where approval_for = ${id} and status = 'open'`;
  await sql`select cb.answer(${q2}::text, 'Approve', 'ahmed')`;
  const r = await row(sql, id);
  assert.deepEqual([r.stage, r.status, r.assignee], ['build', 'next', 'B1@mac']);
});

test('fix 5: the lead passes a merge card without holding it, and every printed cb pass/fail has its argument', async () => {
  const sql = await setup();
  const id = await card(sql);
  await toStage(sql, id, 'merge');
  await sql`update cb.tasks set crew = '{"build":"B1@mac","review":"R1@mac"}' where id = ${id}`;
  await assert.rejects(() => pass(sql, id, 'R1@mac', 'x', { commit: 'abc' }), /merging is the lead's/);
  const lines: string[] = [];
  for (const st of ['design', 'build', 'review', 'merge', 'qa']) {
    await toStage(sql, id, st);
    lines.push((await sql`select cb._finish_line(t) as l from cb.tasks t where t.id = ${id}`)[0].l);
  }
  await toStage(sql, id, 'merge');
  lines.push(...(await sql`select cb.digest('demo') as d`)[0].d);
  for (const l of lines) for (const m of l.matchAll(/cb (pass|fail) \d+(?! "[^"]+")/g)) assert.fail(`bare ${m[0]} in: ${l}`);
  assert.ok(lines.some((l) => /reviewed: merge it, then cb pass \d+ "<what merged>" --commit <sha>/.test(l)), 'digest line 4 prints a valid pass');
  assert.equal((await pass(sql, id, 'orch@pc', 'merged', { commit: 'abc' }))[0].r, 'qa'); // not holding it
});

test('fix 6, 8, 9, 11: role-less pass, review move, close refusal wording, pipeline off message', async () => {
  const sql = await setup(); const s = session();
  const id = await atDesign(sql);
  await sql`insert into cb.sessions (machine, pane, actor, project) values ('mac','p20','X9@mac','demo')`;
  await sql`update cb.tasks set assignee = 'X9@mac' where id = ${id}`;
  await assert.rejects(() => pass(sql, id, 'X9@mac'), /owner or architect/);
  const b = await atBuild(sql);
  await assert.rejects(() => s`select cb.task_move(${b}::text, 'review', 'pr up', 'B1@mac')`, /is at Building: finish it with cb pass \d+ "<summary>" --pr <url>/);
  assert.equal((await row(sql, b)).status, 'next');
  await assert.rejects(() => s`select cb.task_done(${b}::text, 'done', '{}', 'B1@mac')`, /is at build: finish it with cb pass \d+ "<summary>" --pr <url> \(only Ahmed/);
  const d = await card(sql);
  await assert.rejects(() => s`select cb.task_move(${d}::text, 'cancelled', 'x', 'B1@mac')`, /is at design: finish it with cb page set/);
  const { id: a } = await atApproval(sql);
  await assert.rejects(() => s`select cb.task_move(${a}::text, 'done', 'x', 'B1@mac')`, /waiting for Ahmed/);
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  await assert.rejects(() => pass(sql, b, 'B1@mac'), /pipeline is off for demo: finish it with cb done \d+/);
  await assert.rejects(() => sql`select cb.stage_fail(${b}::text, 'x', null, 'R1@mac')`, /pipeline is off for demo: finish it with cb done \d+/);
});

test('fix 12: aliasing a project that has pages moves them, and a dashboard project move follows', async () => {
  const sql = await setup();
  await sql`select cb.ensure_project('old')`;
  await sql`select cb.project_pipeline('old', true, 'ahmed')`;
  const [{ id }] = await sql`select cb.task_add(project => 'old', title => 'x', actor => 'ahmed') as id`;
  await sql`select cb.page_set('the design', task => ${id}::text, actor => 'O1@mac')`;
  await sql`select cb.page_set('area notes', area => 'claims', project => 'old', actor => 'O1@mac')`;
  await sql`select cb.page_set('area notes demo', area => 'claims', project => 'demo', actor => 'O1@mac')`;
  await sql`select cb.project_alias('old', 'demo')`;
  assert.deepEqual((await sql`select distinct project from cb.pages`).map((r: any) => r.project), ['demo']);
  assert.equal((await sql`select count(*)::int n from cb.pages`)[0].n, 3);
  await sql`select cb.ensure_project('other')`;
  await sql`select cb.task_update(${id}::text, '{"project":"other"}', 'ahmed')`;
  assert.equal((await sql`select project from cb.pages where task_id = ${id}`)[0].project, 'other');
});

test('fix 14: the events index by actor exists', async () => {
  const sql = await freshDb(); clients.push(sql);
  assert.equal((await sql`select count(*)::int n from pg_indexes where schemaname = 'cb' and indexname = 'events_actor_at'`)[0].n, 1);
});

test('brief: every card carries its stage, so a Next card at merge or qa is not build work (#4340)', async () => {
  const sql = await setup();
  const build = await addCard(sql); await toStage(sql, build, 'build');
  const merge = await addCard(sql); await toStage(sql, merge, 'merge');
  const qa = await addCard(sql); await toStage(sql, qa, 'qa');
  const plain = Number((await sql`select cb.task_add(project => 'demo', title => 'pr', type => 'feature', status => 'next', actor => 'github') as id`)[0].id);
  const next = JSON.parse(cb(['brief', 'demo', '--json']).out).next;
  const by = (id: number) => next.find((t: any) => Number(t.id) === id);
  assert.deepEqual([build, merge, qa, plain].map((id) => [by(id).stage, by(id).stage_words]),
    [['build', 'Building'], ['merge', 'Merging to dev'], ['qa', 'Checking on dev against the design'], [null, null]]);
  // the fields agents already parse stay as they were
  for (const k of ['assignee', 'blocked_on', 'epic_id', 'id', 'labels', 'priority', 'project', 'rank', 'title', 'type', 'updated_at', 'waits_on'])
    assert.ok(k in by(qa), `next items keep ${k}`);
  // pipeline off: staged cards behave as normal cards, so no stage is shown
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  const off = (await sql`select cb.brief('demo') as b`)[0].b.next.find((t: any) => Number(t.id) === qa);
  assert.deepEqual([off.stage, off.stage_words], [null, null]);
});

test('text brief: a Next card at merge or qa says its stage; build work stays a plain line (#4340)', async () => {
  const sql = await setup();
  const build = await addCard(sql); await toStage(sql, build, 'build');
  const merge = await addCard(sql); await toStage(sql, merge, 'merge');
  const qa = await addCard(sql); await toStage(sql, qa, 'qa');
  const r = cb(['brief', 'demo']);
  assert.equal(r.code, 0, r.err);
  const lineOf = (id: number) => r.out.split('\n').find((l) => l.trim().startsWith(`#${id} `)) ?? '';
  assert.match(lineOf(merge), / · demo · Merging to dev$/);
  assert.match(lineOf(qa), / · demo · Checking on dev against the design$/);
  assert.match(lineOf(build), / · demo$/);
});

test('text brief: in progress, blocked and review cards say their stage; a blocked card says why (#4454)', async () => {
  const sql = await setup();
  const atReview = await addCard(sql); await toStage(sql, atReview, 'review');
  const atBuild = await addCard(sql); await toStage(sql, atBuild, 'build');
  await sql`update cb.tasks set status = 'in_progress', assignee = null where id in (${atReview}, ${atBuild})`;
  const approval = await addCard(sql); await toStage(sql, approval, 'approval');
  await sql`update cb.tasks set status = 'review' where id = ${approval}`;
  const said = await addCard(sql); await toStage(sql, said, 'build');
  await sql`select cb.task_move(${String(said)}, 'blocked', 'waits for the test key', 'orch@pc')`;
  const noted = await addCard(sql); await toStage(sql, noted, 'build');
  await sql`select cb.task_move(${String(noted)}, 'blocked', null, 'orch@pc')`;
  // line breaks and terminal controls (ESC, BEL, DEL, C1 CSI) never reach the screen
  await sql`select cb.log('demo', ${'first line\nsecond line\u0085\x1b\x07\x7f\x9b' + 'x'.repeat(200)}, ${String(noted)}, '{}', 'B1@mac')`;
  const bare = await addCard(sql); await toStage(sql, bare, 'build');
  await sql`select cb.task_move(${String(bare)}, 'blocked', null, 'orch@pc')`;
  // a reason restated on a card already blocked (a note event, no status change) replaces the old one, in brief and tick;
  // tick's "blocked since" stays the move into Blocked
  const restated = await addCard(sql); await toStage(sql, restated, 'build');
  await sql`select cb.task_move(${String(restated)}, 'blocked', 'reason A', 'orch@pc')`;
  await sql`update cb.events set at = now() - interval '2 hours' where task_id = ${restated}`;
  await sql`select cb.task_move(${String(restated)}, 'blocked', 'reason B', 'orch@pc')`;
  const ticked = (await sql`select cb.tick('demo') as t`)[0].t.blocked.find((x: any) => Number(x.id) === restated);
  assert.equal(ticked?.note, 'reason B');
  const r = cb(['brief', 'demo']);
  assert.equal(r.code, 0, r.err);
  const lineOf = (id: number) => r.out.split('\n').find((l) => l.trim().startsWith(`#${id} `)) ?? '';
  assert.match(lineOf(atReview), /^ {2}#\d+ P2 feature: c · demo · In review$/);
  assert.match(lineOf(atBuild), / · demo · Building$/);
  assert.match(lineOf(approval), / · demo · Waiting for your approval$/);
  assert.match(lineOf(said), / · demo · Building — why: waits for the test key$/);
  // no reason given with the move: the last note, on one line and cut short, never the status codes
  assert.match(lineOf(noted), / · demo · Building — no reason given; last note: first line second line x+…$/);
  assert.ok(lineOf(noted).length < 300, lineOf(noted));
  assert.match(lineOf(bare), / · demo · Building — no reason given$/);
  assert.match(lineOf(restated), / · demo · Building — why: reason B$/);
  assert.doesNotMatch(r.out, /→|\p{Cc}(?<!\n)/u);
  assert.equal(r.out.split('\n').filter((l) => /^x+/.test(l.trim()) || l.trim() === 'second line').length, 0, 'a note cannot add a line');
});

test('cb show and cb mine say the stage in words where brief does; show --json carries stage_words (#4512)', async () => {
  const sql = await setup();
  const atReview = await addCard(sql); await toStage(sql, atReview, 'review');
  await sql`update cb.tasks set status = 'in_progress', assignee = null where id = ${atReview}`;
  const held = await addCard(sql); await toStage(sql, held, 'build');
  await sql`update cb.tasks set status = 'in_progress', assignee = 'B1@mac' where id = ${held}`;
  const plain = Number((await sql`select cb.task_add(project => 'demo', title => 'pr', type => 'feature', status => 'next', actor => 'github') as id`)[0].id);
  const first = (id: number) => { const r = cb(['show', String(id)]); assert.equal(r.code, 0, r.err); return r.out.split('\n')[0]; };
  const json = (id: number) => JSON.parse(cb(['show', String(id), '--json']).out);
  // an unheld in-progress card at review reads as waiting for review, not as abandoned work; the holder stays where it was
  assert.equal(first(atReview), `#${atReview} [in_progress] P2 feature: c · demo · In review`);
  assert.equal(first(held), `#${held} [in_progress] P2 feature: c (B1@mac) · demo · Building`);
  assert.deepEqual([json(atReview).stage, json(atReview).stage_words], ['review', 'In review']);
  assert.equal(cb(['mine']).out, `#${held} [in_progress] P2 feature: c (B1@mac) · demo · Building`);
  // an unstaged card: no words, never the "not staged" placeholder
  assert.equal(first(plain), `#${plain} [next] P2 feature: pr · demo`);
  assert.equal(json(plain).stage_words, null);
  // Next names every stage but build, Design included, and the help says so (it said "only past build")
  const design = await addCard(sql);
  assert.match(cb(['brief', 'demo']).out.split('\n').find((l) => l.trim().startsWith(`#${design} `)) ?? '', / · demo · Design$/);
  const brief = cb(['help', 'brief']).out;
  assert.match(brief, /Next at every stage but build, Design included/);
  assert.doesNotMatch(brief, /only past build/);
  assert.match(cb(['help', 'show']).out, /stage_words/);
  // pipeline off: staged cards behave as normal cards, so no stage is shown
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  assert.equal(first(atReview), `#${atReview} [in_progress] P2 feature: c · demo`);
  assert.equal(json(atReview).stage_words, null);
  assert.equal(cb(['mine']).out, `#${held} [in_progress] P2 feature: c (B1@mac) · demo`);
  assert.doesNotMatch(cb(['show', String(atReview)]).out + cb(['mine']).out, /Not staged/);
});

test('cb mine and cb start read the stage words of a whole list in one query, not one per card (#4512 review I1)', async () => {
  const sql = await setup();
  await sql`select cb.ensure_project('old')`; // pipeline off
  const rows = [{ project: 'demo', stage: 'review' }, { project: 'demo', stage: 'build' }, { project: 'demo', stage: 'qa' },
    { project: 'demo', stage: 'review' }, { project: 'demo', stage: null }, { project: 'old', stage: 'build' }, { project: 'demo', stage: 'design' }];
  let n = 0;
  const counted = (s: any, ...v: any[]) => { n++; return sql(s, ...v); };
  assert.deepEqual(await stageWordsFor(counted, rows),
    ['In review', 'Building', 'Checking on dev against the design', 'In review', null, null, 'Design']);
  assert.equal(n, 1);
  assert.deepEqual(await stageWordsFor(counted, [{ project: 'demo', stage: null }]), [null]);
  assert.equal(n, 1, 'no staged card: no query');
});
