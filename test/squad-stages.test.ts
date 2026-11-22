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
