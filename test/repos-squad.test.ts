// Several repos inside one project (#3703, task 1): the squad lists its repos, sessions and cards name theirs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'orch@pc', HERDR_PANE_ID: '', CB_MACHINE: 'pc', CLAUDE_CODE_MESSAGING_SOCKET: '', ...env } });
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
const mod = (f: (s: any) => void) => { const s = structuredClone(QHS); f(s); return s; };

// qhs: pipeline on, the QHS squad; demo: pipeline on, no squad (one repo, main). orch@pc leads, O1 owns area api.
async function setup() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('qhs'), cb.ensure_project('demo')`;
  await sql`select cb.project_pipeline('qhs', true, 'ahmed'), cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`select cb.squad_set('qhs', ${sql.json(QHS)}, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area) values
    ('pc','p1','orch@pc','qhs',null,null), ('pc','p2','qhs-O1@pc','qhs','owner','api'), ('pc','p3','demo-O1@pc','demo','owner','claims')`;
  return sql;
}
const add = async (sql: any, project: string, o: { type?: string; labels?: string[] } = {}) =>
  Number((await sql`select cb.task_add(project => ${project}, title => 'c', type => ${o.type ?? 'feature'},
    labels => ${sql.json(o.labels ?? [])}, actor => 'orch@pc') as id`)[0].id);
const repos = async (sql: any, id: number) => (await sql`select repos from cb.tasks where id = ${id}`)[0].repos;

test('squad_set without repos returns exactly today\'s shape', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('ihop')`;
  const draft = {
    supervise: true,
    machines: { shaltoot: { herdr: null, repo: 'F:/Work/Tawuniya/iHop-Platform', board: 'F:/Work/claude-board' },
                macbook: { herdr: 'macbook', repo: '/Users/ahmedshaltoot/Work/Tachyhealth/Tawuniya/iHop-Platform', board: '/Users/ahmedshaltoot/Work/claude-board' } },
    roles: { lead: { count: 1, model: 'opus', machine: 'shaltoot' }, architect: { count: 1, model: 'opus', machine: 'shaltoot' },
             owner: { model: 'opus', machine: 'shaltoot' }, builder: { count: 3, model: 'sonnet', machine: 'macbook' },
             reviewer: { count: 2, model: 'opus', machine: 'macbook' }, qa: { count: 1, model: 'sonnet', machine: 'macbook' },
             investigator: { count: 1, model: 'opus', machine: 'macbook' } },
    areas: ['claims', 'preauth', 'fwa', 'kb', 'platform'],
  };
  // captured from squad_set on the base commit (22aef07)
  const base = {"areas":["claims","preauth","fwa","kb","platform"],"roles":{"qa":{"count":1,"model":"sonnet","machine":"macbook"},"lead":{"count":1,"model":"opus","machine":"shaltoot"},"owner":{"model":"opus","machine":"shaltoot"},"builder":{"count":3,"model":"sonnet","machine":"macbook"},"reviewer":{"count":2,"model":"opus","machine":"macbook"},"architect":{"count":1,"model":"opus","machine":"shaltoot"},"investigator":{"count":1,"model":"opus","machine":"macbook"}},"machines":{"macbook":{"repo":"/Users/ahmedshaltoot/Work/Tachyhealth/Tawuniya/iHop-Platform","board":"/Users/ahmedshaltoot/Work/claude-board","herdr":"macbook"},"shaltoot":{"repo":"F:/Work/Tawuniya/iHop-Platform","board":"F:/Work/claude-board","herdr":null}},"supervise":true};
  assert.deepEqual((await sql`select cb.squad_set('ihop', ${sql.json(draft)}, 'ahmed') as s`)[0].s, base);
  assert.deepEqual((await sql`select cb._repos_of('ihop') as r`)[0].r, ['main']);
  assert.equal((await sql`select cb._home_repo('ihop') as r`)[0].r, 'main');
  assert.equal((await sql`select cb._multi_repo('ihop') as r`)[0].r, false);
});

test('squad_set with repos', async () => {
  const sql = await setup();
  const s = (await sql`select cb.squad_get('qhs') as s`)[0].s;
  assert.equal(s.repos.api.home, true);
  assert.equal(s.repos.dashboard.home, false);
  assert.deepEqual(s.machines.macbook, { herdr: 'macbook', board: '/Users/me/Work/claude-board' });
  assert.deepEqual(s.roles.builder, { count: { api: 2, dashboard: 1 }, model: 'sonnet', machine: 'macbook' });
  assert.equal(s.roles.reviewer.model, 'opus');
  assert.deepEqual(s.areas, QHS.areas);
  assert.deepEqual((await sql`select cb._repos_of('qhs') as r`)[0].r, ['api', 'dashboard']);
  assert.equal((await sql`select cb._home_repo('qhs') as r`)[0].r, 'api');
  assert.equal((await sql`select cb._multi_repo('qhs') as r`)[0].r, true);
  // home first, then by name
  await sql`select cb.squad_set('qhs', ${sql.json(mod((x) => { delete x.repos.api.home; x.repos.dashboard.home = true; }))}, 'ahmed')`;
  assert.deepEqual((await sql`select cb._repos_of('qhs') as r`)[0].r, ['dashboard', 'api']);
  // one repo under repos is home by default
  await sql`select cb.ensure_project('one')`;
  const one = { machines: QHS.machines, repos: { api: { paths: QHS.repos.api.paths } }, roles: { lead: QHS.roles.lead } };
  assert.equal((await sql`select cb.squad_set('one', ${sql.json(one)}, 'ahmed') as s`)[0].s.repos.api.home, true);
});

test('squad_set refuses each invalid repos squad with the field named', async () => {
  const sql = await setup();
  const bad: [any, RegExp][] = [
    [mod((s) => { s.machines.shaltoot.repo = 'F:/Work/QHS/api'; }), /machine shaltoot repo: with repos, each repo lists its own paths/],
    [mod((s) => { s.repos.dashboard.home = true; }), /exactly one repo is home/],
    [mod((s) => { delete s.repos.api.home; }), /exactly one repo is home/],
    [mod((s) => { s.repos.api.paths.macbook = 'Work/QHS/api'; }), /repo api path on macbook must be an absolute path/],
    [mod((s) => { delete s.repos.dashboard.paths.macbook; }), /repo dashboard has no path on macbook/],
    [mod((s) => { s.areas[1].repo = 'web'; }), /area dashboard names repo web, which is not in repos/],
    [mod((s) => { s.areas[0] = 'api'; }), /with repos, each area is \{"name", "repo"\}/],
    [mod((s) => { s.roles.builder.count = 3; }), /builder count must be a count per repo/],
    [mod((s) => { s.repos.bot = { paths: { macbook: '/Users/me/Work/QHS/bot' } }; s.roles.builder.count.bot = 1; }), /repo bot has builders but no reviewers/],
    [mod((s) => { s.roles.builder.count.api = 5; }), /macbook would run 9 sessions; the cap is 8/],
    [mod((s) => { s.repos.Web = { paths: { macbook: '/Users/me/Work/QHS/web' } }; }), /repo Web must be a slug/],
  ];
  for (const [s, re] of bad) await assert.rejects(() => sql`select cb.squad_set('qhs', ${sql.json(s)}, 'ahmed')`, re);
});

test('iam --repo', async () => {
  const sql = await setup();
  await sql`select cb.iam('mac', 'p1', 'qhs-dashboard-B1@mac', 'qhs', role => 'builder', repo => 'dashboard')`;
  assert.equal((await sql`select repo from cb.sessions where actor = 'qhs-dashboard-B1@mac'`)[0].repo, 'dashboard');
  assert.equal((await sql`select cb._repo('qhs-dashboard-B1@mac') as r`)[0].r, 'dashboard');
  // a plain re-bind keeps it
  await sql`select cb.iam('mac', 'p1', 'qhs-dashboard-B1@mac')`;
  assert.equal((await sql`select repo from cb.sessions where actor = 'qhs-dashboard-B1@mac'`)[0].repo, 'dashboard');
  await assert.rejects(() => sql`select cb.iam('mac', 'p9', 'qhs-B9@mac', 'qhs', role => 'builder', repo => 'web')`, /repo web is not a repo of qhs: api, dashboard/);
  await sql`select cb.iam('mac', 'p8', 'demo-B1@mac', 'demo', role => 'builder', repo => 'main')`;
  assert.equal((await sql`select repo from cb.sessions where actor = 'demo-B1@mac'`)[0].repo, 'main');
  await assert.rejects(() => sql`select cb.iam('mac', 'p7', 'demo-B2@mac', 'demo', role => 'builder', repo => 'api')`, /repo api is not a repo of demo: main/);
});

test('_repo defaults to the home repo', async () => {
  const sql = await setup();
  assert.equal((await sql`select cb._repo('qhs-O1@pc') as r`)[0].r, 'api');
  assert.equal((await sql`select cb._repo('demo-O1@pc') as r`)[0].r, 'main');
  assert.equal((await sql`select cb._repo('nobody@nowhere') as r`)[0].r, 'main');
});

test('card repos', async () => {
  const sql = await setup();
  const [{ id }] = await sql`select cb.task_add(project => 'qhs', title => 'x', repos => '["dashboard","api"]', actor => 'orch@pc') as id`;
  assert.deepEqual(await repos(sql, id), ['dashboard', 'api']);
  await assert.rejects(() => sql`select cb.task_add(project => 'qhs', title => 'x', repos => '["web"]', actor => 'orch@pc')`, /repo web is not a repo of qhs/);
  await sql`select cb.task_update(${id}, '{"repos":["api"]}', 'orch@pc')`;
  assert.deepEqual(await repos(sql, id), ['api']);
  await assert.rejects(() => sql`select cb.task_update(${id}, '{"repos":["web"]}', 'orch@pc')`, /repo web is not a repo of qhs/);
  for (const st of ['approval', 'build', 'review', 'merge', 'qa']) {
    await sql`update cb.tasks set stage = ${st} where id = ${id}`;
    await assert.rejects(() => sql`select cb.task_update(${id}, '{"repos":["dashboard"]}', 'orch@pc')`,
      /#\d+ is at .*: repos lock at build; send it back with cb fail \d+ --to design/);
  }
  assert.deepEqual(await repos(sql, id), ['api']);
});

test('design pass needs repos in a multi-repo project', async () => {
  const sql = await setup();
  const pass = async (id: number, owner: string) => {
    await sql`update cb.tasks set assignee = ${owner}, status = 'in_progress' where id = ${id}`;
    await sql`select cb.page_set('the design', task => ${String(id)}, actor => ${owner})`;
    return sql`select cb.stage_pass(${id}, 'designed', '{}', ${owner}) as r`;
  };
  const ui = await add(sql, 'qhs', { labels: ['ui'] });
  await assert.rejects(() => pass(ui, 'qhs-O1@pc'), /name the repos first: cb edit \d+ --repo <repo,repo>/);
  const both = await add(sql, 'qhs', { labels: ['dashboard', 'api'] });
  assert.equal((await pass(both, 'qhs-O1@pc'))[0].r, 'approval');
  assert.deepEqual(await repos(sql, both), ['api', 'dashboard']);
  const one = await add(sql, 'demo', { labels: ['claims'] });
  assert.equal((await pass(one, 'demo-O1@pc'))[0].r, 'approval');
  assert.equal(await repos(sql, one), null);
});

test('stage build needs a repo in a multi-repo project', async () => {
  const sql = await setup();
  const bug = await add(sql, 'qhs', { type: 'bug' });
  await assert.rejects(() => sql`select cb.stage_set(${bug}, 'build', 'small', 'orch@pc')`, /give the repos: cb stage \d+ build --repo <repo> --why/);
  await assert.rejects(() => sql`select cb.stage_set(${bug}, 'build', 'small', 'orch@pc', repos => '{web}')`, /repo web is not a repo of qhs/);
  assert.equal((await sql`select cb.stage_set(${bug}, 'build', 'small', 'orch@pc', repos => '{dashboard}') as r`)[0].r, 'build');
  assert.deepEqual(await repos(sql, bug), ['dashboard']);
  // one repo: no repo needed
  const demo = await add(sql, 'demo', { type: 'bug' });
  assert.equal((await sql`select cb.stage_set(${demo}, 'build', 'small', 'orch@pc') as r`)[0].r, 'build');
  assert.equal(await repos(sql, demo), null);
});

test('CLI: squad show, edit --repo, add --repo, stage --repo', async () => {
  const sql = await setup();
  const show = cb(['squad', 'show', 'qhs']);
  assert.equal(show.code, 0, show.err);
  assert.ok(show.out.includes('builder  api 2, dashboard 1 × sonnet on macbook'), show.out);
  assert.ok(show.out.includes('repos: api (home), dashboard'), show.out);
  assert.ok(show.out.includes('areas: api, dashboard'), show.out);
  const id = await add(sql, 'qhs');
  const e = cb(['edit', String(id), '--repo', 'api,dashboard']);
  assert.equal(e.code, 0, e.err);
  assert.deepEqual(await repos(sql, id), ['api', 'dashboard']);
  const a = cb(['add', 'qhs', 'x', '--repo', 'api']);
  assert.equal(a.code, 0, a.err);
  assert.deepEqual(await repos(sql, Number(a.out.replace('#', ''))), ['api']);
  const bug = await add(sql, 'qhs', { type: 'bug' });
  const s = cb(['stage', String(bug), 'build', '--repo', 'dashboard', '--why', 'small']);
  assert.equal(s.code, 0, s.err);
  assert.deepEqual(await repos(sql, bug), ['dashboard']);
  const b = cb(['bug', 'qhs', 'y', '-b', 'broke', '--stage', 'build', '--why', 'small', '--repo', 'api']);
  assert.equal(b.code, 0, b.err);
  const [{ id: bid }] = await sql`select max(id)::int as id from cb.tasks`;
  assert.deepEqual(await repos(sql, bid), ['api']);
  assert.equal((await sql`select stage from cb.tasks where id = ${bid}`)[0].stage, 'build');
});
