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

const ZED: any = {
  machines: { shaltoot: { herdr: null, board: 'C:/work/claude-board' }, macbook: { herdr: 'macbook', board: '/Users/me/Work/claude-board' } },
  repos: {
    api: { home: true, paths: { shaltoot: 'C:/work/ZED/api', macbook: '/Users/me/Work/ZED/api' } },
    dashboard: { paths: { shaltoot: 'C:/work/ZED/dashboard', macbook: '/Users/me/Work/ZED/dashboard' } },
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
const D = 'zed-dashboard-B1@mac';

// as test/repos-parts.test.ts: zed, pipeline on, the ZED squad and its sessions
async function setup() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('zed'), cb.project_pipeline('zed', true, 'ahmed')`;
  await sql`select cb.squad_set('zed', ${sql.json(ZED)}, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area, repo) values
    ('pc','p1','orch@pc','zed',null,null,null), ('pc','p2','zed-O1@pc','zed','owner','api',null),
    ('mac','p3','zed-B1@mac','zed','builder',null,'api'), ('mac','p4','zed-dashboard-B1@mac','zed','builder',null,'dashboard'),
    ('mac','p5','zed-B2@mac','zed','builder',null,null),
    ('mac','p6','zed-R1@mac','zed','reviewer',null,'api'), ('mac','p7','zed-dashboard-R1@mac','zed','reviewer',null,'dashboard'),
    ('mac','p8','zed-Q1@mac','zed','qa',null,null)`;
  return sql;
}
const claim = async (sql: any, actor: string, project = 'zed') =>
  (await sql`select * from cb.task_claim(${project}, ${actor})`).map((r: any) => Number(r.id));
const pass = (sql: any, id: number, actor: string, summary = 'ok', links: any = {}, repo?: string) => repo === undefined
  ? sql`select cb.stage_pass(${id}::text, ${summary}, ${sql.json(links)}, ${actor}) as r`
  : sql`select cb.stage_pass(${id}::text, ${summary}, ${sql.json(links)}, ${actor}, ${repo}) as r`;
const approve = async (sql: any, id: number) => {
  const [q] = await sql`select id from cb.questions where approval_for = ${id} order by id desc limit 1`;
  await sql`select cb.answer(${q.id}::text, 'Approve', 'ahmed')`;
};
async function approved(sql: any, repos = ['api', 'dashboard']) {
  const id = Number((await sql`select cb.task_add(project => 'zed', title => 'c', type => 'feature', repos => ${sql.json(repos)}, actor => 'orch@pc') as id`)[0].id);
  await sql`update cb.tasks set assignee = 'zed-O1@pc', status = 'in_progress' where id = ${id}`;
  await sql`select cb.page_set('the design', task => ${String(id)}, actor => 'zed-O1@pc')`;
  await pass(sql, id, 'zed-O1@pc', 'designed');
  await approve(sql, id);
  return id;
}
async function atMerge(sql: any) {
  const id = await approved(sql);
  await claim(sql, 'zed-B1@mac'); await claim(sql, D);
  await pass(sql, id, 'zed-B1@mac', 'built', { pr: API }); await pass(sql, id, D, 'built', { pr: DASH });
  await claim(sql, 'zed-R1@mac'); await claim(sql, 'zed-dashboard-R1@mac');
  await pass(sql, id, 'zed-R1@mac', 'GO'); await pass(sql, id, 'zed-dashboard-R1@mac', 'GO');
  return id;
}
const resume = async (sql: any, actor: string) => (await sql`select cb.resume(${actor}) as r`)[0].r;
const words = async (sql: any, id: number) => (await sql`select cb._parts_words(${id}) as w`)[0].w;
const digest = async (sql: any) => (await sql`select cb.digest('zed') as d`)[0].d as string[];
const sessionOf = async (sup: any, actor: string) => ((await sup`select cb.supervise_state('zed') as r`)[0].r.sessions as any[]).find((s) => s.actor === actor);

test('resume lists a card by its part', async () => {
  const sql = await setup();
  const id = await approved(sql);
  assert.deepEqual(await claim(sql, D), [id]);
  const line = 'build: api waits for a builder, dashboard building (zed-dashboard-B1@mac)';
  const r = await resume(sql, D);
  assert.deepEqual(r.cards.map((c: any) => c.id), [id]);
  assert.deepEqual(r.cards[0].part, { repo: 'dashboard', stage: 'build', pr: null });
  assert.equal(r.cards[0].parts, line);
  assert.equal(r.cards[0].status, 'in_progress', 'the part status, not the card status (Next)');
  assert.equal((await sql`select cb.next_step(${String(id)}) as s`)[0].s.takes_it, line);
  assert.deepEqual((await resume(sql, 'zed-B1@mac')).cards, []);
  const out = cb(['resume'], D);
  assert.equal(out.code, 0, out.err);
  assert.ok(out.out.includes(`#${id} [in_progress] c`) && out.out.includes('  your part: dashboard') && out.out.includes(`  parts: ${line}`), out.out);
  // a part ahead of the card is done, with its PR
  await claim(sql, 'zed-B1@mac');
  const p = cb(['pass', String(id), 'built', '--pr', API], 'zed-B1@mac');
  assert.equal(p.code, 0, p.err);
  assert.equal(p.out, `#${id} → Building; build: api done (PR #12), dashboard building (zed-dashboard-B1@mac). You: cb next`);
  assert.equal(await words(sql, id), 'build: api done (PR #12), dashboard building (zed-dashboard-B1@mac)');
  await pass(sql, id, D, 'built', { pr: DASH });
  assert.equal(await words(sql, id), 'review: api waits for a reviewer, dashboard waits for a reviewer');
  await claim(sql, 'zed-R1@mac'); await claim(sql, 'zed-dashboard-R1@mac');
  await pass(sql, id, 'zed-R1@mac', 'GO'); await pass(sql, id, 'zed-dashboard-R1@mac', 'GO');
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

test('cb next after a part claim prints the part, not the card\'s Next', async () => {
  const sql = await setup();
  const id = await approved(sql);
  const n = cb(['next', 'zed'], D);
  assert.equal(n.code, 0, n.err);
  assert.equal(n.out.split('\n')[0], `#${id} [part dashboard: in_progress] P2 feature: c · zed`);
  assert.ok(n.out.includes('  your part: dashboard'), n.out);
  // a card without parts: its own status, as before
  const one = await approved(sql, ['dashboard']);
  assert.equal(cb(['next', 'zed'], D).out.split('\n')[0], `#${one} [in_progress] P2 feature: c (${D}) · zed`);
});

test('a reviewer whose part is ahead of the card resumes at its part\'s stage', async () => {
  const sql = await setup();
  const id = await approved(sql);
  await claim(sql, 'zed-B1@mac'); await claim(sql, D);
  await pass(sql, id, 'zed-B1@mac', 'built', { pr: API }); await pass(sql, id, D, 'built', { pr: DASH });
  await claim(sql, 'zed-R1@mac'); await claim(sql, 'zed-dashboard-R1@mac');
  await sql`select cb.stage_fail(${id}::text, 'wrong', null, 'zed-dashboard-R1@mac')`;
  const [c] = (await resume(sql, 'zed-R1@mac')).cards;
  assert.deepEqual([c.id, c.stage, c.stage_words, c.finish],
    [id, 'review', 'In review', `cb pass ${id} "<verdict>" --repo api or cb fail ${id} "<what is wrong>" --repo api`]);
  assert.deepEqual(c.part, { repo: 'api', stage: 'review', pr: API });
  assert.equal(c.parts, 'build: api done (PR #12), dashboard building (zed-dashboard-B1@mac)');
  // the builder the NO-GO gave its part back to: its build line, with its repo
  assert.equal((await resume(sql, D)).cards[0].finish, `cb pass ${id} "<summary>" --pr <url> --repo dashboard`);
  // closing the card by hand is refused with the holder's own part line, not the card's (build)
  const done = cb(['done', String(id), 'looks fine'], 'zed-R1@mac');
  assert.notEqual(done.code, 0);
  assert.ok(done.err.includes(`finish it with cb pass ${id} "<verdict>" --repo api or cb fail ${id} "<what is wrong>" --repo api (`), done.err);
  // a session holding no part: the card's line, as before
  const q = cb(['done', String(id), 'looks fine'], 'zed-Q1@mac');
  assert.ok(q.err.includes(`finish it with cb pass ${id} "<summary>" --pr <url> (only Ahmed`), q.err);
});

test('part holders count as holding', async () => {
  const sql = await setup();
  const sup = conn('cb-supervisor/test');
  const id = await approved(sql);
  await claim(sql, D);
  assert.equal((await sessionOf(sup, D)).holds, 1);
  assert.equal((await sessionOf(sup, 'zed-B1@mac')).holds, 0);
  assert.equal((await sup`select cb.supervise_mark(${D}, true) as r`)[0].r, false);
  assert.equal((await sql`select closing_at from cb.sessions where actor = ${D}`)[0].closing_at, null);
  // a part holder with no session row is listed, as a card holder is
  await sql`update cb.task_parts set assignee = 'zed-dashboard-B9@mac' where task_id = ${id} and repo = 'dashboard'`;
  assert.equal((await sessionOf(sup, 'zed-dashboard-B9@mac')).holds, 1);
});

test('a part holder in work is not idle and is pushed no new work', async () => {
  const sql = await setup();
  await approved(sql);
  await claim(sql, D);
  // new one-repo dashboard work arrives in Next
  await sql`select cb.task_add(project => 'zed', title => 'd', type => 'bug', repos => '["dashboard"]', stage => 'build', why => 'small', actor => 'orch@pc')`;
  const t = (await sql`select cb.tick('zed', 'orch@pc') as r`)[0].r;
  assert.ok(!t.idle.some((s: any) => s.actor === D), JSON.stringify(t.idle));
  assert.ok(t.idle.some((s: any) => s.actor === 'zed-B1@mac'));
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
  const bare = Number((await sql`select cb.task_add(project => 'zed', title => 'u', type => 'bug', actor => 'orch@pc') as id`)[0].id);
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
  await sql`update cb.tasks set status = 'blocked' where id = ${id}`;
  await age(31);
  assert.equal(await due(), 0, 'a blocked card is not chased');
  await sql`update cb.tasks set status = 'next' where id = ${id}`;
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
  // an idle dashboard builder is pushed the freed part (the card itself never moves)
  await sql`insert into cb.sessions (machine, pane, actor, project, role, repo) values ('mac','p9','zed-dashboard-B2@mac','zed','builder','dashboard')`;
  const e0 = Number((await sql`select max(id) as m from cb.events`)[0].m);
  assert.equal(await due(), 2, 'a note to the holder and the release');
  assert.deepEqual((await sql`select cb.inbox('mac', 'p9', ${e0}) as i`)[0].i.next_work.map((w: any) => Number(w.id)), [id]);
  assert.deepEqual((await sql`select cb.inbox('mac', 'p3', ${e0}) as i`)[0].i.next_work, [], 'an api builder is not');
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
  const bare = Number((await sql`select cb.task_add(project => 'zed', title => 'b', type => 'bug', actor => 'orch@pc') as id`)[0].id);
  await sql`select cb._stage_move(${bare}, 'build', null, 'x')`;
  // a down session holding a part
  const held = await approved(sql);
  assert.deepEqual(await claim(sql, D), [held]);
  await sql`update cb.sessions set last_seen = now() - interval '11 minutes' where actor = ${D}`;
  await sql`update cb.events set at = now() - interval '31 minutes' where actor = ${D}`; // and quiet on the board: down (#4341)
  d = await digest(sql);
  assert.ok(d.includes(`#${bare} has no repo: cb edit ${bare} --repo <repo,repo>`), d.join('\n'));
  assert.ok(d.includes(`${D} is down and holds #${held} (part dashboard): restore it`), d.join('\n'));
});

test('freeing one part leaves its sibling on its own clock', async () => {
  const sql = await setup();
  const id = await approved(sql);
  await claim(sql, 'zed-B1@mac'); await claim(sql, D);
  const age = async (mins: number) => {
    const i = `${mins} minutes`;
    await sql`update cb.task_parts set since = now() - ${i}::interval where task_id = ${id}`;
    await sql`update cb.sessions set started_at = now() - ${i}::interval`;
    await sql`update cb.events set at = now() - ${i}::interval where (task_id = ${id} or actor in ('zed-B1@mac', ${D})) and not (data ? 'nudge')`;
  };
  const due = async () => (await sql`select cb.stage_stalls_due() as n`)[0].n;
  const holders = async () => (await sql`select assignee from cb.task_parts where task_id = ${id} order by repo`).map((r: any) => r.assignee);
  await age(31);
  assert.equal(await due(), 2, 'both holders nudged');
  await age(91);
  await sql`update cb.task_parts set nudged_at = now() - case repo when 'dashboard' then interval '61 minutes' else interval '10 minutes' end where task_id = ${id}`;
  assert.equal(await due(), 2, 'dashboard freed: a note and a message');
  assert.deepEqual(await holders(), ['zed-B1@mac', null]);
  // #3221 review M2: a part taken off a seat is never held by its relay (urgent), and stays a nudge (no card activity)
  assert.deepEqual((await sql`select data ->> 'urgent' as u, data ? 'nudge' as n from cb.events where kind = 'message' and summary like ${`#${id} part dashboard went back to the queue: %`}`)
    .map((r: any) => [r.u, r.n]), [['true', true]]);
  // the free note on the card is not activity for the api part: its own nudge hour runs out and it is freed too
  await sql`update cb.task_parts set nudged_at = now() - interval '61 minutes' where task_id = ${id} and repo = 'api'`;
  assert.equal(await due(), 2);
  assert.deepEqual(await holders(), [null, null]);
});

test('a staged card with no repo takes its repos once (digest group 13)', async () => {
  const sql = await setup();
  const add = async (stage = 'build') => {
    const id = Number((await sql`select cb.task_add(project => 'zed', title => 'b', type => 'bug', actor => 'orch@pc') as id`)[0].id);
    await sql`select cb._stage_move(${id}, ${stage}, null, 'x')`;
    return id;
  };
  const edit = (id: number, repos: string[]) => sql`select cb.task_update(${id}::text, ${sql.json({ repos })}, 'orch@pc')`;
  const bare = await add();
  assert.ok((await digest(sql)).includes(`#${bare} has no repo: cb edit ${bare} --repo <repo,repo>`));
  const e = cb(['edit', String(bare), '--repo', 'api,dashboard'], 'orch@pc');
  assert.equal(e.code, 0, e.err);
  assert.deepEqual((await sql`select repo, stage, status, assignee from cb.task_parts where task_id = ${bare} order by repo`)
    .map((r: any) => [r.repo, r.stage, r.status, r.assignee]), [['api', 'build', 'next', null], ['dashboard', 'build', 'next', null]]);
  assert.ok(!(await digest(sql)).some((l) => l.startsWith(`#${bare} has no repo`)));
  assert.deepEqual(await claim(sql, 'zed-B1@mac'), [bare]);
  assert.deepEqual(await claim(sql, D), [bare]);
  // once: named, the repos lock as any card's do
  await assert.rejects(() => edit(bare, ['api']), /repos lock once the design is passed/);
  // one repo at review: no parts, the repo's reviewer takes it
  const rev = await add('review');
  await edit(rev, ['dashboard']);
  assert.equal((await sql`select count(*)::int n from cb.task_parts where task_id = ${rev}`)[0].n, 0);
  assert.deepEqual(await claim(sql, 'zed-dashboard-R1@mac'), [rev]);
  // several at review, or on a held card: refused
  const rev2 = await add('review');
  // at review the lead names one repo
  assert.ok((await digest(sql)).includes(`#${rev2} has no repo: cb edit ${rev2} --repo <repo>`));
  await assert.rejects(() => edit(rev2, ['api', 'dashboard']), new RegExp(`#${rev2} is in review: give one repo, or send it back with cb fail ${rev2} --to design`));
  // several repos and a holder in the same edit: refused, as on a held card
  const both = await add();
  await assert.rejects(() => sql`select cb.task_update(${both}::text, ${sql.json({ repos: ['api', 'dashboard'], assignee: 'zed-B2@mac' })}, 'orch@pc')`,
    new RegExp(`#${both} is held by zed-B2@mac: give one repo, or free it first`));
  // repos checked against the project the same edit moves it to
  await sql`select cb.ensure_project('demo'), cb.project_pipeline('demo', true, 'ahmed')`;
  const mv = await add();
  await sql`select cb.task_update(${mv}::text, '{"project":"demo","repos":["main"]}', 'orch@pc')`;
  assert.deepEqual({ ...(await sql`select project, repos from cb.tasks where id = ${mv}`)[0] }, { project: 'demo', repos: ['main'] });
  const held = await add();
  await sql`update cb.tasks set assignee = 'zed-B2@mac', status = 'in_progress' where id = ${held}`;
  await assert.rejects(() => edit(held, ['api', 'dashboard']), new RegExp(`#${held} is held by zed-B2@mac: give one repo, or free it first`));
  await edit(held, ['api']);
  assert.deepEqual((await sql`select repos from cb.tasks where id = ${held}`)[0].repos, ['api']);
});

test('a parts card is not handed to one session', async () => {
  const sql = await setup();
  const id = await approved(sql);
  const edit = (f: any) => sql`select cb.task_update(${id}::text, ${sql.json(f)}, 'orch@pc')`;
  await assert.rejects(() => edit({ assignee: 'zed-B1@mac' }), new RegExp(`#${id} is built one part per repo: parts are claimed by each repo's sessions`));
  await edit({ assignee: null });
  assert.equal((await sql`select assignee from cb.tasks where id = ${id}`)[0].assignee, null);
});

test('a part holder sees its part in cb start, cb mine and cb sessions', async () => {
  const sql = await setup();
  const id = await approved(sql);
  await claim(sql, D);
  assert.deepEqual((await sql`select * from cb.mine(${D})`).map((r: any) => [Number(r.id), r.status, r.stage, r.assignee]), [[id, 'in_progress', 'build', D]]);
  assert.equal(cb(['mine'], D).out, `#${id} [part dashboard: in_progress] P2 feature: c (${D}) · zed · Building`); // #4512: the part's stage in words
  const s = cb(['start'], D);
  assert.ok(s.out.includes(`  #${id} [part dashboard: in_progress] P2 feature: c (${D}) · zed · Building`), s.out);
  assert.ok(s.out.includes(`  continue #${id} c: cb log ${id} "<finding>" as you go, cb pass ${id} "<summary>" --pr <url> --repo dashboard, when finished`), s.out);
  const ss = cb(['sessions', 'zed'], 'orch@pc');
  assert.ok(ss.out.includes(`  #${id} c [part dashboard: in_progress]`), ss.out);
  const row = ((await sql`select cb.sessions_overview('zed') as r`)[0].r as any[]).find((r) => r.actor === D);
  assert.deepEqual(row.doing, [{ id, title: 'c', priority: 'P2', status: 'in_progress', part: 'dashboard' }]);
  // holding nothing: nothing, as before
  assert.equal((await sql`select count(*)::int n from cb.mine('zed-B1@mac')`)[0].n, 0);
  assert.equal(cb(['mine'], 'zed-B1@mac').out, 'no tasks assigned to zed-B1@mac');
});

test('cb show and the digest show a parts card\'s parts', async () => {
  const sql = await setup();
  const id = await approved(sql);
  await claim(sql, D);
  const line = 'build: api waits for a builder, dashboard building (zed-dashboard-B1@mac)';
  const s = cb(['show', String(id)], 'orch@pc');
  assert.equal(s.code, 0, s.err);
  assert.equal(s.out.split('\n')[1], `parts: ${line}`);
  assert.ok((await digest(sql)).includes(`#${id} ${line}`));
  // a card with no parts: as before
  const one = await approved(sql, ['dashboard']);
  assert.ok(!cb(['show', String(one)], 'orch@pc').out.includes('parts:'));
  assert.ok(!(await digest(sql)).some((l) => l.startsWith(`#${one} `)));
});

test('the design line and cb bug name the repos in a project of several', async () => {
  const sql = await setup();
  const add = async (repos: string[] | null) =>
    Number((await sql`select cb.task_add(project => 'zed', title => 'd', type => 'feature', repos => ${repos ? sql.json(repos) : null}, actor => 'orch@pc') as id`)[0].id);
  const fin = async (id: number) => (await sql`select cb._finish_line(t) as f from cb.tasks t where t.id = ${id}`)[0].f;
  const bare = await add(null);
  assert.equal(await fin(bare), `cb page set ${bare} -f page.md, cb edit ${bare} --repo <repo,repo>, then cb pass ${bare} "<summary>"`);
  const named = await add(['api']);
  assert.equal(await fin(named), `cb page set ${named} -f page.md, then cb pass ${named} "<summary>"`);
  const b = cb(['bug', 'zed', 'broken', '-b', 'it breaks'], 'orch@pc');
  assert.equal(b.code, 0, b.err);
  const n = b.out.match(/^#(\d+)/)![1];
  assert.equal(b.out, `#${n} starts at design; a small fix can skip it: the lead runs cb stage ${n} build --repo <repo,repo> --why "..."`);
  const r = cb(['bug', 'zed', 'broken', '-b', 'it breaks', '--repo', 'api'], 'orch@pc');
  const m = r.out.match(/^#(\d+)/)![1];
  assert.equal(r.out, `#${m} starts at design; a small fix can skip it: the lead runs cb stage ${m} build --why "..."`);
});
