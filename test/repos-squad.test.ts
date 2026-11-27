// Several repos inside one project (#3703, task 1): the squad lists its repos, sessions and cards name theirs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';
import { callFn } from '../server/rpc.ts';
import { squadUp } from '../cli/squad-up.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'orch@pc', HERDR_PANE_ID: '', CB_MACHINE: 'pc', CLAUDE_CODE_MESSAGING_SOCKET: '', ...env } });
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
const mod = (f: (s: any) => void) => { const s = structuredClone(ZED); f(s); return s; };

// zed: pipeline on, the ZED squad; demo: pipeline on, no squad (one repo, main). orch@pc leads, O1 owns area api.
async function setup() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('zed'), cb.ensure_project('demo')`;
  await sql`select cb.project_pipeline('zed', true, 'ahmed'), cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`select cb.squad_set('zed', ${sql.json(ZED)}, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area) values
    ('pc','p1','orch@pc','zed',null,null), ('pc','p2','zed-O1@pc','zed','owner','api'), ('pc','p3','demo-O1@pc','demo','owner','claims')`;
  return sql;
}
const add = async (sql: any, project: string, o: { type?: string; labels?: string[] } = {}) =>
  Number((await sql`select cb.task_add(project => ${project}, title => 'c', type => ${o.type ?? 'feature'},
    labels => ${sql.json(o.labels ?? [])}, actor => 'orch@pc') as id`)[0].id);
const repos = async (sql: any, id: number) => (await sql`select repos from cb.tasks where id = ${id}`)[0].repos;

test('squad_set without repos returns exactly today\'s shape', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('iris')`;
  const draft = {
    supervise: true,
    machines: { shaltoot: { herdr: null, repo: 'C:/work/acme/widgets', board: 'C:/work/claude-board' },
                macbook: { herdr: 'macbook', repo: '/Users/me/work/acme/widgets', board: '/Users/me/work/claude-board' } },
    roles: { lead: { count: 1, model: 'opus', machine: 'shaltoot' }, architect: { count: 1, model: 'opus', machine: 'shaltoot' },
             owner: { model: 'opus', machine: 'shaltoot' }, builder: { count: 3, model: 'sonnet', machine: 'macbook' },
             reviewer: { count: 2, model: 'opus', machine: 'macbook' }, qa: { count: 1, model: 'sonnet', machine: 'macbook' },
             investigator: { count: 1, model: 'opus', machine: 'macbook' } },
    areas: ['claims', 'preauth', 'fwa', 'kb', 'platform'],
  };
  // captured from squad_set on the base commit (22aef07)
  const base = {"areas":["claims","preauth","fwa","kb","platform"],"roles":{"qa":{"count":1,"model":"sonnet","machine":"macbook"},"lead":{"count":1,"model":"opus","machine":"shaltoot"},"owner":{"model":"opus","machine":"shaltoot"},"builder":{"count":3,"model":"sonnet","machine":"macbook"},"reviewer":{"count":2,"model":"opus","machine":"macbook"},"architect":{"count":1,"model":"opus","machine":"shaltoot"},"investigator":{"count":1,"model":"opus","machine":"macbook"}},"machines":{"macbook":{"repo":"/Users/me/work/acme/widgets","board":"/Users/me/work/claude-board","herdr":"macbook"},"shaltoot":{"repo":"C:/work/acme/widgets","board":"C:/work/claude-board","herdr":null}},"supervise":true};
  assert.deepEqual((await sql`select cb.squad_set('iris', ${sql.json(draft)}, 'ahmed') as s`)[0].s, base);
  assert.deepEqual((await sql`select cb._repos_of('iris') as r`)[0].r, ['main']);
  assert.equal((await sql`select cb._home_repo('iris') as r`)[0].r, 'main');
  assert.equal((await sql`select cb._multi_repo('iris') as r`)[0].r, false);
});

test('squad_set with repos', async () => {
  const sql = await setup();
  const s = (await sql`select cb.squad_get('zed') as s`)[0].s;
  assert.equal(s.repos.api.home, true);
  assert.equal(s.repos.dashboard.home, false);
  assert.deepEqual(s.machines.macbook, { herdr: 'macbook', board: '/Users/me/Work/claude-board' });
  assert.deepEqual(s.roles.builder, { count: { api: 2, dashboard: 1 }, model: 'sonnet', machine: 'macbook' });
  assert.equal(s.roles.reviewer.model, 'opus');
  assert.deepEqual(s.areas, ZED.areas);
  assert.deepEqual((await sql`select cb._repos_of('zed') as r`)[0].r, ['api', 'dashboard']);
  assert.equal((await sql`select cb._home_repo('zed') as r`)[0].r, 'api');
  assert.equal((await sql`select cb._multi_repo('zed') as r`)[0].r, true);
  // home first, then by name
  await sql`select cb.squad_set('zed', ${sql.json(mod((x) => { delete x.repos.api.home; x.repos.dashboard.home = true; }))}, 'ahmed')`;
  assert.deepEqual((await sql`select cb._repos_of('zed') as r`)[0].r, ['dashboard', 'api']);
  // one repo under repos is home by default
  await sql`select cb.ensure_project('one')`;
  const one = { machines: ZED.machines, repos: { api: { paths: ZED.repos.api.paths } }, roles: { lead: ZED.roles.lead } };
  assert.equal((await sql`select cb.squad_set('one', ${sql.json(one)}, 'ahmed') as s`)[0].s.repos.api.home, true);
});

test('squad_set refuses each invalid repos squad with the field named', async () => {
  const sql = await setup();
  const bad: [any, RegExp][] = [
    [mod((s) => { s.machines.shaltoot.repo = 'C:/work/ZED/api'; }), /machine shaltoot repo: with repos, each repo lists its own paths/],
    [mod((s) => { s.repos.dashboard.home = true; }), /exactly one repo is home/],
    [mod((s) => { delete s.repos.api.home; }), /exactly one repo is home/],
    [mod((s) => { s.repos.api.paths.macbook = 'Work/ZED/api'; }), /repo api path on macbook must be an absolute path/],
    [mod((s) => { delete s.repos.dashboard.paths.macbook; }), /repo dashboard has no path on macbook/],
    [mod((s) => { s.areas[1].repo = 'web'; }), /area dashboard names repo web, which is not in repos/],
    [mod((s) => { s.areas[0] = 'api'; }), /with repos, each area is \{"name", "repo"\}/],
    [mod((s) => { s.roles.builder.count = 3; }), /builder count must be a count per repo/],
    [mod((s) => { s.repos.bot = { paths: { macbook: '/Users/me/Work/ZED/bot' } }; s.roles.builder.count.bot = 1; }), /repo bot has builders but no reviewers/],
    [mod((s) => { s.roles.builder.count.api = 5; }), /macbook would run 9 sessions; the cap is 8/],
    [mod((s) => { s.repos.Web = { paths: { macbook: '/Users/me/Work/ZED/web' } }; }), /repo Web must be a slug/],
    [mod((s) => { s.repos = null; s.machines.macbook.repo = '/Users/me/Work/ZED/api'; }), /repos must be an object/],
    [mod((s) => { s.repos.api.paths.nowhere = '/x'; }), /repo api path on nowhere: nowhere is not in machines/],
    // vps runs one role only, so the refusal is that role's: an owner needs its areas' repos, a project-wide role the home repo
    [mod((s) => { s.machines.vps = { herdr: 'vps2', board: '/b' }; s.repos.api.paths.vps = '/w/api'; s.roles.owner.machine = 'vps'; }), /repo dashboard has no path on vps/],
    [mod((s) => { s.machines.vps = { herdr: 'vps2', board: '/b' }; s.repos.dashboard.paths.vps = '/w/dashboard'; s.roles.investigator = { count: 1, machine: 'vps' }; }), /repo api has no path on vps/],
  ];
  for (const [s, re] of bad) await assert.rejects(() => sql`select cb.squad_set('zed', ${sql.json(s)}, 'ahmed')`, re);
});

// #4002: a repo-bound role's seats are "<repo>:<n>" (the home repo's too), as wantList counts them; project-wide roles
// keep "1".."count", owners their area
test('squad_set validates multi-repo seat keys (#4002)', async () => {
  const sql = await setup();
  const seats = { 'api:2': { model: 'opus', fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }] } };
  const saved = (await sql`select cb.squad_set('zed', ${sql.json(mod((x) => { x.roles.builder.seats = seats; }))}, 'ahmed') as s`)[0].s;
  assert.deepEqual(saved.roles.builder, { count: { api: 2, dashboard: 1 }, model: 'sonnet', machine: 'macbook', seats });
  for (const k of ['api:3', 'web:1', '1', 'api'])
    await assert.rejects(() => sql`select cb.squad_set('zed', ${sql.json(mod((x) => { x.roles.builder.seats = { [k]: { model: 'opus' } }; }))}, 'ahmed')`,
      new RegExp(`: builder seat ${k} is not one of its seats: api:1, api:2, dashboard:1$`), k);
  await assert.rejects(() => sql`select cb.squad_set('zed', ${sql.json(mod((x) => { x.roles.reviewer.seats = { 'dashboard:2': { model: 'sonnet' } }; }))}, 'ahmed')`,
    /: reviewer seat dashboard:2 is not one of its seats: api:1, dashboard:1$/);
  const wide = (await sql`select cb.squad_set('zed', ${sql.json(mod((x) => { x.roles.qa.seats = { '1': { model: 'opus' } }; x.roles.owner.seats = { dashboard: { model: 'sonnet' } }; }))}, 'ahmed') as s`)[0].s;
  assert.deepEqual([wide.roles.qa.seats, wide.roles.owner.seats], [{ '1': { model: 'opus' } }, { dashboard: { model: 'sonnet' } }]);
  await assert.rejects(() => sql`select cb.squad_set('zed', ${sql.json(mod((x) => { x.roles.qa.seats = { 'api:1': { model: 'opus' } }; }))}, 'ahmed')`,
    /: qa seat api:1 is not one of its seats: 1$/);
  // the ZED squad without seats still saves as before
  const plain = (await sql`select cb.squad_set('zed', ${sql.json(ZED)}, 'ahmed') as s`)[0].s;
  assert.deepEqual(plain.roles, { ...ZED.roles, lead: { ...ZED.roles.lead, model: 'opus' }, owner: { ...ZED.roles.owner, model: 'opus' },
                                  reviewer: { ...ZED.roles.reviewer, model: 'opus' }, qa: { ...ZED.roles.qa, model: 'sonnet' } });
});

test('iam --repo', async () => {
  const sql = await setup();
  await sql`select cb.iam('mac', 'p1', 'zed-dashboard-B1@mac', 'zed', role => 'builder', repo => 'dashboard')`;
  assert.equal((await sql`select repo from cb.sessions where actor = 'zed-dashboard-B1@mac'`)[0].repo, 'dashboard');
  assert.equal((await sql`select cb._repo('zed-dashboard-B1@mac') as r`)[0].r, 'dashboard');
  // a plain re-bind keeps it
  await sql`select cb.iam('mac', 'p1', 'zed-dashboard-B1@mac')`;
  assert.equal((await sql`select repo from cb.sessions where actor = 'zed-dashboard-B1@mac'`)[0].repo, 'dashboard');
  await assert.rejects(() => sql`select cb.iam('mac', 'p9', 'zed-B9@mac', 'zed', role => 'builder', repo => 'web')`, /repo web is not a repo of zed: api, dashboard/);
  await sql`select cb.iam('mac', 'p8', 'demo-B1@mac', 'demo', role => 'builder', repo => 'main')`;
  assert.equal((await sql`select repo from cb.sessions where actor = 'demo-B1@mac'`)[0].repo, 'main');
  await assert.rejects(() => sql`select cb.iam('mac', 'p7', 'demo-B2@mac', 'demo', role => 'builder', repo => 'api')`, /repo api is not a repo of demo: main/);
  // a repo belongs to its project: moving the session to another project drops it, a takeover starts clean
  await sql`select cb.iam('mac', 'p1', 'zed-dashboard-B1@mac', 'demo')`;
  assert.equal((await sql`select repo from cb.sessions where pane = 'p1'`)[0].repo, null);
  await sql`select cb.iam('mac', 'p1', 'zed-dashboard-B1@mac', 'zed', repo => 'dashboard')`;
  await sql`select cb.iam('mac', 'p1', 'other@mac')`;
  assert.equal((await sql`select repo from cb.sessions where pane = 'p1'`)[0].repo, null);
});

test('_repo defaults to the home repo', async () => {
  const sql = await setup();
  assert.equal((await sql`select cb._repo('zed-O1@pc') as r`)[0].r, 'api');
  assert.equal((await sql`select cb._repo('demo-O1@pc') as r`)[0].r, 'main');
  assert.equal((await sql`select cb._repo('nobody@nowhere') as r`)[0].r, 'main');
});

test('_repo: a stored repo the project no longer has counts as the home repo', async () => {
  const sql = await setup();
  // bound with --repo main while demo was one repo; demo then gains repos
  await sql`select cb.iam('mac', 'p8', 'demo-B1@mac', 'demo', role => 'builder', repo => 'main')`;
  await sql`select cb.squad_set('demo', ${sql.json(ZED)}, 'ahmed')`;
  assert.equal((await sql`select cb._repo('demo-B1@mac') as r`)[0].r, 'api');
  const s = (await sql`select cb.supervise_state('demo') as r`)[0].r.sessions.find((x: any) => x.actor === 'demo-B1@mac');
  assert.equal(s.repo, 'api');
});

test('_repo: a stale repo other than main stays as it is and claims nothing', async () => {
  const sql = await setup();
  await sql`insert into cb.sessions (machine, pane, actor, project, role, repo) values ('mac','p9','zed-dashboard-B1@mac','zed','builder','dashboard')`;
  // dashboard is renamed web (no open work names it)
  await sql`select cb.squad_set('zed', ${sql.json(mod((s) => {
    s.repos.web = s.repos.dashboard; delete s.repos.dashboard;
    s.areas = [{ name: 'api', repo: 'api' }, { name: 'web', repo: 'web' }];
    s.roles.builder.count = { api: 2, web: 1 }; s.roles.reviewer.count = { api: 1, web: 1 };
  }))}, 'ahmed')`;
  assert.equal((await sql`select cb._repo('zed-dashboard-B1@mac') as r`)[0].r, 'dashboard');
  const s = (await sql`select cb.supervise_state('zed') as r`)[0].r.sessions.find((x: any) => x.actor === 'zed-dashboard-B1@mac');
  assert.equal(s.repo, 'dashboard');
  // an api card at build is not the renamed session's
  const id = Number((await sql`select cb.task_add(project => 'zed', title => 'b', type => 'bug', repos => '["api"]', stage => 'build', why => 'small', actor => 'orch@pc') as id`)[0].id);
  assert.deepEqual([...await sql`select id from cb.task_claim('zed', 'zed-dashboard-B1@mac')`], []);
  assert.equal((await sql`select assignee from cb.tasks where id = ${id}`)[0].assignee, null);
});

test('squad_set refuses to drop or rename a repo that open work names', async () => {
  const sql = await setup();
  const noDash = mod((s) => {
    delete s.repos.dashboard; s.areas = [{ name: 'api', repo: 'api' }];
    s.roles.builder.count = { api: 2 }; s.roles.reviewer.count = { api: 1 };
  });
  const renamed = mod((s) => {
    s.repos.web = s.repos.dashboard; delete s.repos.dashboard;
    s.areas = [{ name: 'api', repo: 'api' }, { name: 'web', repo: 'web' }];
    s.roles.builder.count = { api: 2, web: 1 }; s.roles.reviewer.count = { api: 1, web: 1 };
  });
  const flat = { machines: { shaltoot: { herdr: null, repo: 'C:/work/ZED/api', board: 'C:/work/claude-board' } },
    roles: { lead: { count: 1, machine: 'shaltoot' } } };
  const set = (sq: any) => sql`select cb.squad_set('zed', ${sql.json(sq)}, 'ahmed')`;
  const ids: number[] = [];
  for (let i = 0; i < 6; i++) {
    ids.push(Number((await sql`select cb.task_add(project => 'zed', title => 'c', repos => '["dashboard"]', actor => 'orch@pc') as id`)[0].id));
  }
  const five = ids.slice(0, 5).map((i) => '#' + i).join(', ');
  const refused = new RegExp(`repo dashboard still has open work \\(${five}\\): finish or move those cards first$`);
  await assert.rejects(() => set(noDash), refused);
  await assert.rejects(() => set(renamed), refused);
  // back to flat is the one repo main
  await assert.rejects(() => set(flat), refused);
  // adding a repo stays free
  await set(mod((s) => { s.repos.docs = { paths: s.repos.api.paths }; }));
  for (const i of ids) await sql`update cb.tasks set status = 'cancelled' where id = ${i}`;
  // a part of an open card counts too (here the card itself names api only)
  const p = Number((await sql`select cb.task_add(project => 'zed', title => 'c', repos => '["api"]', actor => 'orch@pc') as id`)[0].id);
  await sql`insert into cb.task_parts (task_id, repo, stage) values (${p}, 'dashboard', 'build')`;
  await assert.rejects(() => set(noDash), new RegExp(`repo dashboard still has open work \\(#${p}\\)`));
  await sql`delete from cb.task_parts where task_id = ${p}`;
  await set(renamed);
  // flat while an open card names api: refused; closed, it goes
  await assert.rejects(() => set(flat), new RegExp(`repo api still has open work \\(#${p}\\)`));
  await sql`update cb.tasks set status = 'cancelled' where id = ${p}`;
  await set(flat);
  assert.deepEqual((await sql`select cb._repos_of('zed') as r`)[0].r, ['main']);
});

test('card repos', async () => {
  const sql = await setup();
  const [{ id }] = await sql`select cb.task_add(project => 'zed', title => 'x', repos => '["dashboard","api"]', actor => 'orch@pc') as id`;
  assert.deepEqual(await repos(sql, id), ['dashboard', 'api']);
  await assert.rejects(() => sql`select cb.task_add(project => 'zed', title => 'x', repos => '["web"]', actor => 'orch@pc')`, /repo web is not a repo of zed/);
  await sql`select cb.task_update(${id}, '{"repos":["api"]}', 'orch@pc')`;
  assert.deepEqual(await repos(sql, id), ['api']);
  await assert.rejects(() => sql`select cb.task_update(${id}, '{"repos":["web"]}', 'orch@pc')`, /repo web is not a repo of zed/);
  await assert.rejects(() => sql`select cb.task_update(${id}, '{"repos":"api"}', 'orch@pc')`, /repos is a list of repo names/);
  // moving a card to another project re-checks its repos there, unless the same edit names valid ones
  const [{ id: mv }] = await sql`select cb.task_add(project => 'zed', title => 'mv', repos => '["dashboard"]', actor => 'orch@pc') as id`;
  await assert.rejects(() => sql`select cb.task_update(${mv}, '{"project":"demo"}', 'orch@pc')`, /repo dashboard is not a repo of demo: main/);
  await assert.rejects(() => sql`select cb.task_update(${mv}, '{"project":"demo","repos":["api"]}', 'orch@pc')`, /repo api is not a repo of demo: main/);
  await sql`select cb.task_update(${mv}, '{"project":"demo","repos":[]}', 'orch@pc')`;
  assert.deepEqual([(await sql`select project from cb.tasks where id = ${mv}`)[0].project, await repos(sql, mv)], ['demo', null]);
  const [{ id: mv2 }] = await sql`select cb.task_add(project => 'zed', title => 'mv2', repos => '["api"]', actor => 'orch@pc') as id`;
  await sql`select cb.task_update(${mv2}, '{"project":"demo","repos":["main"]}', 'orch@pc')`;
  assert.deepEqual(await repos(sql, mv2), ['main']);
  for (const st of ['approval', 'build', 'review', 'merge', 'qa']) {
    await sql`update cb.tasks set stage = ${st} where id = ${id}`;
    await assert.rejects(() => sql`select cb.task_update(${id}, '{"repos":["dashboard"]}', 'orch@pc')`,
      /#\d+ is at .*: repos lock once the design is passed; send it back with cb fail \d+ --to design/);
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
  const ui = await add(sql, 'zed', { labels: ['ui'] });
  await assert.rejects(() => pass(ui, 'zed-O1@pc'), /name the repos first: cb edit \d+ --repo <repo,repo>/);
  const both = await add(sql, 'zed', { labels: ['dashboard', 'api'] });
  assert.equal((await pass(both, 'zed-O1@pc'))[0].r, 'approval');
  assert.deepEqual(await repos(sql, both), ['api', 'dashboard']);
  const one = await add(sql, 'demo', { labels: ['claims'] });
  assert.equal((await pass(one, 'demo-O1@pc'))[0].r, 'approval');
  assert.equal(await repos(sql, one), null);
  // a single repo under repos: the area tag still names it; untagged passes with none
  await sql`select cb.ensure_project('solo'), cb.project_pipeline('solo', true, 'ahmed')`;
  await sql`select cb.squad_set('solo', ${sql.json({ machines: ZED.machines, repos: { api: { paths: ZED.repos.api.paths } },
    areas: [{ name: 'api', repo: 'api' }], roles: { lead: ZED.roles.lead, owner: ZED.roles.owner } })}, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, area) values ('pc','p4','solo-O1@pc','solo','owner','api')`;
  const tagged = await add(sql, 'solo', { labels: ['api'] });
  assert.equal((await pass(tagged, 'solo-O1@pc'))[0].r, 'approval');
  assert.deepEqual(await repos(sql, tagged), ['api']);
  const plain = await add(sql, 'solo', { labels: ['ui'] });
  assert.equal((await pass(plain, 'solo-O1@pc'))[0].r, 'approval');
  assert.equal(await repos(sql, plain), null);
});

test('stage build needs a repo in a multi-repo project', async () => {
  const sql = await setup();
  const bug = await add(sql, 'zed', { type: 'bug' });
  await assert.rejects(() => sql`select cb.stage_set(${bug}, 'build', 'small', 'orch@pc')`, /give the repos: cb stage \d+ build --repo <repo> --why/);
  await assert.rejects(() => sql`select cb.stage_set(${bug}, 'build', 'small', 'orch@pc', repos => '["web"]')`, /repo web is not a repo of zed/);
  assert.equal((await sql`select cb.stage_set(${bug}, 'build', 'small', 'orch@pc', repos => '["dashboard"]') as r`)[0].r, 'build');
  assert.deepEqual(await repos(sql, bug), ['dashboard']);
  // the web and the CLI call it through rpc, which sends arrays as jsonb
  const viaRpc = await add(sql, 'zed', { type: 'bug' });
  assert.equal(await callFn('stage_set', { id: String(viaRpc), stage: 'build', why: 'small', actor: 'orch@pc', repos: ['dashboard', 'api'] }, sql), 'build');
  assert.deepEqual(await repos(sql, viaRpc), ['dashboard', 'api']);
  const ops = await add(sql, 'zed', { type: 'bug' });
  await assert.rejects(() => sql`select cb.stage_set(${ops}, 'none', 'ops', 'orch@pc', repos => '["api"]')`, /repos go with build/);
  // cb add --stage build refuses before creating the card
  const before = (await sql`select count(*)::int n from cb.tasks`)[0].n;
  await assert.rejects(() => sql`select cb.task_add(project => 'zed', title => 'x', type => 'bug', stage => 'build', why => 'small', actor => 'orch@pc')`,
    /give the repos: --stage build --repo <repo> --why/);
  assert.equal((await sql`select count(*)::int n from cb.tasks`)[0].n, before);
  // one repo: no repo needed
  const demo = await add(sql, 'demo', { type: 'bug' });
  assert.equal((await sql`select cb.stage_set(${demo}, 'build', 'small', 'orch@pc') as r`)[0].r, 'build');
  assert.equal(await repos(sql, demo), null);
});

test('CLI: squad show, edit --repo, add --repo, stage --repo', async () => {
  const sql = await setup();
  const show = cb(['squad', 'show', 'zed']);
  assert.equal(show.code, 0, show.err);
  assert.ok(show.out.includes('builder  api 2, dashboard 1 × sonnet on macbook'), show.out);
  assert.ok(show.out.includes('repos: api (home), dashboard'), show.out);
  assert.ok(show.out.includes('areas: api, dashboard'), show.out);
  const id = await add(sql, 'zed');
  const e = cb(['edit', String(id), '--repo', 'api,dashboard']);
  assert.equal(e.code, 0, e.err);
  assert.deepEqual(await repos(sql, id), ['api', 'dashboard']);
  assert.equal(cb(['edit', String(id), '--repo', '']).code, 0);
  assert.equal(await repos(sql, id), null);
  // empty names (a trailing or doubled comma) are dropped
  const e2 = cb(['edit', String(id), '--repo', 'api,,dashboard']);
  assert.equal(e2.code, 0, e2.err);
  assert.deepEqual(await repos(sql, id), ['api', 'dashboard']);
  const a = cb(['add', 'zed', 'x', '--repo', 'api,']);
  assert.equal(a.code, 0, a.err);
  assert.deepEqual(await repos(sql, Number(a.out.replace('#', ''))), ['api']);
  const i = cb(['iam', 'zed-api-B2@pc', 'zed', '--role', 'builder', '--repo', 'api'], { HERDR_PANE_ID: 'p9' });
  assert.equal(i.code, 0, i.err);
  assert.equal((await sql`select repo from cb.sessions where machine = 'pc' and pane = 'p9'`)[0].repo, 'api');
  assert.match(cb(['help', 'bug']).out, /^cb bug .*\[--stage build --why "<why>"\] \[--repo <repo,repo>\]/);
  const bug = await add(sql, 'zed', { type: 'bug' });
  const s = cb(['stage', String(bug), 'build', '--repo', 'dashboard,', '--why', 'small']);
  assert.equal(s.code, 0, s.err);
  assert.deepEqual(await repos(sql, bug), ['dashboard']);
  const b = cb(['bug', 'zed', 'y', '-b', 'broke', '--stage', 'build', '--why', 'small', '--repo', 'api']);
  assert.equal(b.code, 0, b.err);
  const [{ id: bid }] = await sql`select max(id)::int as id from cb.tasks`;
  assert.deepEqual(await repos(sql, bid), ['api']);
  assert.equal((await sql`select stage from cb.tasks where id = ${bid}`)[0].stage, 'build');
});

test('squad_set refuses a session name over herdr\'s 32 characters', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('claude-board')`;
  const set = (s: any) => sql`select cb.squad_set('claude-board', ${sql.json(s)}, 'ahmed')`;
  const msg = (n: string) => new RegExp(`session name ${n} is over herdr's 32 characters: use a shorter repo, area or machine key`);
  // claude-board-dashboard-b1-macbook is 33
  await assert.rejects(set(mod((s) => { s.areas[1].name = 'dash'; })), msg('claude-board-dashboard-B1@macbook'));
  // the home repo's names carry no repo; an owner's carries its area; the lead is orch@<machine>
  const short = mod((s) => { s.repos.dash = s.repos.dashboard; delete s.repos.dashboard; s.areas[1] = { name: 'dash', repo: 'dash' };
    s.roles.builder.count = { api: 2, dash: 1 }; s.roles.reviewer.count = { api: 1, dash: 1 }; });
  await set(short); // claude-board-dash-B1@macbook, claude-board-O-dash@shaltoot: 28 each
  const from = (f: (s: any) => void) => { const s = structuredClone(short); f(s); return s; };
  await assert.rejects(set(from((s) => { s.areas[1].name = 'dashboard'; })), msg('claude-board-O-dashboard@shaltoot'));
  const far = 'a-machine-key-of-31-characters-x';
  await assert.rejects(set(from((s) => { s.machines[far] = s.machines.shaltoot; delete s.machines.shaltoot;
    for (const r of Object.values<any>(s.repos)) { r.paths[far] = r.paths.shaltoot; delete r.paths.shaltoot; }
    s.roles.lead.machine = far; s.roles.owner.machine = 'macbook'; })), msg(`orch@${far}`));
  // the lead starts as <project>-orch@<machine> when orch@<machine> leads another project (#3746): that name must fit too
  const mid = 'lead-machine-15'; // orch@lead-machine-15 is 20, claude-board-orch@lead-machine-15 is 33
  await assert.rejects(set(from((s) => { s.machines[mid] = s.machines.shaltoot; delete s.machines.shaltoot;
    for (const r of Object.values<any>(s.repos)) { r.paths[mid] = r.paths.shaltoot; delete r.paths.shaltoot; }
    s.roles.lead.machine = mid; s.roles.owner.machine = 'macbook'; })), msg(`claude-board-orch@${mid}`));
  // no repos: <project>-<letter><count>@<machine>
  const flat = { machines: { macbook: { herdr: 'macbook', repo: '/r', board: '/b' } }, roles: { builder: { count: 1, machine: 'macbook' } } };
  await sql`select cb.ensure_project('a-long-project-name-here')`;
  await assert.rejects(sql`select cb.squad_set('a-long-project-name-here', ${sql.json(flat)}, 'ahmed')`, msg('a-long-project-name-here-B1@macbook'));
});

test('squad_set name check: project-wide roles carry no repo in their name', async () => {
  const sql = await freshDb(); clients.push(sql);
  const p = 'a-nineteen-char-prj'; // <p>-Q1@macbook is 30; a wrong main- infix would make it 35
  await sql`select cb.ensure_project(${p})`;
  const paths = (r: string) => ({ macbook: `/Users/me/Work/${r}`, pc: `C:/work/${r}` });
  const sq = { machines: { macbook: { herdr: 'macbook', board: '/b' }, pc: { herdr: null, board: 'C:/b' } },
    repos: { api: { home: true, paths: paths('api') }, x: { paths: paths('x') } },
    areas: [{ name: 'a', repo: 'api' }, { name: 'x', repo: 'x' }],
    roles: { lead: { count: 1, machine: 'pc' }, owner: { machine: 'pc' }, architect: { count: 1, machine: 'pc' }, investigator: { count: 1, machine: 'pc' },
             builder: { count: { api: 1, x: 1 }, machine: 'macbook' }, reviewer: { count: { api: 1, x: 1 }, machine: 'macbook' },
             qa: { count: 1, machine: 'macbook' } } };
  // longest real names: <p>-x-B1@macbook and <p>-x-R1@macbook, 32 each
  const s = (await sql`select cb.squad_set(${p}, ${sql.json(sq)}, 'ahmed') as s`)[0].s;
  assert.equal(s.roles.qa.count, 1);
});

// #3746 C1 on real sessions_overview rows (jsonb, last_seen an ISO string): a lead-role session quiet 10 minutes is named,
// and no other lead is started beside it
test('squad up on real session rows: a quiet lead-role session is named, no other lead is started', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('zed')`;
  await sql`select cb.iam('shaltoot', 'p1', 'QO@shaltoot', 'zed', 'lead')`;
  await sql`update cb.sessions set last_seen = now() - interval '10 minutes' where actor = 'QO@shaltoot'`;
  const rows = await callFn('sessions_overview', { project: null }, sql) as any[];
  const qo = rows.find((r) => r.actor === 'QO@shaltoot');
  assert.equal(qo.live, false);
  assert.equal(qo.project, 'zed');
  assert.equal(qo.role, 'lead');
  assert.equal(typeof qo.last_seen, 'string');
  const run = (_m: string | null, args: string[]) => (args[1] === 'get'
    ? { status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found"}}' } : { status: 0, stdout: '{"agents":[]}', stderr: '' });
  const out = await squadUp('zed', true, async (fn, a) => (fn === 'squad_get' ? ZED : callFn(fn, a, sql)), run);
  assert.match(out, /^skip lead: QO@shaltoot leads zed but is not live \(last seen 10 min ago\): restart it by hand in a tab made with herdr tab create --env 'CB_ROLE=lead' --env 'CB_AGENT=claude', or cb iam <name> zed --role lead$/m);
  assert.doesNotMatch(out, /start \S*orch/);
});
