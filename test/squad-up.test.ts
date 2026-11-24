import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSquad, classifyAgentGet, squadUp, herdrName, wantList, launchFor, startOne, type Runner } from '../cli/squad-up.ts';

const mach = (herdr: string | null, board: string) => ({ herdr, repo: '/Users/me/Work/demo', board });
const squad = {
  machines: { shaltoot: mach(null, 'C:/b'), macbook: mach('macbook', '/Users/me/board') },
  roles: {
    lead: { count: 1, model: 'opus', machine: 'shaltoot' },
    builder: { count: 2, model: 'sonnet', machine: 'macbook' },
    reviewer: { count: 1, model: 'opus', machine: 'macbook' },
    owner: { model: 'sonnet', machine: 'macbook' },
  },
  areas: ['claims'],
};
const names = (p: { start: { name: string }[] }) => p.start.map((l) => l.name);

test('plans every role with its name, model, machine, settings and prompt', () => {
  const p = planSquad('demo', squad, [], {});
  assert.deepEqual(names(p).sort(), ['demo-B1@macbook', 'demo-B2@macbook', 'demo-O-claims@macbook', 'demo-R1@macbook', 'orch@shaltoot']);
  assert.deepEqual(p.skip, []);
  assert.deepEqual(p.refused, []);
  const b = p.start.find((l) => l.name === 'demo-B1@macbook')!;
  assert.equal(b.model, 'sonnet');
  assert.equal(b.herdr, 'macbook');
  assert.equal(b.cwd, '/Users/me/Work/demo');
  assert.equal(b.settings, '/Users/me/board/kit/permissions/builder.json');
  assert.equal(b.prompt, 'cb iam demo-B1@macbook demo --role builder --model sonnet, then cb role builder, then cb next');
  const lead = p.start.find((l) => l.role === 'lead')!;
  assert.equal(lead.herdr, null);
  assert.equal(lead.model, 'opus');
  const o = p.start.find((l) => l.role === 'owner')!;
  assert.equal(o.area, 'claims');
  assert.ok(o.prompt.includes('--area claims'));
});

test('a name live on the board, or running in herdr, is skipped', () => {
  const p = planSquad('demo', squad, [{ actor: 'demo-B1@macbook', machine: 'macbook' }], { macbook: ['demo-R1@macbook'] });
  assert.deepEqual(p.skip.sort(), ['demo-B1@macbook', 'demo-R1@macbook']);
  assert.ok(!names(p).includes('demo-B1@macbook') && !names(p).includes('demo-R1@macbook'));
  assert.equal(p.start.length, 3);
});

test('the Mac cap of 8 counts other live sessions: the rest are refused', () => {
  const live = Array.from({ length: 6 }, (_, i) => ({ actor: `other-B${i}@macbook`, machine: 'macbook' }));
  const p = planSquad('demo', squad, live, {});
  assert.equal(p.start.filter((l) => l.machine === 'macbook').length, 2);
  assert.deepEqual(p.refused, ['demo-B2@macbook', 'demo-R1@macbook']);
  assert.ok(names(p).includes('orch@shaltoot'));
});

test('the Mac cap also counts the agents herdr lists on the Mac (quiet or unnamed)', () => {
  const p = planSquad('demo', squad, [], {}, 7);
  assert.equal(p.start.filter((l) => l.machine === 'macbook').length, 1);
  assert.equal(p.refused.length, 3);
});

test('a live session named exactly orch is the lead, on any machine', () => {
  const p = planSquad('demo', squad, [{ actor: 'orch', machine: 'shaltoot' }], {});
  assert.ok(p.skip.includes('orch@shaltoot'));
  assert.ok(!names(p).includes('orch@shaltoot'));
});

test('agent get: exit 0 live, agent_not_found absent, anything else unknown', () => {
  assert.equal(classifyAgentGet({ status: 0 }), 'live');
  assert.equal(classifyAgentGet({ status: 1, stderr: '{"error":{"code":"agent_not_found"}}' }), 'absent');
  assert.equal(classifyAgentGet({ status: 1, stderr: 'machine unreachable' }), 'unknown');
  assert.equal(classifyAgentGet({ status: null, error: new Error('ETIMEDOUT') }), 'unknown');
});

test('the Mac cap counts by the herdr label, whatever the machine key', () => {
  const sq = { ...squad, machines: { shaltoot: squad.machines.shaltoot, mac: squad.machines.macbook },
    roles: { ...squad.roles, builder: { count: 2, model: 'sonnet', machine: 'mac' }, reviewer: { count: 1, model: 'opus', machine: 'mac' }, owner: { model: 'sonnet', machine: 'mac' } } };
  const live = Array.from({ length: 6 }, (_, i) => ({ actor: `other-B${i}@mac`, machine: 'mac' }));
  const p = planSquad('demo', sq, live, {});
  assert.equal(p.start.filter((l) => l.machine === 'mac').length, 2);
  assert.equal(p.refused.length, 2);
});

test('a second project cannot take the lead name another project holds', () => {
  const p = planSquad('demo', squad, [{ actor: 'orch@shaltoot', machine: 'shaltoot', project: 'other' }], {});
  assert.deepEqual(p.heldBy, { 'orch@shaltoot': 'other' });
  assert.ok(!names(p).includes('orch@shaltoot'));
});

// ---- squadUp with a fake herdr: nothing real is started ----
const OK = { status: 0, stdout: '{}', stderr: '' };
const GONE = { status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found"}}' };
type Call = { m: string | null; args: string[]; timeout?: number };
function fake(handler: (c: Call) => any) {
  const calls: Call[] = [];
  const run: Runner = (m, args, timeout) => { const c = { m, args, timeout }; calls.push(c); return handler(c) ?? OK; };
  return { calls, run };
}
const has = (calls: Call[], ...a: string[]) => calls.some((c) => a.every((x, i) => c.args[i] === x));
const rows = (list: [string, string, boolean][]) => list.map(([actor, project, live]) => ({ actor, project, live, machine: actor.split('@')[1] }));
const callFn = (r: any[]) => async (fn: string) => (fn === 'squad_get' ? squad : r);
const paneOut = (id: string) => ({ status: 0, stdout: JSON.stringify({ result: { pane_id: id } }), stderr: '' });

test('squad up: a quiet session that herdr lists is not started a second time', async () => {
  const mac7 = { status: 0, stdout: JSON.stringify({ agents: Array.from({ length: 7 }, (_, i) => ({ name: `a${i}` })) }), stderr: '' };
  const f = fake((c) => {
    if (c.args[0] === 'agent' && c.args[1] === 'list') return mac7;
    if (c.args[0] === 'agent' && c.args[1] === 'get') return /b1-macbook|o-claims-macbook/.test(c.args[2]!) ? OK : GONE;
    if (c.args[0] === 'tab') return paneOut('p1');
  });
  // B1 and O-claims are in herdr but quiet on the board (not live)
  const out = await squadUp('demo', false, callFn(rows([['demo-B1@macbook', 'demo', false], ['demo-O-claims@macbook', 'demo', false]])), f.run);
  assert.ok(!f.calls.some((c) => c.args[0] === 'agent' && c.args[1] === 'start' && c.args[2] === 'demo-b1-macbook'), out);
  assert.ok(!f.calls.some((c) => c.args[0] === 'agent' && c.args[1] === 'start' && c.args[2] === 'demo-o-claims-macbook'), out);
  assert.ok(has(f.calls, 'agent', 'get', 'demo-b1-macbook') && has(f.calls, 'agent', 'get', 'demo-r1-macbook'));
  assert.match(out, /skip demo-B1@macbook: running in herdr but not on the board \(not bound\?\)\n  herdr --machine macbook agent prompt demo-b1-macbook "cb iam demo-B1@macbook demo --role builder/);
  assert.match(out, /started demo-B2@macbook/);
  assert.match(out, /refused demo-R1@macbook/); // 7 on the Mac + B2 = the cap of 8
  assert.ok(f.calls.filter((c) => c.args[1] === 'list').every((c) => c.timeout === 30_000));
});

test('squad up: a started session whose prompt failed prints the command to send it', async () => {
  const f = fake((c) => {
    if (c.args[1] === 'get') return GONE;
    if (c.args[0] === 'tab') return paneOut('p1');
    if (c.args[1] === 'prompt' && c.args[2] === 'orch-shaltoot') return { status: 1, stderr: 'boom' };
  });
  const out = await squadUp('demo', false, callFn([]), f.run);
  assert.match(out, /^started orch@shaltoot, prompt not sent: herdr agent prompt orch-shaltoot "cb iam orch@shaltoot demo --role lead --model opus, then cb role lead, then cb next"$/m);
  assert.ok(!has(f.calls, 'pane', 'close'));
});

test('squad up: a launch that fails closes only the pane this run made for it', async () => {
  let n = 0;
  const f = fake((c) => {
    if (c.args[1] === 'get') return GONE;
    if (c.args[0] === 'tab' || c.args[0] === 'pane' && c.args[1] === 'split') return paneOut(`p${++n}`);
    if (c.args[1] === 'start' && c.args[2] === 'demo-b2-macbook') return { status: 1, stderr: 'no model' };
  });
  const out = await squadUp('demo', false, callFn([]), f.run);
  assert.match(out, /failed demo-B2@macbook: no model/);
  const closes = f.calls.filter((c) => c.args[0] === 'pane' && c.args[1] === 'close');
  assert.equal(closes.length, 1);
  assert.equal(closes[0]!.args[2], 'p4'); // the fourth pane made this run is B2's: no earlier pane is closed
});

test('squad up: the lead name held by another project is reported, not started', async () => {
  const f = fake((c) => (c.args[1] === 'get' ? GONE : undefined));
  const out = await squadUp('demo', true, callFn(rows([['orch@shaltoot', 'other', true]])), f.run);
  assert.match(out, /skip orch@shaltoot: lead name held by project other/);
});

test('herdrName: lowercase slug of the board name', () => {
  assert.equal(herdrName('kitlive-B1@shaltoot'), 'kitlive-b1-shaltoot');
  assert.equal(herdrName('orch@shaltoot'), 'orch-shaltoot');
  assert.equal(herdrName('demo-O-claims@macbook'), 'demo-o-claims-macbook');
});

test('squad up: herdr gets the slug name, the prompt keeps the board name', async () => {
  const sq = { ...squad, roles: { lead: squad.roles.lead, builder: { count: 1, model: 'sonnet', machine: 'shaltoot' } }, areas: [] };
  const f = fake((c) => (c.args[1] === 'get' ? GONE : c.args[0] === 'tab' || c.args[0] === 'pane' ? paneOut('p1') : undefined));
  const out = await squadUp('kitlive', false, async (fn: string) => (fn === 'squad_get' ? sq : []), f.run);
  for (const v of ['get', 'start', 'prompt']) assert.ok(f.calls.some((c) => c.args[0] === 'agent' && c.args[1] === v && c.args[2] === 'kitlive-b1-shaltoot'), v + out);
  assert.ok(f.calls.some((c) => c.args[1] === 'prompt' && c.args[2] === 'orch-shaltoot'));
  assert.ok(f.calls.some((c) => c.args[1] === 'prompt' && c.args[3]!.startsWith('cb iam kitlive-B1@shaltoot kitlive')));
  assert.match(out, /started kitlive-B1@shaltoot/);
});

test('squad up: a name that makes the herdr name too long fails up front, no pane made', async () => {
  const sq = { ...squad, roles: { builder: { count: 1, model: 'sonnet', machine: 'shaltoot' } }, areas: [] };
  const f = fake((c) => (c.args[1] === 'get' ? GONE : paneOut('p1')));
  const long = 'a-very-long-project-name-indeed';
  const out = await squadUp(long, false, async (fn: string) => (fn === 'squad_get' ? sq : []), f.run);
  assert.match(out, new RegExp(`failed ${long}-B1@shaltoot: herdr name ${long}-b1-shaltoot is invalid`));
  assert.ok(!f.calls.some((c) => c.args[0] === 'tab' || c.args[1] === 'start'));
});

test('squad up: agent_not_ready keeps the pane and prints how to finish; any other start error closes it', async () => {
  const sq = { ...squad, roles: { builder: { count: 1, model: 'sonnet', machine: 'macbook' } }, areas: [] };
  const mk = (err: string) => fake((c) => {
    if (c.args[1] === 'get') return GONE;
    if (c.args[0] === 'tab') return paneOut('p7');
    if (c.args[1] === 'start') return { status: 1, stderr: err };
  });
  const cf = async (fn: string) => (fn === 'squad_get' ? sq : []);
  const a = mk('{"error":{"code":"agent_not_ready","message":"blocked during startup"}}');
  const out = await squadUp('demo', false, cf, a.run);
  assert.ok(!has(a.calls, 'pane', 'close'));
  assert.ok(!a.calls.some((c) => c.args[1] === 'prompt'));
  assert.match(out, /blocked demo-B1@macbook: a startup dialog is waiting \(folder trust or bypass warning\)\. Answer it in herdr pane p7 on macbook, then run: herdr --machine macbook agent prompt demo-b1-macbook "cb iam demo-B1@macbook demo/);
  const b = mk('{"error":{"code":"model_missing"}}');
  const out2 = await squadUp('demo', false, cf, b.run);
  assert.match(out2, /failed demo-B1@macbook/);
  assert.ok(has(b.calls, 'pane', 'close', 'p7'));
});

// ---- several repos in one project (#3703) ----
// the saved shape (squad_set fills models and home); dashboard listed first: the home repo still comes first
const QHS: any = {
  machines: { shaltoot: { herdr: null, board: 'F:/Work/claude-board' }, macbook: { herdr: 'macbook', board: '/Users/me/Work/claude-board' } },
  repos: {
    dashboard: { home: false, paths: { shaltoot: 'F:/Work/QHS/dashboard', macbook: '/Users/me/Work/QHS/dashboard' } },
    api: { home: true, paths: { shaltoot: 'F:/Work/QHS/api', macbook: '/Users/me/Work/QHS/api' } },
  },
  areas: [{ name: 'api', repo: 'api' }, { name: 'dashboard', repo: 'dashboard' }],
  roles: {
    lead: { count: 1, model: 'opus', machine: 'shaltoot' },
    architect: { count: 1, model: 'opus', machine: 'shaltoot' },
    owner: { model: 'opus', machine: 'shaltoot' },
    builder: { count: { api: 2, dashboard: 1 }, model: 'sonnet', machine: 'macbook' },
    reviewer: { count: { api: 1, dashboard: 1 }, model: 'opus', machine: 'macbook' },
    qa: { count: 1, model: 'sonnet', machine: 'macbook' },
  },
};

test('repos: one name per repo, folders from the repo paths', () => {
  const w = wantList('qhs', QHS);
  assert.deepEqual(w, [
    { name: 'orch@shaltoot', role: 'lead', repo: 'api' },
    { name: 'qhs-A1@shaltoot', role: 'architect', repo: 'api' },
    { name: 'qhs-O-api@shaltoot', role: 'owner', area: 'api', repo: 'api' },
    { name: 'qhs-O-dashboard@shaltoot', role: 'owner', area: 'dashboard', repo: 'dashboard' },
    { name: 'qhs-B1@macbook', role: 'builder', repo: 'api' },
    { name: 'qhs-B2@macbook', role: 'builder', repo: 'api' },
    { name: 'qhs-dashboard-B1@macbook', role: 'builder', repo: 'dashboard' },
    { name: 'qhs-R1@macbook', role: 'reviewer', repo: 'api' },
    { name: 'qhs-dashboard-R1@macbook', role: 'reviewer', repo: 'dashboard' },
    { name: 'qhs-Q1@macbook', role: 'qa', repo: 'api' },
  ]);
  const l = (n: string, first: 'next' | 'resume' = 'next') => launchFor('qhs', QHS, w.find((x) => x.name === n)!, first);
  const b = l('qhs-dashboard-B1@macbook');
  assert.equal(b.cwd, '/Users/me/Work/QHS/dashboard');
  assert.equal(b.repo, 'dashboard');
  assert.equal(b.prompt, 'cb iam qhs-dashboard-B1@macbook qhs --role builder --model sonnet --repo dashboard, then cb role builder, then cb next');
  assert.equal(l('qhs-B1@macbook').cwd, '/Users/me/Work/QHS/api');
  const o = l('qhs-O-dashboard@shaltoot');
  assert.equal(o.cwd, 'F:/Work/QHS/dashboard');
  assert.equal(o.prompt, 'cb iam qhs-O-dashboard@shaltoot qhs --role owner --area dashboard --model opus --repo dashboard, then cb role owner, then cb next');
  assert.equal(l('orch@shaltoot').prompt, 'cb iam orch@shaltoot qhs --role lead --model opus --repo api, then cb role lead, then cb next');
  assert.equal(l('orch@shaltoot').cwd, 'F:/Work/QHS/api');
  // architect and qa read across repos: every repo path on their machine
  assert.equal(l('qhs-Q1@macbook').cwd, '/Users/me/Work/QHS/api');
  assert.equal(l('qhs-Q1@macbook').prompt, 'cb iam qhs-Q1@macbook qhs --role qa --model sonnet --repo api, then cb role qa, then cb next. Repos: api /Users/me/Work/QHS/api, dashboard /Users/me/Work/QHS/dashboard');
  assert.equal(l('qhs-A1@shaltoot').prompt, 'cb iam qhs-A1@shaltoot qhs --role architect --model opus --repo api, then cb role architect, then cb next. Repos: api F:/Work/QHS/api, dashboard F:/Work/QHS/dashboard');
  assert.equal(l('qhs-A1@shaltoot', 'resume').prompt, 'cb iam qhs-A1@shaltoot qhs --role architect --model opus --repo api, then cb role architect, then cb resume. Repos: api F:/Work/QHS/api, dashboard F:/Work/QHS/dashboard');
  // a repo with no path on that machine is left out of the repos line
  const noDash = structuredClone(QHS); delete noDash.repos.dashboard.paths.macbook;
  assert.ok(launchFor('qhs', noDash, w.find((x) => x.name === 'qhs-Q1@macbook')!).prompt.endsWith('then cb next. Repos: api /Users/me/Work/QHS/api'));
});

// the ihop squad as saved today (no repos): captured from wantList and launchFor on the base commit (3d2e210)
const IHOP: any = {"areas":["claims","preauth","fwa","kb","platform"],"roles":{"qa":{"count":1,"model":"sonnet","machine":"macbook"},"lead":{"count":1,"model":"opus","machine":"shaltoot"},"owner":{"model":"opus","machine":"shaltoot"},"builder":{"count":3,"model":"sonnet","machine":"macbook"},"reviewer":{"count":2,"model":"opus","machine":"macbook"},"architect":{"count":1,"model":"opus","machine":"shaltoot"},"investigator":{"count":1,"model":"opus","machine":"macbook"}},"machines":{"macbook":{"repo":"/Users/ahmedshaltoot/Work/Tachyhealth/Tawuniya/iHop-Platform","board":"/Users/ahmedshaltoot/Work/claude-board","herdr":"macbook"},"shaltoot":{"repo":"F:/Work/Tawuniya/iHop-Platform","board":"F:/Work/claude-board","herdr":null}},"supervise":true};
const IHOP_WANT = [{"name":"orch@shaltoot","role":"lead"},{"name":"ihop-A1@shaltoot","role":"architect"},{"name":"ihop-O-claims@shaltoot","role":"owner","area":"claims"},{"name":"ihop-O-preauth@shaltoot","role":"owner","area":"preauth"},{"name":"ihop-O-fwa@shaltoot","role":"owner","area":"fwa"},{"name":"ihop-O-kb@shaltoot","role":"owner","area":"kb"},{"name":"ihop-O-platform@shaltoot","role":"owner","area":"platform"},{"name":"ihop-B1@macbook","role":"builder"},{"name":"ihop-B2@macbook","role":"builder"},{"name":"ihop-B3@macbook","role":"builder"},{"name":"ihop-R1@macbook","role":"reviewer"},{"name":"ihop-R2@macbook","role":"reviewer"},{"name":"ihop-Q1@macbook","role":"qa"},{"name":"ihop-I1@macbook","role":"investigator"}];
const IHOP_LAUNCH = [{"name":"orch@shaltoot","role":"lead","model":"opus","machine":"shaltoot","herdr":null,"cwd":"F:/Work/Tawuniya/iHop-Platform","settings":"F:/Work/claude-board/kit/permissions/lead.json","prompt":"cb iam orch@shaltoot ihop --role lead --model opus, then cb role lead, then cb next"},{"name":"ihop-A1@shaltoot","role":"architect","model":"opus","machine":"shaltoot","herdr":null,"cwd":"F:/Work/Tawuniya/iHop-Platform","settings":"F:/Work/claude-board/kit/permissions/architect.json","prompt":"cb iam ihop-A1@shaltoot ihop --role architect --model opus, then cb role architect, then cb next"},{"name":"ihop-O-claims@shaltoot","role":"owner","area":"claims","model":"opus","machine":"shaltoot","herdr":null,"cwd":"F:/Work/Tawuniya/iHop-Platform","settings":"F:/Work/claude-board/kit/permissions/owner.json","prompt":"cb iam ihop-O-claims@shaltoot ihop --role owner --area claims --model opus, then cb role owner, then cb next"},{"name":"ihop-O-preauth@shaltoot","role":"owner","area":"preauth","model":"opus","machine":"shaltoot","herdr":null,"cwd":"F:/Work/Tawuniya/iHop-Platform","settings":"F:/Work/claude-board/kit/permissions/owner.json","prompt":"cb iam ihop-O-preauth@shaltoot ihop --role owner --area preauth --model opus, then cb role owner, then cb next"},{"name":"ihop-O-fwa@shaltoot","role":"owner","area":"fwa","model":"opus","machine":"shaltoot","herdr":null,"cwd":"F:/Work/Tawuniya/iHop-Platform","settings":"F:/Work/claude-board/kit/permissions/owner.json","prompt":"cb iam ihop-O-fwa@shaltoot ihop --role owner --area fwa --model opus, then cb role owner, then cb next"},{"name":"ihop-O-kb@shaltoot","role":"owner","area":"kb","model":"opus","machine":"shaltoot","herdr":null,"cwd":"F:/Work/Tawuniya/iHop-Platform","settings":"F:/Work/claude-board/kit/permissions/owner.json","prompt":"cb iam ihop-O-kb@shaltoot ihop --role owner --area kb --model opus, then cb role owner, then cb next"},{"name":"ihop-O-platform@shaltoot","role":"owner","area":"platform","model":"opus","machine":"shaltoot","herdr":null,"cwd":"F:/Work/Tawuniya/iHop-Platform","settings":"F:/Work/claude-board/kit/permissions/owner.json","prompt":"cb iam ihop-O-platform@shaltoot ihop --role owner --area platform --model opus, then cb role owner, then cb next"},{"name":"ihop-B1@macbook","role":"builder","model":"sonnet","machine":"macbook","herdr":"macbook","cwd":"/Users/ahmedshaltoot/Work/Tachyhealth/Tawuniya/iHop-Platform","settings":"/Users/ahmedshaltoot/Work/claude-board/kit/permissions/builder.json","prompt":"cb iam ihop-B1@macbook ihop --role builder --model sonnet, then cb role builder, then cb next"},{"name":"ihop-B2@macbook","role":"builder","model":"sonnet","machine":"macbook","herdr":"macbook","cwd":"/Users/ahmedshaltoot/Work/Tachyhealth/Tawuniya/iHop-Platform","settings":"/Users/ahmedshaltoot/Work/claude-board/kit/permissions/builder.json","prompt":"cb iam ihop-B2@macbook ihop --role builder --model sonnet, then cb role builder, then cb next"},{"name":"ihop-B3@macbook","role":"builder","model":"sonnet","machine":"macbook","herdr":"macbook","cwd":"/Users/ahmedshaltoot/Work/Tachyhealth/Tawuniya/iHop-Platform","settings":"/Users/ahmedshaltoot/Work/claude-board/kit/permissions/builder.json","prompt":"cb iam ihop-B3@macbook ihop --role builder --model sonnet, then cb role builder, then cb next"},{"name":"ihop-R1@macbook","role":"reviewer","model":"opus","machine":"macbook","herdr":"macbook","cwd":"/Users/ahmedshaltoot/Work/Tachyhealth/Tawuniya/iHop-Platform","settings":"/Users/ahmedshaltoot/Work/claude-board/kit/permissions/reviewer.json","prompt":"cb iam ihop-R1@macbook ihop --role reviewer --model opus, then cb role reviewer, then cb next"},{"name":"ihop-R2@macbook","role":"reviewer","model":"opus","machine":"macbook","herdr":"macbook","cwd":"/Users/ahmedshaltoot/Work/Tachyhealth/Tawuniya/iHop-Platform","settings":"/Users/ahmedshaltoot/Work/claude-board/kit/permissions/reviewer.json","prompt":"cb iam ihop-R2@macbook ihop --role reviewer --model opus, then cb role reviewer, then cb next"},{"name":"ihop-Q1@macbook","role":"qa","model":"sonnet","machine":"macbook","herdr":"macbook","cwd":"/Users/ahmedshaltoot/Work/Tachyhealth/Tawuniya/iHop-Platform","settings":"/Users/ahmedshaltoot/Work/claude-board/kit/permissions/qa.json","prompt":"cb iam ihop-Q1@macbook ihop --role qa --model sonnet, then cb role qa, then cb next"},{"name":"ihop-I1@macbook","role":"investigator","model":"opus","machine":"macbook","herdr":"macbook","cwd":"/Users/ahmedshaltoot/Work/Tachyhealth/Tawuniya/iHop-Platform","settings":"/Users/ahmedshaltoot/Work/claude-board/kit/permissions/investigator.json","prompt":"cb iam ihop-I1@macbook ihop --role investigator --model opus, then cb role investigator, then cb next"}];
const IHOP_RESUME = ["cb iam orch@shaltoot ihop --role lead --model opus, then cb role lead, then cb resume","cb iam ihop-A1@shaltoot ihop --role architect --model opus, then cb role architect, then cb resume","cb iam ihop-O-claims@shaltoot ihop --role owner --area claims --model opus, then cb role owner, then cb resume","cb iam ihop-O-preauth@shaltoot ihop --role owner --area preauth --model opus, then cb role owner, then cb resume","cb iam ihop-O-fwa@shaltoot ihop --role owner --area fwa --model opus, then cb role owner, then cb resume","cb iam ihop-O-kb@shaltoot ihop --role owner --area kb --model opus, then cb role owner, then cb resume","cb iam ihop-O-platform@shaltoot ihop --role owner --area platform --model opus, then cb role owner, then cb resume","cb iam ihop-B1@macbook ihop --role builder --model sonnet, then cb role builder, then cb resume","cb iam ihop-B2@macbook ihop --role builder --model sonnet, then cb role builder, then cb resume","cb iam ihop-B3@macbook ihop --role builder --model sonnet, then cb role builder, then cb resume","cb iam ihop-R1@macbook ihop --role reviewer --model opus, then cb role reviewer, then cb resume","cb iam ihop-R2@macbook ihop --role reviewer --model opus, then cb role reviewer, then cb resume","cb iam ihop-Q1@macbook ihop --role qa --model sonnet, then cb role qa, then cb resume","cb iam ihop-I1@macbook ihop --role investigator --model opus, then cb role investigator, then cb resume"];

test('no repos: names, folders and prompts exactly as before', () => {
  const w = wantList('ihop', IHOP);
  // the one new field is repo, main on every item
  assert.ok(w.every((x) => x.repo === 'main'));
  assert.deepEqual(w.map(({ repo, ...x }) => x), IHOP_WANT);
  const ls = w.map((x) => launchFor('ihop', IHOP, x));
  assert.ok(ls.every((x) => x.repo === 'main'));
  assert.deepEqual(ls.map(({ repo, ...x }) => x), IHOP_LAUNCH);
  assert.deepEqual(w.map((x) => launchFor('ihop', IHOP, x, 'resume').prompt), IHOP_RESUME);
});

// ---- a machine's herdr workspace (#3719): new tabs open in the squad's workspace, not the focused one ----
const wsSquad = { ...squad, machines: { ...squad.machines, macbook: { ...mach('macbook', '/Users/me/board'), workspace: 'iHop Squad' } } };
const wsLaunch = (name: string) => launchFor('demo', wsSquad, wantList('demo', wsSquad).find((w) => w.name === name)!);
const wsList = (...ws: [string, string][]) => ({ status: 0, stdout: JSON.stringify({ result: { workspaces: ws.map(([workspace_id, label]) => ({ workspace_id, label })) } }), stderr: '' });

test('launchFor carries the machine workspace; none when the squad names none', () => {
  assert.equal(wsLaunch('demo-B1@macbook').workspace, 'iHop Squad');
  assert.equal(wsLaunch('orch@shaltoot').workspace, undefined);
});

test('startOne: the tab opens in the named workspace when herdr has it', () => {
  const f = fake((c) => {
    if (c.args[0] === 'workspace' && c.args[1] === 'list') return wsList(['w1', 'Workers'], ['w4', 'iHop Squad']);
    if (c.args[0] === 'tab') return paneOut('w4:p9');
  });
  const r = startOne(wsLaunch('demo-B1@macbook'), f.run, {});
  assert.ok(r.ok, r.line);
  const tab = f.calls.find((c) => c.args[0] === 'tab' && c.args[1] === 'create')!;
  assert.deepEqual(tab.args.slice(2, 4), ['--workspace', 'w4']);
  assert.ok(f.calls.every((c) => c.m === 'macbook'));
  assert.ok(f.calls.some((c) => c.args[1] === 'start' && c.args.includes('w4:p9')));
});

test('startOne: a missing workspace is created with its label, and its first pane takes the session', () => {
  const f = fake((c) => {
    if (c.args[0] === 'workspace' && c.args[1] === 'list') return wsList(['w1', 'Workers']);
    if (c.args[0] === 'workspace' && c.args[1] === 'create')
      return { status: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: 'w7', label: 'iHop Squad' }, tab: { tab_id: 'w7:t1' }, root_pane: { pane_id: 'w7:p1' } } }), stderr: '' };
  });
  const r = startOne(wsLaunch('demo-B1@macbook'), f.run, {});
  assert.ok(r.ok, r.line);
  const ws = f.calls.find((c) => c.args[0] === 'workspace' && c.args[1] === 'create')!;
  assert.equal(ws.args[ws.args.indexOf('--label') + 1], 'iHop Squad');
  assert.equal(ws.args[ws.args.indexOf('--cwd') + 1], '/Users/me/Work/demo');
  assert.ok(!has(f.calls, 'tab', 'create'));
  assert.ok(f.calls.some((c) => c.args[1] === 'start' && c.args.includes('w7:p1')));
});

test('startOne: no workspace in the squad keeps today\'s tab in the focused workspace', () => {
  const f = fake((c) => { if (c.args[0] === 'tab') return paneOut('p1'); });
  assert.ok(startOne(wsLaunch('orch@shaltoot'), f.run, {}).ok);
  assert.ok(!f.calls.some((c) => c.args[0] === 'workspace'));
  assert.ok(!f.calls.find((c) => c.args[0] === 'tab')!.args.includes('--workspace'));
});

test('startOne: three launches on one machine: a tab in the workspace, a split of it, then a new tab there', () => {
  let n = 0;
  const f = fake((c) => {
    if (c.args[0] === 'workspace' && c.args[1] === 'list') return wsList(['w4', 'iHop Squad']);
    if (c.args[0] === 'tab' || (c.args[0] === 'pane' && c.args[1] === 'split')) return paneOut(`w4:p${++n}`);
  });
  const tabs = {};
  for (const name of ['demo-B1@macbook', 'demo-B2@macbook', 'demo-R1@macbook']) assert.ok(startOne(wsLaunch(name), f.run, tabs).ok);
  const made = f.calls.filter((c) => c.args[0] === 'tab' || c.args[1] === 'split').map((c) => c.args.slice(0, 4).join(' '));
  assert.deepEqual(made, ['tab create --workspace w4', 'pane split --pane w4:p1', 'tab create --workspace w4']);
});

test('startOne: a launch that fails after making the workspace closes only that workspace\'s pane', () => {
  const f = fake((c) => {
    if (c.args[0] === 'workspace' && c.args[1] === 'list') return wsList();
    if (c.args[0] === 'workspace' && c.args[1] === 'create')
      return { status: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: 'w7' }, root_pane: { pane_id: 'w7:p1' } } }), stderr: '' };
    if (c.args[1] === 'start') return { status: 1, stderr: 'boom' };
  });
  assert.ok(!startOne(wsLaunch('demo-B1@macbook'), f.run, {}).ok);
  assert.deepEqual(f.calls.filter((c) => c.args[1] === 'close').map((c) => c.args[2]), ['w7:p1']);
});

test('startOne: a workspace list herdr did not answer with makes no workspace', () => {
  const f = fake((c) => { if (c.args[0] === 'workspace' && c.args[1] === 'list') return { status: 0, stdout: 'warning: something', stderr: '' }; });
  const r = startOne(wsLaunch('demo-B1@macbook'), f.run, {});
  assert.ok(!r.ok);
  assert.match(r.line, /herdr workspace list gave no workspaces/);
  assert.ok(!f.calls.some((c) => c.args[0] === 'workspace' && c.args[1] === 'create'));
});
