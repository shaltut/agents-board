// Several repos inside one project (#3703, task 3): a part's holder counts as holding work everywhere a card's does
// (resume, the supervisor's holds and closing marks, stalls, the digest), and parts show in plain words.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
const conn = (name: string) => { const c = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: name } }); clients.push(c); return c; };

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
const D = 'qhs-dashboard-B1@mac';

// as test/repos-parts.test.ts: qhs, pipeline on, the QHS squad and its sessions
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
const approve = async (sql: any, id: number) => {
  const [q] = await sql`select id from cb.questions where approval_for = ${id} order by id desc limit 1`;
  await sql`select cb.answer(${q.id}::text, 'Approve', 'ahmed')`;
};
async function approved(sql: any, repos = ['api', 'dashboard']) {
  const id = Number((await sql`select cb.task_add(project => 'qhs', title => 'c', type => 'feature', repos => ${sql.json(repos)}, actor => 'orch@pc') as id`)[0].id);
  await sql`update cb.tasks set assignee = 'qhs-O1@pc', status = 'in_progress' where id = ${id}`;
  await sql`select cb.page_set('the design', task => ${String(id)}, actor => 'qhs-O1@pc')`;
  await pass(sql, id, 'qhs-O1@pc', 'designed');
  await approve(sql, id);
  return id;
}
async function atMerge(sql: any) {
  const id = await approved(sql);
  await claim(sql, 'qhs-B1@mac'); await claim(sql, D);
  await pass(sql, id, 'qhs-B1@mac', 'built', { pr: API }); await pass(sql, id, D, 'built', { pr: DASH });
  await claim(sql, 'qhs-R1@mac'); await claim(sql, 'qhs-dashboard-R1@mac');
  await pass(sql, id, 'qhs-R1@mac', 'GO'); await pass(sql, id, 'qhs-dashboard-R1@mac', 'GO');
  return id;
}
const resume = async (sql: any, actor: string) => (await sql`select cb.resume(${actor}) as r`)[0].r;
const words = async (sql: any, id: number) => (await sql`select cb._parts_words(${id}) as w`)[0].w;
const digest = async (sql: any) => (await sql`select cb.digest('qhs') as d`)[0].d as string[];
const sessionOf = async (sup: any, actor: string) => ((await sup`select cb.supervise_state('qhs') as r`)[0].r.sessions as any[]).find((s) => s.actor === actor);

test('resume lists a card by its part', async () => {
  const sql = await setup();
  const id = await approved(sql);
  assert.deepEqual(await claim(sql, D), [id]);
  const line = 'build: api waits for a builder, dashboard building (qhs-dashboard-B1@mac)';
  const r = await resume(sql, D);
  assert.deepEqual(r.cards.map((c: any) => c.id), [id]);
  assert.deepEqual(r.cards[0].part, { repo: 'dashboard', stage: 'build', pr: null });
  assert.equal(r.cards[0].parts, line);
  assert.equal((await sql`select cb.next_step(${String(id)}) as s`)[0].s.takes_it, line);
  assert.deepEqual((await resume(sql, 'qhs-B1@mac')).cards, []);
  const out = cb(['resume'], D);
  assert.equal(out.code, 0, out.err);
  assert.ok(out.out.includes('  your part: dashboard') && out.out.includes(`  parts: ${line}`), out.out);
  // a part ahead of the card is done, with its PR
  await claim(sql, 'qhs-B1@mac');
  const p = cb(['pass', String(id), 'built', '--pr', API], 'qhs-B1@mac');
  assert.equal(p.code, 0, p.err);
  assert.equal(p.out, `#${id} → Building; build: api done (PR #12), dashboard building (qhs-dashboard-B1@mac). You: cb next`);
  assert.equal(await words(sql, id), 'build: api done (PR #12), dashboard building (qhs-dashboard-B1@mac)');
  await pass(sql, id, D, 'built', { pr: DASH });
  assert.equal(await words(sql, id), 'review: api waits for a reviewer, dashboard waits for a reviewer');
  await claim(sql, 'qhs-R1@mac'); await claim(sql, 'qhs-dashboard-R1@mac');
  await pass(sql, id, 'qhs-R1@mac', 'GO'); await pass(sql, id, 'qhs-dashboard-R1@mac', 'GO');
  const [{ f }] = await sql`select cb._finish_line(t) as f from cb.tasks t where t.id = ${id}`;
  assert.equal(f, `merge each repo's PR in the design's order, then cb pass ${id} "<what merged>" --repo <repo> --commit <sha>`);
  await pass(sql, id, 'orch@pc', 'merged', { commit: 'abc1234' }, 'api');
  assert.equal(await words(sql, id), 'merge: api merged, dashboard waits for the lead to merge');
  // a card with no parts has neither
  const one = await approved(sql, ['dashboard']);
  assert.deepEqual(await claim(sql, D), [one]);
  const c = (await resume(sql, D)).cards.find((x: any) => x.id === one);
  assert.deepEqual([c.part, c.parts], [null, null]);
});

test('part holders count as holding', async () => {
  const sql = await setup();
  const sup = conn('cb-supervisor/test');
  const id = await approved(sql);
  await claim(sql, D);
  assert.equal((await sessionOf(sup, D)).holds, 1);
  assert.equal((await sessionOf(sup, 'qhs-B1@mac')).holds, 0);
  assert.equal((await sup`select cb.supervise_mark(${D}, true) as r`)[0].r, false);
  assert.equal((await sql`select closing_at from cb.sessions where actor = ${D}`)[0].closing_at, null);
  // a part holder with no session row is listed, as a card holder is
  await sql`update cb.task_parts set assignee = 'qhs-dashboard-B9@mac' where task_id = ${id} and repo = 'dashboard'`;
  assert.equal((await sessionOf(sup, 'qhs-dashboard-B9@mac')).holds, 1);
});

test('a part holder in work is not idle and is pushed no new work', async () => {
  const sql = await setup();
  await approved(sql);
  await claim(sql, D);
  // new one-repo dashboard work arrives in Next
  await sql`select cb.task_add(project => 'qhs', title => 'd', type => 'bug', repos => '["dashboard"]', stage => 'build', why => 'small', actor => 'orch@pc')`;
  const t = (await sql`select cb.tick('qhs', 'orch@pc') as r`)[0].r;
  assert.ok(!t.idle.some((s: any) => s.actor === D), JSON.stringify(t.idle));
  assert.ok(t.idle.some((s: any) => s.actor === 'qhs-B1@mac'));
  assert.deepEqual((await sql`select cb.inbox('mac', 'p4', 0) as r`)[0].r.next_work, []);
});

test('a closed card\'s parts hold nothing', async () => {
  const sql = await setup();
  const sup = conn('cb-supervisor/test');
  const id = await approved(sql);
  await claim(sql, D);
  await sql`update cb.task_parts set since = now() - interval '200 minutes' where task_id = ${id}`;
  await sql`update cb.events set at = now() - interval '200 minutes'`;
  await sql`update cb.sessions set started_at = now() - interval '200 minutes'`;
  await sql`select cb.task_move(${id}::text, 'done', 'shipped', 'ahmed')`;
  // closing drops the parts; a held part row left on a closed or an unstaged card still holds nothing
  const bare = Number((await sql`select cb.task_add(project => 'qhs', title => 'u', type => 'bug', actor => 'orch@pc') as id`)[0].id);
  await sql`select cb.stage_set(${bare}::text, 'none', 'ops only', 'orch@pc')`;
  await sql`insert into cb.task_parts (task_id, repo, stage, status, assignee, since) values
    (${id}, 'dashboard', 'build', 'in_progress', ${D}, now() - interval '200 minutes'),
    (${bare}, 'dashboard', 'build', 'in_progress', ${D}, now() - interval '200 minutes')`;
  await sql`update cb.events set at = now() - interval '200 minutes'`;
  assert.equal((await sessionOf(sup, D)).holds, 0);
  assert.deepEqual((await resume(sql, D)).cards, []);
  assert.equal((await sql`select cb.stage_stalls_due() as n`)[0].n, 0);
  assert.equal((await sql`select count(*)::int n from cb.events where kind = 'message' and data ? 'stall'`)[0].n, 0);
});

test('a quiet part holder is nudged, then freed', async () => {
  const sql = await setup();
  const id = await approved(sql);
  await claim(sql, D);
  const age = async (mins: number) => {
    const i = `${mins} minutes`;
    await sql`update cb.task_parts set since = now() - ${i}::interval where task_id = ${id}`;
    await sql`update cb.sessions set started_at = now() - ${i}::interval`;
    await sql`update cb.events set at = now() - ${i}::interval where (task_id = ${id} or actor = ${D}) and not (data ? 'nudge')`;
  };
  const due = async () => (await sql`select cb.stage_stalls_due() as n`)[0].n;
  await age(20);
  assert.equal(await due(), 0);
  await age(31);
  assert.equal(await due(), 1);
  const m = await sql`select data, summary from cb.events where kind = 'message' and data ? 'stall'`;
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].data.to, m[0].data.nudge, m[0].data.stall, m[0].data.repo], [D, true, true, 'dashboard']);
  assert.match(m[0].summary, new RegExp(`^#${id} "c" \\(part dashboard\\) has had no update for 0h 31m at Building\\.`));
  assert.notEqual((await sql`select nudged_at from cb.task_parts where task_id = ${id} and repo = 'dashboard'`)[0].nudged_at, null);
  assert.equal(await due(), 0, 'one nudge only');
  await age(91);
  await sql`update cb.task_parts set nudged_at = now() - interval '61 minutes' where task_id = ${id} and repo = 'dashboard'`;
  assert.equal(await due(), 2, 'a note to the holder and the release');
  const [p] = await sql`select status, assignee, nudged_at from cb.task_parts where task_id = ${id} and repo = 'dashboard'`;
  assert.deepEqual([p.status, p.assignee, p.nudged_at], ['next', null, null]);
  const note = `freed from ${D}: no update for 1h 31m and the nudge went unanswered (part dashboard)`;
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = ${id} and kind = 'note' and summary = ${note} and data ? 'stall'`)[0].n, 1);
  assert.ok((await digest(sql)).includes(`#${id} freed from ${D} (no update for 1h 31m and the nudge went unanswered (part dashboard)): cb session ${D}`));
  // the card stays unheld in Next; its dashboard part waits for a builder again
  const [c] = await sql`select status, assignee, stage from cb.tasks where id = ${id}`;
  assert.deepEqual([c.status, c.assignee, c.stage], ['next', null, 'build']);
  assert.deepEqual(await claim(sql, D), [id]);
});

test('the digest shows parts', async () => {
  const sql = await setup();
  const id = await atMerge(sql);
  await pass(sql, id, 'orch@pc', 'merged', { commit: 'abc1234' }, 'api');
  let d = await digest(sql);
  assert.ok(d.includes(`#${id} reviewed: merge dashboard (PR #7), then cb pass ${id} "<what merged>" --repo dashboard --commit <sha>`), d.join('\n'));
  // a staged card with no repos in a project of several
  const bare = Number((await sql`select cb.task_add(project => 'qhs', title => 'b', type => 'bug', actor => 'orch@pc') as id`)[0].id);
  await sql`select cb._stage_move(${bare}, 'build', null, 'x')`;
  // a down session holding a part
  const held = await approved(sql);
  assert.deepEqual(await claim(sql, D), [held]);
  await sql`update cb.sessions set last_seen = now() - interval '11 minutes' where actor = ${D}`;
  d = await digest(sql);
  assert.ok(d.includes(`#${bare} has no repo: cb edit ${bare} --repo <repo,repo>`), d.join('\n'));
  assert.ok(d.includes(`${D} is down and holds #${held} (part dashboard): restore it`), d.join('\n'));
});
