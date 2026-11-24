// Several repos inside one project (#3703, task 2): a card that touches several repos is built, reviewed and merged one
// part per repo; the card's stage is its least advanced part's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
const session = () => { const s = postgres(TEST_URL, { onnotice: () => {} }); clients.push(s); return s; };

function cb(args: string[], actor: string) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: actor, HERDR_PANE_ID: '', CB_MACHINE: 'pc', CLAUDE_CODE_MESSAGING_SOCKET: '' } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const QHS: any = {
  machines: { shaltoot: { herdr: null, board: 'F:/Work/claude-board' }, macbook: { herdr: 'macbook', board: '/Users/me/Work/claude-board' } },
  repos: {
    api: { home: true, paths: { shaltoot: 'F:/Work/QHS/api', macbook: '/Users/me/Work/QHS/api' } },
    dashboard: { paths: { shaltoot: 'F:/Work/QHS/dashboard', macbook: '/Users/me/Work/QHS/dashboard' } },
  },
  areas: [{ name: 'api', repo: 'api' }, { name: 'dashboard', repo: 'dashboard' }],
  roles: {
    lead: { count: 1, machine: 'shaltoot' },
    owner: { machine: 'shaltoot' },
    builder: { count: { api: 2, dashboard: 1 }, model: 'sonnet', machine: 'macbook' },
    reviewer: { count: { api: 1, dashboard: 1 }, machine: 'macbook' },
    qa: { count: 1, machine: 'macbook' },
  },
};
const API = 'https://github.com/o/api/pull/12';
const DASH = 'https://github.com/o/dash/pull/7';

// qhs: pipeline on, the QHS squad. orch@pc leads, qhs-O1@pc owns area api; B2 is a builder bound before repos (null: home)
async function setup() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('qhs'), cb.project_pipeline('qhs', true, 'ahmed')`;
  await sql`select cb.squad_set('qhs', ${sql.json(QHS)}, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area, repo) values
    ('pc','p1','orch@pc','qhs',null,null,null), ('pc','p2','qhs-O1@pc','qhs','owner','api',null),
    ('mac','p3','qhs-B1@mac','qhs','builder',null,'api'), ('mac','p4','qhs-dashboard-B1@mac','qhs','builder',null,'dashboard'),
    ('mac','p5','qhs-B2@mac','qhs','builder',null,null),
    ('mac','p6','qhs-R1@mac','qhs','reviewer',null,'api'), ('mac','p7','qhs-dashboard-R1@mac','qhs','reviewer',null,'dashboard'),
    ('mac','p8','qhs-Q1@mac','qhs','qa',null,null)`;
  return sql;
}
const claim = async (sql: any, actor: string, project = 'qhs') =>
  (await sql`select * from cb.task_claim(${project}, ${actor})`).map((r: any) => Number(r.id));
const pass = (sql: any, id: number, actor: string, summary = 'ok', links: any = {}, repo?: string) => repo === undefined
  ? sql`select cb.stage_pass(${id}::text, ${summary}, ${sql.json(links)}, ${actor}) as r`
  : sql`select cb.stage_pass(${id}::text, ${summary}, ${sql.json(links)}, ${actor}, ${repo}) as r`;
const fail = (sql: any, id: number, actor: string, why = 'no', to: string | null = null, repo?: string) => repo === undefined
  ? sql`select cb.stage_fail(${id}::text, ${why}, ${to}, ${actor}) as r`
  : sql`select cb.stage_fail(${id}::text, ${why}, ${to}, ${actor}, ${repo}) as r`;
const parts = async (sql: any, id: number) =>
  (await sql`select repo, stage, status, assignee, pr, commit from cb.task_parts where task_id = ${id} order by repo`).map((r: any) => ({ ...r }));
const card = async (sql: any, id: number) => ({ ...(await sql`select stage, status, assignee, links, repos from cb.tasks where id = ${id}`)[0] });
const approve = async (sql: any, id: number) => {
  const [q] = await sql`select id from cb.questions where approval_for = ${id} order by id desc limit 1`;
  await sql`select cb.answer(${q.id}::text, 'Approve', 'ahmed')`;
};

// a card with these repos, through design and Ahmed's Approve
async function approved(sql: any, repos = ['api', 'dashboard']) {
  const id = Number((await sql`select cb.task_add(project => 'qhs', title => 'c', type => 'feature', repos => ${sql.json(repos)}, actor => 'orch@pc') as id`)[0].id);
  await sql`update cb.tasks set assignee = 'qhs-O1@pc', status = 'in_progress' where id = ${id}`;
  await sql`select cb.page_set('the design', task => ${String(id)}, actor => 'qhs-O1@pc')`;
  await pass(sql, id, 'qhs-O1@pc', 'designed');
  await approve(sql, id);
  return id;
}
async function atReview(sql: any) {
  const id = await approved(sql);
  await claim(sql, 'qhs-B1@mac'); await claim(sql, 'qhs-dashboard-B1@mac');
  await pass(sql, id, 'qhs-B1@mac', 'built', { pr: API });
  await pass(sql, id, 'qhs-dashboard-B1@mac', 'built', { pr: DASH });
  return id;
}
async function atMerge(sql: any) {
  const id = await atReview(sql);
  await claim(sql, 'qhs-R1@mac'); await claim(sql, 'qhs-dashboard-R1@mac');
  await pass(sql, id, 'qhs-R1@mac', 'GO'); await pass(sql, id, 'qhs-dashboard-R1@mac', 'GO');
  return id;
}

// A parts card stays in Next and unheld while its parts move, so its changes reach sessions by inbox next_work
// (a stage change, or a change to a part of the session's repo) and by direct messages to part holders
const inbox = async (sql: any, pane: string, after = 0) => (await sql`select cb.inbox('mac', ${pane}, ${after}) as i`)[0].i;
const top = async (sql: any) => Number((await sql`select max(id) as m from cb.events`)[0].m);
const msgs = async (sql: any, pane: string) => (await inbox(sql, pane)).messages.map((m: any) => m.summary);

test('a two-repo card enters build with two parts', async () => {
  const sql = await setup();
  const id = await approved(sql);
  assert.deepEqual(await parts(sql, id), [
    { repo: 'api', stage: 'build', status: 'next', assignee: null, pr: null, commit: null },
    { repo: 'dashboard', stage: 'build', status: 'next', assignee: null, pr: null, commit: null }]);
  const c = await card(sql, id);
  assert.deepEqual([c.stage, c.status, c.assignee], ['build', 'next', null]);
  const one = await approved(sql, ['dashboard']);
  assert.deepEqual(await parts(sql, one), []);
  assert.equal((await card(sql, one)).stage, 'build');
  // the lead's skip to build opens them too
  const bug = Number((await sql`select cb.task_add(project => 'qhs', title => 'b', type => 'bug', actor => 'orch@pc') as id`)[0].id);
  await sql`select cb.stage_set(${bug}::text, 'build', 'small', 'orch@pc', repos => '["dashboard","api"]')`;
  assert.deepEqual((await parts(sql, bug)).map((p: any) => [p.repo, p.stage]), [['api', 'build'], ['dashboard', 'build']]);
});

test('each builder claims its own repo\'s part', async () => {
  const sql = await setup();
  const id = await approved(sql);
  const rank = async () => Number((await sql`select rank from cb.tasks where id = ${id}`)[0].rank);
  const r0 = await rank();
  assert.deepEqual(await claim(sql, 'qhs-B1@mac'), [id]);
  let p = await parts(sql, id);
  assert.deepEqual([p[0].status, p[0].assignee, p[1].status, p[1].assignee], ['in_progress', 'qhs-B1@mac', 'next', null]);
  let c = await card(sql, id);
  assert.deepEqual([c.stage, c.status, c.assignee], ['build', 'next', null]);
  // B2 has no repo: it is the home repo (api), whose part is taken; it never gets the dashboard part
  assert.deepEqual(await claim(sql, 'qhs-B2@mac'), []);
  assert.deepEqual(await claim(sql, 'qhs-dashboard-B1@mac'), [id]);
  p = await parts(sql, id);
  assert.deepEqual([p[1].status, p[1].assignee], ['in_progress', 'qhs-dashboard-B1@mac']);
  assert.deepEqual(await claim(sql, 'qhs-B2@mac'), []);
  c = await card(sql, id);
  // the parts carry the status: the card stays in Next, in its place
  assert.deepEqual([c.status, c.assignee, await rank()], ['next', null, r0]);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and summary = 'claimed by qhs-dashboard-B1@mac (part dashboard)'`)[0].n, 1);
});

test('pipeline off: a parts card is claimed as a card', async () => {
  const sql = await setup();
  const id = await approved(sql);
  await sql`select cb.project_pipeline('qhs', false, 'ahmed')`;
  assert.deepEqual(await claim(sql, 'qhs-dashboard-B1@mac'), [id]);
  const c = await card(sql, id);
  assert.deepEqual([c.status, c.assignee], ['in_progress', 'qhs-dashboard-B1@mac']);
  assert.deepEqual((await parts(sql, id)).map((p: any) => p.assignee), [null, null]);
});

test('a parts card leaves the pipeline only with no part in work, and takes its parts with it', async () => {
  const sql = await setup();
  const none = (id: number) => sql`select cb.stage_set(${id}::text, 'none', 'ops only', 'orch@pc')`;
  const count = async (id: number) => (await sql`select count(*)::int n from cb.task_parts where task_id = ${id}`)[0].n;
  // a reviewer still holding its part while the card is back at build, and the builder's hold after the NO-GO
  const b = await atReview(sql);
  await claim(sql, 'qhs-R1@mac'); await claim(sql, 'qhs-dashboard-R1@mac');
  await fail(sql, b, 'qhs-dashboard-R1@mac', 'wrong');
  assert.equal((await card(sql, b)).stage, 'build');
  await assert.rejects(() => none(b), /#\d+ has parts in work: api \(qhs-R1@mac\), dashboard \(qhs-dashboard-B1@mac\)/);
  const a = await approved(sql);
  assert.deepEqual(await claim(sql, 'qhs-B1@mac'), [a]);
  await assert.rejects(() => none(a), /#\d+ has parts in work: api \(qhs-B1@mac\)/);
  // nobody holds a part: none drops them
  const c = await approved(sql);
  assert.equal(await count(c), 2);
  await none(c);
  assert.deepEqual([(await card(sql, c)).stage, await count(c)], [null, 0]);
  // closed from the dashboard: the parts go too
  await sql`select cb.task_move(${a}::text, 'cancelled', 'not needed', 'ahmed')`;
  assert.deepEqual([(await card(sql, a)).status, await count(a)], ['cancelled', 0]);
});

test('two builders of different repos claiming one card: each gets its own part or nothing, never the other\'s', async () => {
  const sql = await setup();
  const id = await approved(sql);
  // a claim in flight holds the card row: the other repo's builder gets nothing this once
  let locked!: () => void, release!: () => void;
  const gotLock = new Promise<void>((r) => { locked = r; }), held = new Promise<void>((r) => { release = r; });
  const tx = session().begin(async (t: any) => { await t`select id from cb.tasks where id = ${id} for update`; locked(); await held; });
  await gotLock;
  assert.deepEqual(await claim(sql, 'qhs-dashboard-B1@mac'), []);
  release(); await tx;
  assert.deepEqual(await claim(sql, 'qhs-dashboard-B1@mac'), [id]);
  assert.deepEqual(await claim(sql, 'qhs-B1@mac'), [id]);
  // at once
  const two = await approved(sql);
  const got = await Promise.all([claim(session(), 'qhs-B1@mac'), claim(session(), 'qhs-dashboard-B1@mac')]);
  assert.ok(got.flat().every((x) => x === two), JSON.stringify(got));
  const p = await parts(sql, two);
  assert.ok([null, 'qhs-B1@mac'].includes(p[0].assignee), p[0].assignee);
  assert.ok([null, 'qhs-dashboard-B1@mac'].includes(p[1].assignee), p[1].assignee);
});

test('a one-repo card goes only to builders and reviewers of its repo', async () => {
  const sql = await setup();
  const id = await approved(sql, ['dashboard']);
  assert.deepEqual(await claim(sql, 'qhs-B1@mac'), []);
  assert.deepEqual(await claim(sql, 'qhs-B2@mac'), []);
  assert.deepEqual(await claim(sql, 'qhs-dashboard-B1@mac'), [id]);
  const c = await card(sql, id);
  assert.deepEqual([c.status, c.assignee], ['in_progress', 'qhs-dashboard-B1@mac']);
  // no parts: --repo is refused, not ignored
  await assert.rejects(() => pass(sql, id, 'qhs-dashboard-B1@mac', 'built', { pr: '#5' }, 'dashboard'), /#\d+ has no parts: drop --repo/);
  assert.equal((await pass(sql, id, 'qhs-dashboard-B1@mac', 'built', { pr: '#5' }))[0].r, 'review');
  assert.deepEqual(await claim(sql, 'qhs-R1@mac'), []);
  assert.deepEqual(await claim(sql, 'qhs-dashboard-R1@mac'), [id]);
  await assert.rejects(() => fail(sql, id, 'qhs-dashboard-R1@mac', 'wrong', null, 'dashboard'), /#\d+ has no parts: drop --repo/);
  // a staged card with no repos in a multi-repo project: no builder takes it
  const bare = Number((await sql`select cb.task_add(project => 'qhs', title => 'b', type => 'bug', actor => 'orch@pc') as id`)[0].id);
  await sql`select cb._stage_move(${bare}, 'build', null, 'x')`;
  assert.deepEqual(await claim(sql, 'qhs-B1@mac'), []);
  assert.deepEqual(await claim(sql, 'qhs-dashboard-B1@mac'), []);
});

test('the card leaves build when every part has its PR', async () => {
  const sql = await setup();
  const id = await approved(sql);
  await claim(sql, 'qhs-B1@mac'); await claim(sql, 'qhs-dashboard-B1@mac');
  await assert.rejects(() => pass(sql, id, 'qhs-B1@mac', 'built', { pr: '#12' }),
    /give the full pull request URL: https:\/\/github\.com\/<owner>\/<repo>\/pull\/<n>/);
  await assert.rejects(() => pass(sql, id, 'qhs-B1@mac', 'built'), /give the pull request: --pr <url>/);
  await assert.rejects(() => pass(sql, id, 'qhs-B2@mac', 'built', { pr: API }), /you hold no part of #\d+: claim it first \(cb next\)/);
  assert.equal((await pass(sql, id, 'qhs-B1@mac', 'built', { pr: API }))[0].r, 'build');
  let c = await card(sql, id);
  assert.deepEqual([c.stage, c.status, c.assignee, c.links.pr, c.links['pr:api']], ['build', 'next', null, API, API]);
  assert.deepEqual((await parts(sql, id)).map((p: any) => [p.stage, p.status, p.assignee, p.pr]),
    [['review', 'next', null, API], ['build', 'in_progress', 'qhs-dashboard-B1@mac', null]]);
  // the part's pass is on the card's history although the card stayed
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and summary = 'api: built' and data ->> 'repo' = 'api'`)[0].n, 1);
  // the api part's PR is not the dashboard part's
  await assert.rejects(() => pass(sql, id, 'qhs-dashboard-B1@mac', 'built'), /give the pull request: --pr <url>/);
  assert.equal((await pass(sql, id, 'qhs-dashboard-B1@mac', 'built', { pr: DASH }))[0].r, 'review');
  c = await card(sql, id);
  assert.deepEqual([c.stage, c.status, c.assignee, c.links.pr, c.links['pr:api'], c.links['pr:dashboard']], ['review', 'next', null, API, API, DASH]);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and summary = 'dashboard: built' and data ? 'stage'`)[0].n, 1);
});

test('review is per part', async () => {
  const sql = await setup();
  const id = await atReview(sql);
  // its builder may not review it
  await sql`update cb.sessions set role = 'reviewer' where actor = 'qhs-B1@mac'`;
  assert.deepEqual(await claim(sql, 'qhs-B1@mac'), []);
  await sql`update cb.task_parts set assignee = 'qhs-B1@mac', status = 'in_progress' where task_id = ${id} and repo = 'api'`;
  await assert.rejects(() => pass(sql, id, 'qhs-B1@mac', 'GO'), /you built it/);
  await sql`update cb.task_parts set assignee = null, status = 'next' where task_id = ${id} and repo = 'api'`;
  await sql`update cb.sessions set role = 'builder' where actor = 'qhs-B1@mac'`;
  assert.deepEqual(await claim(sql, 'qhs-R1@mac'), [id]);
  assert.deepEqual((await parts(sql, id)).map((p: any) => [p.status, p.assignee]), [['in_progress', 'qhs-R1@mac'], ['next', null]]);
  assert.equal((await pass(sql, id, 'qhs-R1@mac', 'GO'))[0].r, 'review');
  assert.deepEqual((await parts(sql, id)).map((p: any) => [p.stage, p.assignee]), [['merge', null], ['review', null]]);
  assert.equal((await card(sql, id)).stage, 'review');
  assert.deepEqual(await claim(sql, 'qhs-dashboard-R1@mac'), [id]);
  assert.equal((await fail(sql, id, 'qhs-dashboard-R1@mac', 'the error path is missing'))[0].r, 'build');
  assert.deepEqual((await parts(sql, id)).map((p: any) => [p.repo, p.stage, p.status, p.assignee]),
    [['api', 'merge', 'next', null], ['dashboard', 'build', 'next', 'qhs-dashboard-B1@mac']]);
  const c = await card(sql, id);
  assert.deepEqual([c.stage, c.status, c.assignee], ['build', 'next', null]);
  // the api part waits at merge, but the card is not there yet
  await assert.rejects(() => pass(sql, id, 'orch@pc', 'merged', { commit: 'abc1234' }, 'api'), /#\d+ is at Building, not merging yet/);
  assert.deepEqual(await claim(sql, 'qhs-B1@mac'), []);
  assert.deepEqual(await claim(sql, 'qhs-dashboard-B1@mac'), [id]);
});

test('a reviewer holding its part when another part is sent back still passes or fails it', async () => {
  const sql = await setup();
  const id = await atReview(sql);
  await claim(sql, 'qhs-R1@mac'); await claim(sql, 'qhs-dashboard-R1@mac');
  await fail(sql, id, 'qhs-dashboard-R1@mac', 'wrong');
  assert.equal((await card(sql, id)).stage, 'build');
  assert.equal((await pass(sql, id, 'qhs-R1@mac', 'GO'))[0].r, 'build');
  assert.deepEqual((await parts(sql, id)).map((p: any) => p.stage), ['merge', 'build']);
});

test('merge is the lead\'s, per repo', async () => {
  const sql = await setup();
  const id = await atMerge(sql);
  let c = await card(sql, id);
  assert.deepEqual([c.stage, c.status, c.assignee], ['merge', 'next', null]);
  await assert.rejects(() => pass(sql, id, 'orch@pc', 'merged', { commit: 'abc1234' }), /give the repo: --repo <repo> \(parts: api, dashboard\)/);
  await assert.rejects(() => pass(sql, id, 'qhs-B1@mac', 'merged', { commit: 'abc1234' }, 'api'), /merging is the lead's/);
  await assert.rejects(() => pass(sql, id, 'orch@pc', 'merged', {}, 'api'), /give the merge commit: --commit <sha>/);
  assert.equal((await pass(sql, id, 'orch@pc', 'merged', { commit: 'abc1234' }, 'api'))[0].r, 'merge');
  await assert.rejects(() => pass(sql, id, 'orch@pc', 'again', { commit: 'abc9' }, 'api'), /part api of #\d+ is not waiting to merge/);
  const r = cb(['pass', String(id), 'merged', '--repo', 'dashboard', '--commit', 'def5678'], 'orch@pc');
  assert.equal(r.code, 0, r.err);
  c = await card(sql, id);
  assert.deepEqual([c.stage, c.status, c.assignee], ['qa', 'next', null]);
  assert.deepEqual([c.links.commit, c.links['commit:api'], c.links['commit:dashboard']], ['abc1234', 'abc1234', 'def5678']);
  assert.deepEqual((await parts(sql, id)).map((p: any) => [p.stage, p.commit]), [['merged', 'abc1234'], ['merged', 'def5678']]);
  // a qa session that built a part does not check the card
  await sql`update cb.sessions set role = 'qa' where actor = 'qhs-dashboard-B1@mac'`;
  assert.deepEqual(await claim(sql, 'qhs-dashboard-B1@mac'), []);
  assert.deepEqual(await claim(sql, 'qhs-Q1@mac'), [id]);
  // nor passes it when the lead hands it the card
  await sql`select cb.task_update(${id}::text, '{"assignee":"qhs-dashboard-B1@mac"}', 'orch@pc')`;
  await assert.rejects(() => pass(sql, id, 'qhs-dashboard-B1@mac', 'checked'), /you built it: another qa session checks it/);
});

test('the digest names a parts card nobody can take only when a part is free and nobody live can take it', async () => {
  const sql = await setup();
  const nobody = async (id: number) => ((await sql`select cb.digest('qhs') as d`)[0].d as string[])
    .some((l) => new RegExp(`#${id} \\(Building, no live session can take it\\)`).test(l));
  // card at build, its api part ahead at review, its dashboard part in work: nothing to report
  const busy = await approved(sql);
  await claim(sql, 'qhs-B1@mac'); await claim(sql, 'qhs-dashboard-B1@mac');
  await pass(sql, busy, 'qhs-B1@mac', 'built', { pr: API });
  // a free dashboard part with no live dashboard builder: reported
  const free = await approved(sql);
  assert.deepEqual(await claim(sql, 'qhs-B1@mac'), [free]);
  await sql`update cb.sessions set last_seen = now() - interval '11 minutes' where actor = 'qhs-dashboard-B1@mac'`;
  assert.equal(await nobody(busy), false);
  assert.equal(await nobody(free), true);
});

test('a QA fail names the repo', async () => {
  const sql = await setup();
  const id = await atMerge(sql);
  await pass(sql, id, 'orch@pc', 'merged', { commit: 'abc1234' }, 'api');
  await pass(sql, id, 'orch@pc', 'merged', { commit: 'def5678' }, 'dashboard');
  assert.deepEqual(await claim(sql, 'qhs-Q1@mac'), [id]);
  await assert.rejects(() => fail(sql, id, 'qhs-Q1@mac', 'the date is wrong'),
    /name the repo that fails: cb fail \d+ --repo <repo> "<why>" \(parts: api, dashboard\)/);
  const r = cb(['fail', String(id), 'the date is wrong', '--repo', 'dashboard'], 'qhs-Q1@mac');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual((await parts(sql, id)).map((p: any) => [p.repo, p.stage, p.status, p.assignee, p.commit]),
    [['api', 'merged', 'next', null, 'abc1234'], ['dashboard', 'build', 'next', 'qhs-dashboard-B1@mac', null]]);
  assert.deepEqual(await msgs(sql, 'p4'), [`#${id} part dashboard is back with you at build: the date is wrong`]);
  let c = await card(sql, id);
  assert.deepEqual([c.stage, c.status, c.assignee], ['build', 'next', null]);
  // the follow-up PR, its review and merge bring the card back to qa
  const DASH2 = 'https://github.com/o/dash/pull/8';
  assert.deepEqual(await claim(sql, 'qhs-dashboard-B1@mac'), [id]);
  assert.equal((await pass(sql, id, 'qhs-dashboard-B1@mac', 'fixed', { pr: DASH2 }))[0].r, 'review');
  assert.deepEqual(await claim(sql, 'qhs-dashboard-R1@mac'), [id]);
  assert.equal((await pass(sql, id, 'qhs-dashboard-R1@mac', 'GO'))[0].r, 'merge');
  await assert.rejects(() => pass(sql, id, 'orch@pc', 'merged', {}, 'dashboard'), /give the merge commit: --commit <sha>/);
  assert.equal((await pass(sql, id, 'orch@pc', 'merged', { commit: 'fff0001' }, 'dashboard'))[0].r, 'qa');
  c = await card(sql, id);
  assert.deepEqual([c.stage, c.links.pr, c.links['pr:dashboard'], c.links['commit:dashboard'], c.links.commit], ['qa', API, DASH2, 'fff0001', 'abc1234']);
  // back to design from qa: re-approval reopens every part without its old commit
  assert.deepEqual(await claim(sql, 'qhs-Q1@mac'), [id]);
  await fail(sql, id, 'qhs-Q1@mac', 'the design misses a case', 'design');
  await pass(sql, id, 'qhs-O1@pc', 'redesigned');
  await approve(sql, id);
  assert.deepEqual((await parts(sql, id)).map((p: any) => [p.stage, p.commit, p.pr]), [['build', null, API], ['build', null, DASH2]]);
});

test('--to design resets the card; re-approval reopens every part with its builder and PR', async () => {
  const sql = await setup();
  const id = await atReview(sql);
  await claim(sql, 'qhs-R1@mac');
  assert.equal((await fail(sql, id, 'qhs-R1@mac', 'the contract is wrong', 'design'))[0].r, 'design');
  const c = await card(sql, id);
  assert.deepEqual([c.stage, c.assignee], ['design', 'qhs-O1@pc']);
  assert.deepEqual((await parts(sql, id)).map((p: any) => [p.status, p.assignee]), [['next', null], ['next', null]]);
  await sql`select cb.task_update(${id}::text, '{"repos":["api"]}', 'qhs-O1@pc')`;
  assert.equal((await pass(sql, id, 'qhs-O1@pc', 'redesigned'))[0].r, 'approval');
  await approve(sql, id);
  assert.deepEqual(await parts(sql, id), [{ repo: 'api', stage: 'build', status: 'next', assignee: 'qhs-B1@mac', pr: API, commit: null }]);
  const b = await card(sql, id);
  assert.deepEqual([b.stage, b.status, b.assignee], ['build', 'next', null]);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id}
    and summary = ${'part dashboard dropped: close its PR ' + DASH} and data ->> 'digest' = 'true'`)[0].n, 1);
  assert.deepEqual(await claim(sql, 'qhs-B2@mac'), []);
  assert.deepEqual(await claim(sql, 'qhs-B1@mac'), [id]);
  assert.equal((await pass(sql, id, 'qhs-B1@mac', 'rebuilt'))[0].r, 'review');  // its PR is kept
});

test('an idle reviewer is pushed a parts card once its last part is built', async () => {
  const sql = await setup();
  const id = await approved(sql);
  await claim(sql, 'qhs-B1@mac'); await claim(sql, 'qhs-dashboard-B1@mac');
  await pass(sql, id, 'qhs-B1@mac', 'built', { pr: API });
  const e0 = await top(sql);
  await pass(sql, id, 'qhs-dashboard-B1@mac', 'built', { pr: DASH });
  assert.deepEqual((await inbox(sql, 'p6', e0)).next_work.map((w: any) => Number(w.id)), [id]);
  assert.deepEqual((await inbox(sql, 'p7', e0)).next_work.map((w: any) => Number(w.id)), [id]);
  // a builder has nothing to take there
  assert.deepEqual((await inbox(sql, 'p5', e0)).next_work, []);
});

test('a NO-GO or a QA fail on a part messages its builder', async () => {
  const sql = await setup();
  const id = await atReview(sql);
  await claim(sql, 'qhs-R1@mac');
  await fail(sql, id, 'qhs-R1@mac', 'the error path is missing');
  assert.deepEqual(await msgs(sql, 'p3'), [`#${id} part api is back with you at build: the error path is missing`]);
  assert.deepEqual(await msgs(sql, 'p4'), []);
  // the builder is idle: the card is pushed too
  assert.ok((await inbox(sql, 'p3')).next_work.some((w: any) => Number(w.id) === id));
});

test('--to design and a cancel message every part holder; re-approval messages each builder it gives a part back', async () => {
  const sql = await setup();
  const id = await atReview(sql);
  await claim(sql, 'qhs-R1@mac'); await claim(sql, 'qhs-dashboard-R1@mac');
  await fail(sql, id, 'qhs-R1@mac', 'the contract is wrong', 'design');
  assert.deepEqual((await parts(sql, id)).map((p: any) => p.assignee), [null, null]);
  assert.deepEqual(await msgs(sql, 'p7'), [`#${id} went back to design: the contract is wrong. Your part dashboard waits for re-approval`]);
  assert.deepEqual(await msgs(sql, 'p6'), [], 'the reviewer who sent it back is not told');
  await pass(sql, id, 'qhs-O1@pc', 'redesigned');
  await approve(sql, id);
  assert.deepEqual(await msgs(sql, 'p3'), [`#${id} part api is back with you at build`]);
  assert.deepEqual(await msgs(sql, 'p4'), [`#${id} part dashboard is back with you at build`]);
  // Ahmed cancels it from the dashboard: both builders hold their parts
  await sql`update cb.tasks set status = 'cancelled' where id = ${id}`;
  assert.deepEqual(await parts(sql, id), []);
  assert.equal((await msgs(sql, 'p3'))[1], `#${id} is cancelled: your part api is closed`);
  assert.equal((await msgs(sql, 'p4'))[1], `#${id} is cancelled: your part dashboard is closed`);
});

test('a NO-GO while the card is already at build pushes the builder by its repo', async () => {
  const sql = await setup();
  const id = await atReview(sql);
  await claim(sql, 'qhs-R1@mac'); await claim(sql, 'qhs-dashboard-R1@mac');
  await fail(sql, id, 'qhs-dashboard-R1@mac', 'the chart is wrong');
  assert.equal((await card(sql, id)).stage, 'build');
  const e0 = await top(sql);
  await fail(sql, id, 'qhs-R1@mac', 'the error path is missing');
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and id > ${e0} and data ? 'stage'`)[0].n, 0,
    'the card stays at build: only the repo key carries it');
  assert.deepEqual((await inbox(sql, 'p3', e0)).next_work.map((w: any) => Number(w.id)), [id]);
  assert.deepEqual((await inbox(sql, 'p4', e0)).next_work, [], 'not the dashboard builder: nothing changed in its repo');
  assert.deepEqual((await inbox(sql, 'p5', e0)).next_work, [], 'another api builder: the part is B1\'s');
});

test('a builder bound with a stale main claims the home repo\'s part', async () => {
  const sql = await setup();
  await sql`insert into cb.sessions (machine, pane, actor, project, role, repo) values ('mac','p9','qhs-B3@mac','qhs','builder','main')`;
  const id = await approved(sql);
  assert.deepEqual(await claim(sql, 'qhs-B3@mac'), [id]);
  assert.deepEqual((await parts(sql, id)).map((p: any) => [p.repo, p.status, p.assignee]),
    [['api', 'in_progress', 'qhs-B3@mac'], ['dashboard', 'next', null]]);
});

test('a QA fail by repo reaches its builder while it is busy elsewhere', async () => {
  const sql = await setup();
  const id = await atMerge(sql);
  await pass(sql, id, 'orch@pc', 'merged', { commit: 'abc1234' }, 'api');
  await pass(sql, id, 'orch@pc', 'merged', { commit: 'def5678' }, 'dashboard');
  assert.deepEqual(await claim(sql, 'qhs-Q1@mac'), [id]);
  const other = await approved(sql, ['api']);
  assert.deepEqual(await claim(sql, 'qhs-B1@mac'), [other]);
  const e0 = await top(sql);
  const r = cb(['fail', String(id), 'the total is wrong', '--repo', 'api'], 'qhs-Q1@mac');
  assert.equal(r.code, 0, r.err);
  const i = await inbox(sql, 'p3', e0);
  assert.deepEqual(i.messages.map((m: any) => m.summary), [`#${id} part api is back with you at build: the total is wrong`]);
  assert.deepEqual(i.next_work, [], 'busy: the message is how it hears');
});

test('a part opened by a repos edit at build is pushed to its repo\'s builders', async () => {
  const sql = await setup();
  const id = Number((await sql`select cb.task_add(project => 'qhs', title => 'b', type => 'bug', actor => 'orch@pc') as id`)[0].id);
  await sql`select cb._stage_move(${id}, 'build', null, 'x')`;
  const e0 = await top(sql);
  await sql`select cb.task_update(${id}::text, '{"repos":["api","dashboard"]}', 'orch@pc')`;
  assert.deepEqual((await inbox(sql, 'p3', e0)).next_work.map((w: any) => Number(w.id)), [id]);
  assert.deepEqual((await inbox(sql, 'p4', e0)).next_work.map((w: any) => Number(w.id)), [id]);
  assert.deepEqual((await inbox(sql, 'p6', e0)).next_work, [], 'a reviewer has nothing to take yet');
});

// No session path leaves a holder on a part at re-approval today (--to design clears them): set directly, as a
// dashboard edit or a later path could leave one
test('re-approval tells a part\'s old holder when its part is dropped or goes back to its builder', async () => {
  const sql = await setup();
  const id = await atReview(sql);
  await claim(sql, 'qhs-R1@mac');
  await fail(sql, id, 'qhs-R1@mac', 'the contract is wrong', 'design');
  await sql`select cb.task_update(${id}::text, '{"repos":["api"]}', 'qhs-O1@pc')`;
  await sql`update cb.task_parts set assignee = 'qhs-B2@mac', status = 'in_progress' where task_id = ${id} and repo = 'api'`;
  await sql`update cb.task_parts set assignee = 'qhs-dashboard-R1@mac' where task_id = ${id} and repo = 'dashboard'`;
  await pass(sql, id, 'qhs-O1@pc', 'redesigned');
  await approve(sql, id);
  assert.deepEqual(await msgs(sql, 'p5'), [`#${id} part api went back to build: you no longer hold it`]);
  assert.deepEqual(await msgs(sql, 'p7'), [`#${id} part dashboard was dropped: you no longer hold it`]);
  assert.deepEqual(await msgs(sql, 'p3'), [`#${id} part api is back with you at build`]);
});

test('one-repo card: its events and inbox are unchanged (pin)', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo'), cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area) values
    ('mac','p1','O1@mac','demo','owner','claims'), ('mac','p2','B1@mac','demo','builder',null),
    ('mac','p3','R1@mac','demo','reviewer',null), ('pc','p4','orch@pc','demo',null,null)`;
  const id = Number((await sql`select cb.task_add(project => 'demo', title => 'c', type => 'bug', labels => '["claims"]', actor => 'orch@pc') as id`)[0].id);
  await claim(sql, 'O1@mac', 'demo');
  await sql`select cb.page_set('the design', task => ${String(id)}, actor => 'O1@mac')`;
  await pass(sql, id, 'O1@mac', 'designed');
  await approve(sql, id);
  await claim(sql, 'B1@mac', 'demo');
  const e0 = await top(sql);
  await pass(sql, id, 'B1@mac', 'built', { pr: 'https://x/pull/1' });
  const strip = (es: any[]) => es.map(({ id: _, ...e }: any) => e);
  let r = await inbox(sql, 'p3', e0);
  assert.deepEqual(r.next_work, [{ id, title: 'c', priority: 'P2' }]);
  assert.deepEqual([r.events, r.messages], [[], []]);
  assert.deepEqual(strip((await inbox(sql, 'p2', e0)).events), []);
  await claim(sql, 'R1@mac', 'demo');
  const e1 = await top(sql);
  await fail(sql, id, 'R1@mac', 'no tests');
  r = await inbox(sql, 'p2', e1);
  assert.deepEqual(strip(r.events), [{ task_id: id, kind: 'moved', summary: 'no tests', actor: 'R1@mac', title: 'c', status: 'next' }]);
  assert.deepEqual(r.next_work, [{ id, title: 'c', priority: 'P2' }]);
  assert.deepEqual(r.messages, []);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and kind = 'message'`)[0].n, 0);
  await sql`update cb.tasks set status = 'cancelled' where id = ${id}`;
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and kind = 'message'`)[0].n, 0);
});

test('one-repo cards work exactly as today', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo'), cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area) values
    ('mac','p1','O1@mac','demo','owner','claims'), ('mac','p2','B1@mac','demo','builder',null),
    ('mac','p3','R1@mac','demo','reviewer',null), ('pc','p4','orch@pc','demo',null,null), ('mac','p5','Q1@mac','demo','qa',null)`;
  const id = Number((await sql`select cb.task_add(project => 'demo', title => 'c', type => 'bug', labels => '["claims"]', actor => 'orch@pc') as id`)[0].id);
  assert.deepEqual(await claim(sql, 'O1@mac', 'demo'), [id]);
  await sql`select cb.page_set('the design', task => ${String(id)}, actor => 'O1@mac')`;
  assert.equal((await pass(sql, id, 'O1@mac', 'designed'))[0].r, 'approval');
  await approve(sql, id);
  assert.deepEqual(await claim(sql, 'B1@mac', 'demo'), [id]);
  assert.equal((await pass(sql, id, 'B1@mac', 'built', { pr: 'https://x/pull/1' }))[0].r, 'review');
  assert.deepEqual(await claim(sql, 'R1@mac', 'demo'), [id]);
  assert.equal((await pass(sql, id, 'R1@mac', 'reviewed'))[0].r, 'merge');
  assert.equal((await pass(sql, id, 'orch@pc', 'merged', { commit: 'abc1234' }))[0].r, 'qa');
  assert.deepEqual(await claim(sql, 'Q1@mac', 'demo'), [id]);
  assert.equal((await pass(sql, id, 'Q1@mac', 'checked'))[0].r, 'done');
  assert.equal((await sql`select count(*)::int n from cb.task_parts`)[0].n, 0);
  const [t] = await sql`select links, crew from cb.tasks where id = ${id}`;
  assert.deepEqual({ ...t.links }, { pr: 'https://x/pull/1', commit: 'abc1234' });
  assert.deepEqual(t.crew, { design: 'O1@mac', build: 'B1@mac', review: 'R1@mac' });
  // a squad with one repo: a builder of that repo takes tagged ({api}) and untagged (null) cards alike
  await sql`select cb.ensure_project('solo'), cb.project_pipeline('solo', true, 'ahmed')`;
  await sql`select cb.squad_set('solo', ${sql.json({ machines: QHS.machines, repos: { api: { paths: QHS.repos.api.paths } },
    areas: [{ name: 'api', repo: 'api' }], roles: { lead: QHS.roles.lead, owner: QHS.roles.owner } })}, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area, repo) values ('mac','p6','solo-B1@mac','solo','builder',null,'api')`;
  const tagged = Number((await sql`select cb.task_add(project => 'solo', title => 't', type => 'bug', repos => '["api"]', stage => 'build', why => 'small', actor => 'orch@pc') as id`)[0].id);
  const plain = Number((await sql`select cb.task_add(project => 'solo', title => 'p', type => 'bug', stage => 'build', why => 'small', actor => 'orch@pc') as id`)[0].id);
  assert.deepEqual((await claim(sql, 'solo-B1@mac', 'solo')).concat(await claim(sql, 'solo-B1@mac', 'solo')).sort(), [tagged, plain].sort());
});
