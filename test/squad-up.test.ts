import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSquad, classifyAgentGet, squadUp, herdrName, wantList, launchFor, seatSpec, startOne, type Runner } from '../cli/squad-up.ts';
import { squadShow } from '../cli/squad-show.ts';

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

test('a live session named exactly orch leads its own project, on any machine; another project\'s is not this one\'s lead', () => {
  const p = planSquad('demo', squad, [{ actor: 'orch', machine: 'shaltoot', project: 'demo' }], {});
  assert.ok(!p.start.some((l) => l.role === 'lead'), names(p).join());
  const q = planSquad('demo', squad, [{ actor: 'orch', machine: 'shaltoot', project: 'other' }], {});
  assert.ok(names(q).includes('orch@shaltoot'), names(q).join());
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

// #3746: a project's lead is the session live in it with the lead role, whatever its name
test('orch@<machine> leading another project: this project\'s lead starts as <project>-orch@<machine>', () => {
  const p = planSquad('demo', squad, [{ actor: 'orch@shaltoot', machine: 'shaltoot', project: 'other', role: 'lead' }], {});
  assert.deepEqual(p.heldBy, {});
  assert.deepEqual(p.skip, []);
  assert.ok(!names(p).includes('orch@shaltoot'));
  const lead = p.start.find((l) => l.role === 'lead')!;
  const { seatKey, agent, board, env, ...was } = lead; // the agent-neutral fields (#4002); the rest as before
  assert.deepEqual(was, { name: 'demo-orch@shaltoot', role: 'lead', repo: 'main', model: 'opus', machine: 'shaltoot', herdr: null,
    cwd: '/Users/me/Work/demo', settings: 'C:/b/kit/permissions/lead.json',
    prompt: 'cb iam demo-orch@shaltoot demo --role lead --model opus, then cb role lead, then cb next' });
  assert.deepEqual({ seatKey, agent, board, env }, { seatKey: '1', agent: 'claude', board: 'C:/b', env: { CB_ROLE: 'lead', CB_AGENT: 'claude' } });
  // the next run: the alternate lead is live in demo, skipped as live like any squad name
  const again = planSquad('demo', squad, [{ actor: 'orch@shaltoot', machine: 'shaltoot', project: 'other', role: 'lead' },
    { actor: 'demo-orch@shaltoot', machine: 'shaltoot', project: 'demo', role: 'lead' }], {});
  assert.deepEqual(again.skip, ['demo-orch@shaltoot']);
  assert.ok(!again.start.some((l) => l.role === 'lead'));
});

test('a lead-role session live in the project, whatever its name, is its lead: no lead started, none skipped', () => {
  const live = [{ actor: 'orch@shaltoot', machine: 'shaltoot', project: 'other', role: 'lead' }, { actor: 'QO@shaltoot', machine: 'shaltoot', project: 'demo', role: 'lead' }];
  const p = planSquad('demo', squad, live, {});
  assert.ok(!p.start.some((l) => l.role === 'lead'), names(p).join());
  assert.deepEqual(p.skip, []);
  assert.deepEqual(p.heldBy, {});
  // the same session bound to another project leads that one, not this
  const q = planSquad('demo', squad, [{ actor: 'QO@shaltoot', machine: 'shaltoot', project: 'other', role: 'lead' }], {});
  assert.ok(names(q).includes('orch@shaltoot'), names(q).join());
});

test('orch@<machine> live in this project is skipped as today, nothing renamed; live with no project too', () => {
  for (const role of [null, 'lead']) { // sessions_overview gives role null outside a pipeline project
    const p = planSquad('demo', squad, [{ actor: 'orch@shaltoot', machine: 'shaltoot', project: 'demo', role }], {});
    assert.deepEqual(p.skip, ['orch@shaltoot']);
    assert.ok(!p.start.some((l) => l.role === 'lead'), names(p).join());
    assert.deepEqual(p.heldBy, {});
  }
  const u = planSquad('demo', squad, [{ actor: 'orch@shaltoot', machine: 'shaltoot', project: null }], {});
  assert.deepEqual(u.skip, ['orch@shaltoot']);
  assert.ok(!u.start.some((l) => l.role === 'lead'));
});

test('the alternate lead name live in a third project is held by it, not started', () => {
  const p = planSquad('demo', squad, [{ actor: 'orch@shaltoot', machine: 'shaltoot', project: 'other' },
    { actor: 'demo-orch@shaltoot', machine: 'shaltoot', project: 'third', role: 'builder' }], {});
  assert.deepEqual(p.skip, ['demo-orch@shaltoot']);
  assert.deepEqual(p.heldBy, { 'demo-orch@shaltoot': 'third' });
  assert.ok(!p.start.some((l) => l.role === 'lead'));
});

// a quiet lead: a lead-role session of this project seen in the last day (cb.triagers' window), not live now
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const orchElsewhere = { actor: 'orch@shaltoot', machine: 'shaltoot', project: 'other', role: 'lead' };
const quietQO = (min: number, project = 'demo', role: string | null = 'lead') => ({ actor: 'QO@shaltoot', project, role, last_seen: ago(min) });

test('a quiet lead seen in the last day: no other lead is started beside it; seen 2 days ago, the lead starts as before', () => {
  for (const live of [[orchElsewhere], []]) { // neither <project>-orch@<m> nor orch@<m>
    const p = planSquad('demo', squad, live, {}, 0, [quietQO(10)]);
    assert.ok(!p.start.some((l) => l.role === 'lead'), names(p).join());
    assert.deepEqual(p.skip, []);
    assert.deepEqual(p.quietLead, { actor: 'QO@shaltoot', mins: 10 });
  }
  const old = planSquad('demo', squad, [orchElsewhere], {}, 0, [quietQO(2 * 24 * 60)]);
  assert.equal(old.start.find((l) => l.role === 'lead')?.name, 'demo-orch@shaltoot');
  assert.equal(old.quietLead, null);
  // quiet in another project, or not a lead: not this project's lead
  for (const q of [quietQO(10, 'other'), quietQO(10, 'demo', 'builder')])
    assert.ok(names(planSquad('demo', squad, [], {}, 0, [q])).includes('orch@shaltoot'));
});

test('orch@<machine> leading this project but not live is restarted under its own name, as today; the alternate too', () => {
  const p = planSquad('demo', squad, [], {}, 0, [{ actor: 'orch@shaltoot', project: 'demo', role: null, last_seen: ago(10) }]);
  assert.ok(names(p).includes('orch@shaltoot'), names(p).join());
  assert.equal(p.quietLead, null);
  const a = planSquad('demo', squad, [orchElsewhere], {}, 0, [{ actor: 'demo-orch@shaltoot', project: 'demo', role: 'lead', last_seen: ago(10) }]);
  assert.ok(names(a).includes('demo-orch@shaltoot'), names(a).join());
  assert.equal(a.quietLead, null);
});

// orch@<m> quiet in another project within a day still leads that one: taking its name here would rebind it (#3746 I1)
const quietOrch = (min: number) => ({ actor: 'orch@shaltoot', project: 'other', role: 'lead', last_seen: ago(min) });
test('orch@<machine> quiet in another project within a day: this project\'s lead is <project>-orch@<machine>; a day gone, orch@<machine>', () => {
  const p = planSquad('demo', squad, [], {}, 0, [quietOrch(10)]);
  assert.equal(p.start.find((l) => l.role === 'lead')?.name, 'demo-orch@shaltoot');
  assert.ok(!names(p).includes('orch@shaltoot'), names(p).join());
  assert.equal(p.quietLead, null);
  const old = planSquad('demo', squad, [], {}, 0, [quietOrch(2 * 24 * 60)]);
  assert.equal(old.start.find((l) => l.role === 'lead')?.name, 'orch@shaltoot');
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
const rows = (list: [string, string, boolean, string?][]) => list.map(([actor, project, live, role]) => ({ actor, project, live, machine: actor.split('@')[1], role: role ?? null }));
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

test('squad up: orch@<machine> leading another project: the lead starts as <project>-orch@<machine>, asked of herdr by that name', async () => {
  const f = fake((c) => (c.args[1] === 'get' ? GONE : undefined));
  const out = await squadUp('demo', true, callFn(rows([['orch@shaltoot', 'other', true, 'lead']])), f.run);
  assert.match(out, /^start demo-orch@shaltoot \(lead, opus\) on shaltoot$/m);
  assert.doesNotMatch(out, /held by|orch@shaltoot: live/);
  assert.ok(has(f.calls, 'agent', 'get', 'demo-orch-shaltoot'));
  assert.ok(!has(f.calls, 'agent', 'get', 'orch-shaltoot'));
});

test('squad up: the alternate lead already running in herdr (quiet on the board) is not started a second time', async () => {
  const f = fake((c) => {
    if (c.args[1] === 'get') return c.args[2] === 'demo-orch-shaltoot' ? OK : GONE;
    if (c.args[0] === 'tab' || c.args[0] === 'pane') return paneOut('p1');
  });
  const out = await squadUp('demo', false, callFn(rows([['orch@shaltoot', 'other', true, 'lead'], ['demo-orch@shaltoot', 'demo', false]])), f.run);
  assert.match(out, /skip demo-orch@shaltoot: running in herdr but not on the board \(not bound\?\)\n  herdr agent prompt demo-orch-shaltoot "cb iam demo-orch@shaltoot demo --role lead/);
  assert.ok(!f.calls.some((c) => c.args[1] === 'start' && /orch/.test(c.args[2]!)), out);
});

test('squad up: orch@<machine> quiet in another project: herdr is asked about <project>-orch, never orch-<machine>', async () => {
  const f = fake((c) => (c.args[1] === 'get' ? GONE : undefined));
  const out = await squadUp('demo', true, callFn([{ ...quietOrch(10), live: false, machine: 'shaltoot' }]), f.run);
  assert.ok(has(f.calls, 'agent', 'get', 'demo-orch-shaltoot'), JSON.stringify(f.calls.map((c) => c.args)));
  assert.ok(!has(f.calls, 'agent', 'get', 'orch-shaltoot'));
  assert.match(out, /^start demo-orch@shaltoot \(lead, opus\) on shaltoot$/m);
  assert.doesNotMatch(out, /orch@shaltoot demo|start orch@/);
});

test('squad up: a quiet lead: no lead started, one line names it and how to fix it; seen 2 days ago, the lead starts', async () => {
  const quietRow = (min: number) => ({ actor: 'QO@shaltoot', project: 'demo', live: false, machine: 'shaltoot', role: 'lead', last_seen: ago(min) });
  const f = fake((c) => (c.args[1] === 'get' ? GONE : undefined));
  const out = await squadUp('demo', true, callFn([...rows([['orch@shaltoot', 'other', true, 'lead']]), quietRow(10)]), f.run);
  assert.match(out, /^skip lead: QO@shaltoot leads demo but is not live \(last seen 10 min ago\): restart it by hand in a tab made with herdr tab create --env 'CB_ROLE=lead' --env 'CB_AGENT=claude', or cb iam <name> demo --role lead$/m);
  assert.doesNotMatch(out, /start \S*orch/);
  assert.ok(!f.calls.some((c) => c.args[1] === 'get' && /orch/.test(c.args[2]!)));
  // squad up never starts it, so never gives it the protected list: the line says how (#3746)
  const prot = await squadUp('demo', true, async (fn: string) => (fn === 'squad_get' ? { ...squad, protected: ['development', 'releases/*'] } : [quietRow(10)]), fake(() => GONE).run);
  assert.match(prot, /^skip lead: QO@shaltoot leads demo but is not live \(last seen 10 min ago\): restart it by hand in a tab made with herdr tab create --env 'CB_ROLE=lead' --env 'CB_AGENT=claude' --env 'CB_PROTECTED_BRANCHES=development,releases\/\*', or cb iam <name> demo --role lead$/m);
  assert.match(await squadUp('demo', true, callFn([quietRow(125)]), fake(() => GONE).run), /\(last seen 2h 5m ago\)/);
  const old = await squadUp('demo', true, callFn([...rows([['orch@shaltoot', 'other', true, 'lead']]), quietRow(2 * 24 * 60)]), fake(() => GONE).run);
  assert.match(old, /^start demo-orch@shaltoot \(lead, opus\) on shaltoot$/m);
  assert.doesNotMatch(old, /skip lead/);
});

test('squad up: a lead-role session live in the project is its lead: herdr is not asked about a lead, none started', async () => {
  const f = fake((c) => (c.args[1] === 'get' ? GONE : undefined));
  const out = await squadUp('demo', true, callFn(rows([['QO@shaltoot', 'demo', true, 'lead']])), f.run);
  assert.doesNotMatch(out, /orch/);
  assert.ok(!f.calls.some((c) => c.args[1] === 'get' && /orch/.test(c.args[2]!)));
  assert.match(out, /start demo-B1@macbook/);
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
const ZED: any = {
  machines: { shaltoot: { herdr: null, board: 'C:/work/claude-board' }, macbook: { herdr: 'macbook', board: '/Users/me/Work/claude-board' } },
  repos: {
    dashboard: { home: false, paths: { shaltoot: 'C:/work/ZED/dashboard', macbook: '/Users/me/Work/ZED/dashboard' } },
    api: { home: true, paths: { shaltoot: 'C:/work/ZED/api', macbook: '/Users/me/Work/ZED/api' } },
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
  const w = wantList('zed', ZED);
  // seatKey (#4002): the key a squad seat override is saved under, as cb.squad_set and cb._expected_model read it
  assert.deepEqual(w, [
    { name: 'orch@shaltoot', role: 'lead', repo: 'api', seatKey: '1' },
    { name: 'zed-A1@shaltoot', role: 'architect', repo: 'api', seatKey: '1' },
    { name: 'zed-O-api@shaltoot', role: 'owner', area: 'api', repo: 'api', seatKey: 'api' },
    { name: 'zed-O-dashboard@shaltoot', role: 'owner', area: 'dashboard', repo: 'dashboard', seatKey: 'dashboard' },
    { name: 'zed-B1@macbook', role: 'builder', repo: 'api', seatKey: 'api:1' },
    { name: 'zed-B2@macbook', role: 'builder', repo: 'api', seatKey: 'api:2' },
    { name: 'zed-dashboard-B1@macbook', role: 'builder', repo: 'dashboard', seatKey: 'dashboard:1' },
    { name: 'zed-R1@macbook', role: 'reviewer', repo: 'api', seatKey: 'api:1' },
    { name: 'zed-dashboard-R1@macbook', role: 'reviewer', repo: 'dashboard', seatKey: 'dashboard:1' },
    { name: 'zed-Q1@macbook', role: 'qa', repo: 'api', seatKey: '1' },
  ]);
  const l = (n: string, first: 'next' | 'resume' = 'next') => launchFor('zed', ZED, w.find((x) => x.name === n)!, first);
  const b = l('zed-dashboard-B1@macbook');
  assert.equal(b.cwd, '/Users/me/Work/ZED/dashboard');
  assert.equal(b.repo, 'dashboard');
  assert.equal(b.prompt, 'cb iam zed-dashboard-B1@macbook zed --role builder --model sonnet --repo dashboard, then cb role builder, then cb next');
  assert.equal(l('zed-B1@macbook').cwd, '/Users/me/Work/ZED/api');
  const o = l('zed-O-dashboard@shaltoot');
  assert.equal(o.cwd, 'C:/work/ZED/dashboard');
  assert.equal(o.prompt, 'cb iam zed-O-dashboard@shaltoot zed --role owner --area dashboard --model opus --repo dashboard, then cb role owner, then cb next');
  assert.equal(l('orch@shaltoot').prompt, 'cb iam orch@shaltoot zed --role lead --model opus --repo api, then cb role lead, then cb next');
  assert.equal(l('orch@shaltoot').cwd, 'C:/work/ZED/api');
  // architect and qa read across repos: every repo path on their machine
  assert.equal(l('zed-Q1@macbook').cwd, '/Users/me/Work/ZED/api');
  assert.equal(l('zed-Q1@macbook').prompt, 'cb iam zed-Q1@macbook zed --role qa --model sonnet --repo api, then cb role qa, then cb next. Repos: api /Users/me/Work/ZED/api, dashboard /Users/me/Work/ZED/dashboard');
  assert.equal(l('zed-A1@shaltoot').prompt, 'cb iam zed-A1@shaltoot zed --role architect --model opus --repo api, then cb role architect, then cb next. Repos: api C:/work/ZED/api, dashboard C:/work/ZED/dashboard');
  assert.equal(l('zed-A1@shaltoot', 'resume').prompt, 'cb iam zed-A1@shaltoot zed --role architect --model opus --repo api, then cb role architect, then cb resume. Repos: api C:/work/ZED/api, dashboard C:/work/ZED/dashboard');
  // a repo with no path on that machine is left out of the repos line
  const noDash = structuredClone(ZED); delete noDash.repos.dashboard.paths.macbook;
  assert.ok(launchFor('zed', noDash, w.find((x) => x.name === 'zed-Q1@macbook')!).prompt.endsWith('then cb next. Repos: api /Users/me/Work/ZED/api'));
});

// the iris squad as saved today (no repos): captured from wantList and launchFor on the base commit (3d2e210)
const IRIS: any = {"areas":["claims","preauth","fwa","kb","platform"],"roles":{"qa":{"count":1,"model":"sonnet","machine":"macbook"},"lead":{"count":1,"model":"opus","machine":"shaltoot"},"owner":{"model":"opus","machine":"shaltoot"},"builder":{"count":3,"model":"sonnet","machine":"macbook"},"reviewer":{"count":2,"model":"opus","machine":"macbook"},"architect":{"count":1,"model":"opus","machine":"shaltoot"},"investigator":{"count":1,"model":"opus","machine":"macbook"}},"machines":{"macbook":{"repo":"/Users/me/work/acme/widgets","board":"/Users/me/work/claude-board","herdr":"macbook"},"shaltoot":{"repo":"C:/work/acme/widgets","board":"C:/work/claude-board","herdr":null}},"supervise":true};
const IRIS_WANT = [{"name":"orch@shaltoot","role":"lead"},{"name":"iris-A1@shaltoot","role":"architect"},{"name":"iris-O-claims@shaltoot","role":"owner","area":"claims"},{"name":"iris-O-preauth@shaltoot","role":"owner","area":"preauth"},{"name":"iris-O-fwa@shaltoot","role":"owner","area":"fwa"},{"name":"iris-O-kb@shaltoot","role":"owner","area":"kb"},{"name":"iris-O-platform@shaltoot","role":"owner","area":"platform"},{"name":"iris-B1@macbook","role":"builder"},{"name":"iris-B2@macbook","role":"builder"},{"name":"iris-B3@macbook","role":"builder"},{"name":"iris-R1@macbook","role":"reviewer"},{"name":"iris-R2@macbook","role":"reviewer"},{"name":"iris-Q1@macbook","role":"qa"},{"name":"iris-I1@macbook","role":"investigator"}];
const IRIS_LAUNCH = [{"name":"orch@shaltoot","role":"lead","model":"opus","machine":"shaltoot","herdr":null,"cwd":"C:/work/acme/widgets","settings":"C:/work/claude-board/kit/permissions/lead.json","prompt":"cb iam orch@shaltoot iris --role lead --model opus, then cb role lead, then cb next"},{"name":"iris-A1@shaltoot","role":"architect","model":"opus","machine":"shaltoot","herdr":null,"cwd":"C:/work/acme/widgets","settings":"C:/work/claude-board/kit/permissions/architect.json","prompt":"cb iam iris-A1@shaltoot iris --role architect --model opus, then cb role architect, then cb next"},{"name":"iris-O-claims@shaltoot","role":"owner","area":"claims","model":"opus","machine":"shaltoot","herdr":null,"cwd":"C:/work/acme/widgets","settings":"C:/work/claude-board/kit/permissions/owner.json","prompt":"cb iam iris-O-claims@shaltoot iris --role owner --area claims --model opus, then cb role owner, then cb next"},{"name":"iris-O-preauth@shaltoot","role":"owner","area":"preauth","model":"opus","machine":"shaltoot","herdr":null,"cwd":"C:/work/acme/widgets","settings":"C:/work/claude-board/kit/permissions/owner.json","prompt":"cb iam iris-O-preauth@shaltoot iris --role owner --area preauth --model opus, then cb role owner, then cb next"},{"name":"iris-O-fwa@shaltoot","role":"owner","area":"fwa","model":"opus","machine":"shaltoot","herdr":null,"cwd":"C:/work/acme/widgets","settings":"C:/work/claude-board/kit/permissions/owner.json","prompt":"cb iam iris-O-fwa@shaltoot iris --role owner --area fwa --model opus, then cb role owner, then cb next"},{"name":"iris-O-kb@shaltoot","role":"owner","area":"kb","model":"opus","machine":"shaltoot","herdr":null,"cwd":"C:/work/acme/widgets","settings":"C:/work/claude-board/kit/permissions/owner.json","prompt":"cb iam iris-O-kb@shaltoot iris --role owner --area kb --model opus, then cb role owner, then cb next"},{"name":"iris-O-platform@shaltoot","role":"owner","area":"platform","model":"opus","machine":"shaltoot","herdr":null,"cwd":"C:/work/acme/widgets","settings":"C:/work/claude-board/kit/permissions/owner.json","prompt":"cb iam iris-O-platform@shaltoot iris --role owner --area platform --model opus, then cb role owner, then cb next"},{"name":"iris-B1@macbook","role":"builder","model":"sonnet","machine":"macbook","herdr":"macbook","cwd":"/Users/me/work/acme/widgets","settings":"/Users/me/work/claude-board/kit/permissions/builder.json","prompt":"cb iam iris-B1@macbook iris --role builder --model sonnet, then cb role builder, then cb next"},{"name":"iris-B2@macbook","role":"builder","model":"sonnet","machine":"macbook","herdr":"macbook","cwd":"/Users/me/work/acme/widgets","settings":"/Users/me/work/claude-board/kit/permissions/builder.json","prompt":"cb iam iris-B2@macbook iris --role builder --model sonnet, then cb role builder, then cb next"},{"name":"iris-B3@macbook","role":"builder","model":"sonnet","machine":"macbook","herdr":"macbook","cwd":"/Users/me/work/acme/widgets","settings":"/Users/me/work/claude-board/kit/permissions/builder.json","prompt":"cb iam iris-B3@macbook iris --role builder --model sonnet, then cb role builder, then cb next"},{"name":"iris-R1@macbook","role":"reviewer","model":"opus","machine":"macbook","herdr":"macbook","cwd":"/Users/me/work/acme/widgets","settings":"/Users/me/work/claude-board/kit/permissions/reviewer.json","prompt":"cb iam iris-R1@macbook iris --role reviewer --model opus, then cb role reviewer, then cb next"},{"name":"iris-R2@macbook","role":"reviewer","model":"opus","machine":"macbook","herdr":"macbook","cwd":"/Users/me/work/acme/widgets","settings":"/Users/me/work/claude-board/kit/permissions/reviewer.json","prompt":"cb iam iris-R2@macbook iris --role reviewer --model opus, then cb role reviewer, then cb next"},{"name":"iris-Q1@macbook","role":"qa","model":"sonnet","machine":"macbook","herdr":"macbook","cwd":"/Users/me/work/acme/widgets","settings":"/Users/me/work/claude-board/kit/permissions/qa.json","prompt":"cb iam iris-Q1@macbook iris --role qa --model sonnet, then cb role qa, then cb next"},{"name":"iris-I1@macbook","role":"investigator","model":"opus","machine":"macbook","herdr":"macbook","cwd":"/Users/me/work/acme/widgets","settings":"/Users/me/work/claude-board/kit/permissions/investigator.json","prompt":"cb iam iris-I1@macbook iris --role investigator --model opus, then cb role investigator, then cb next"}];
const IRIS_RESUME = ["cb iam orch@shaltoot iris --role lead --model opus, then cb role lead, then cb resume","cb iam iris-A1@shaltoot iris --role architect --model opus, then cb role architect, then cb resume","cb iam iris-O-claims@shaltoot iris --role owner --area claims --model opus, then cb role owner, then cb resume","cb iam iris-O-preauth@shaltoot iris --role owner --area preauth --model opus, then cb role owner, then cb resume","cb iam iris-O-fwa@shaltoot iris --role owner --area fwa --model opus, then cb role owner, then cb resume","cb iam iris-O-kb@shaltoot iris --role owner --area kb --model opus, then cb role owner, then cb resume","cb iam iris-O-platform@shaltoot iris --role owner --area platform --model opus, then cb role owner, then cb resume","cb iam iris-B1@macbook iris --role builder --model sonnet, then cb role builder, then cb resume","cb iam iris-B2@macbook iris --role builder --model sonnet, then cb role builder, then cb resume","cb iam iris-B3@macbook iris --role builder --model sonnet, then cb role builder, then cb resume","cb iam iris-R1@macbook iris --role reviewer --model opus, then cb role reviewer, then cb resume","cb iam iris-R2@macbook iris --role reviewer --model opus, then cb role reviewer, then cb resume","cb iam iris-Q1@macbook iris --role qa --model sonnet, then cb role qa, then cb resume","cb iam iris-I1@macbook iris --role investigator --model opus, then cb role investigator, then cb resume"];

test('no repos: names, folders and prompts exactly as before', () => {
  const w = wantList('iris', IRIS);
  // the one new field is repo, main on every item
  assert.ok(w.every((x) => x.repo === 'main'));
  assert.deepEqual(w.map(({ repo, seatKey, ...x }) => x), IRIS_WANT);
  // seat keys (#4002): no repos, so the bare number (never main:2); an owner its area; the lead 1
  assert.deepEqual(w.map((x) => x.seatKey), ['1', '1', 'claims', 'preauth', 'fwa', 'kb', 'platform', '1', '2', '3', '1', '2', '1', '1']);
  const ls = w.map((x) => launchFor('iris', IRIS, x));
  assert.ok(ls.every((x) => x.repo === 'main'));
  // the snapshot stays byte for byte; the agent-neutral fields (#4002) are checked on their own
  assert.deepEqual(ls.map(({ repo, seatKey, agent, board, env, ...x }) => x), IRIS_LAUNCH);
  for (const l of ls) {
    assert.equal(l.agent, 'claude', l.name);
    assert.equal(l.board, IRIS.machines[l.machine].board, l.name);
    assert.deepEqual(l.env, { CB_ROLE: l.role, CB_AGENT: 'claude' }, l.name);
  }
  assert.deepEqual(w.map((x) => launchFor('iris', IRIS, x, 'resume').prompt), IRIS_RESUME);
});

// #4002: the whole herdr call that starts a Claude seat, byte for byte as before the adapter (pinned on the code before it)
test('startOne: a Claude seat starts with exactly today\'s herdr argv', () => {
  const b1 = launchFor('iris', IRIS, wantList('iris', IRIS).find((w) => w.name === 'iris-B1@macbook')!);
  const f = fake((c) => { if (c.args[0] === 'tab') return paneOut('w2:p5'); });
  assert.ok(startOne(b1, f.run, {}).ok);
  const start = f.calls.filter((c) => c.args[0] === 'agent' && c.args[1] === 'start');
  assert.deepEqual(start.map((c) => [c.m, ...c.args]), [['macbook', 'agent', 'start', 'iris-b1-macbook', '--kind', 'claude', '--pane', 'w2:p5',
    '--timeout', '120000', '--', '--model', 'sonnet', '--permission-mode', 'bypassPermissions', '--settings',
    '/Users/me/work/claude-board/kit/permissions/builder.json',
    '--strict-mcp-config', '--mcp-config', '/Users/me/work/claude-board/kit/mcp/none.json']]);
});

test('the iris squad with orch@shaltoot live in iris: the lead is skipped, nothing renamed (#3746)', () => {
  const p = planSquad('iris', IRIS, [{ actor: 'orch@shaltoot', machine: 'shaltoot', project: 'iris', role: 'lead' }], {});
  assert.deepEqual(p.skip, ['orch@shaltoot']);
  assert.deepEqual(p.heldBy, {});
  assert.deepEqual(names(p), IRIS_WANT.slice(1).map((w) => w.name));
  assert.deepEqual(p.refused, []);
});

// ---- a machine's herdr workspace (#3719): new tabs open in the squad's workspace, not the focused one ----
const wsSquad = { ...squad, machines: { ...squad.machines, macbook: { ...mach('macbook', '/Users/me/board'), workspace: 'Iris Squad' } } };
const wsLaunch = (name: string) => launchFor('demo', wsSquad, wantList('demo', wsSquad).find((w) => w.name === name)!);
const wsList = (...ws: [string, string][]) => ({ status: 0, stdout: JSON.stringify({ result: { workspaces: ws.map(([workspace_id, label]) => ({ workspace_id, label })) } }), stderr: '' });

test('launchFor carries the machine workspace; none when the squad names none', () => {
  assert.equal(wsLaunch('demo-B1@macbook').workspace, 'Iris Squad');
  assert.equal(wsLaunch('orch@shaltoot').workspace, undefined);
});

test('startOne: the tab opens in the named workspace when herdr has it', () => {
  const f = fake((c) => {
    if (c.args[0] === 'workspace' && c.args[1] === 'list') return wsList(['w1', 'Workers'], ['w4', 'Iris Squad']);
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
      return { status: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: 'w7', label: 'Iris Squad' }, tab: { tab_id: 'w7:t1' }, root_pane: { pane_id: 'w7:p1' } } }), stderr: '' };
  });
  const r = startOne(wsLaunch('demo-B1@macbook'), f.run, {});
  assert.ok(r.ok, r.line);
  const ws = f.calls.find((c) => c.args[0] === 'workspace' && c.args[1] === 'create')!;
  assert.equal(ws.args[ws.args.indexOf('--label') + 1], 'Iris Squad');
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
    if (c.args[0] === 'workspace' && c.args[1] === 'list') return wsList(['w4', 'Iris Squad']);
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

// #3747: a pane herdr just made may not have its shell up yet; agent start then says agent_pane_busy
const BUSY = { status: 1, stderr: '{"error":{"code":"agent_pane_busy","message":"target pane is not an available shell"}}' };

test('startOne: a split whose shell is not up yet (agent_pane_busy) is retried, and the session starts in it', () => {
  let starts = 0;
  const waits: number[] = [];
  const f = fake((c) => {
    if (c.args[0] === 'pane' && c.args[1] === 'split') return paneOut('w4:p2');
    if (c.args[1] === 'start') return ++starts < 3 ? BUSY : OK;
  });
  const r = startOne(wsLaunch('demo-B2@macbook'), f.run, { macbook: { pane: 'w4:p1', panes: 1 } }, (ms) => waits.push(ms));
  assert.ok(r.ok, r.line);
  assert.equal(starts, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((ms) => ms > 0));
  assert.ok(!has(f.calls, 'pane', 'close'));
  assert.ok(f.calls.some((c) => c.args[1] === 'prompt'));
});

test('startOne: a pane still busy after the retries is closed and the launch fails with herdr\'s reason', () => {
  let starts = 0;
  const f = fake((c) => {
    if (c.args[0] === 'pane' && c.args[1] === 'split') return paneOut('w4:p2');
    if (c.args[1] === 'start') { starts++; return BUSY; }
  });
  const waits: number[] = [];
  const r = startOne(wsLaunch('demo-B2@macbook'), f.run, { macbook: { pane: 'w4:p1', panes: 1 } }, (ms) => waits.push(ms));
  assert.ok(!r.ok);
  assert.equal(starts, 6);
  assert.equal(waits.length, 5);
  assert.ok(waits.reduce((a, b) => a + b, 0) >= 8000, 'about 10 s of waiting in all');
  assert.match(r.line, /agent_pane_busy/);
  assert.deepEqual(f.calls.filter((c) => c.args[1] === 'close').map((c) => c.args[2]), ['w4:p2']);
});

test('startOne: any other start error is not retried', () => {
  let starts = 0;
  const waits: number[] = [];
  const f = fake((c) => {
    if (c.args[0] === 'tab') return paneOut('p1');
    if (c.args[1] === 'start') { starts++; return { status: 1, stderr: '{"error":{"code":"model_missing"}}' }; }
  });
  const r = startOne(wsLaunch('orch@shaltoot'), f.run, {}, (ms) => waits.push(ms));
  assert.ok(!r.ok);
  assert.equal(starts, 1);
  assert.equal(waits.length, 0);
  assert.match(r.line, /model_missing/);
});

test('startOne: busy, then a startup dialog: the split is kept as blocked and counts toward its tab', () => {
  let starts = 0;
  const f = fake((c) => {
    if (c.args[0] === 'pane' && c.args[1] === 'split') return paneOut('w4:p2');
    if (c.args[1] === 'start') return ++starts === 1 ? BUSY : { status: 1, stderr: '{"error":{"code":"agent_not_ready","message":"blocked during startup"}}' };
  });
  const tabs = { macbook: { pane: 'w4:p1', panes: 1 } };
  const r = startOne(wsLaunch('demo-B2@macbook'), f.run, tabs, () => {});
  assert.ok(r.ok && r.blocked, r.line);
  assert.equal(r.pane, 'w4:p2');
  assert.equal(tabs.macbook.panes, 2);
  assert.ok(!has(f.calls, 'pane', 'close'));
  assert.ok(!f.calls.some((c) => c.args[1] === 'prompt'));
});

// ---- protected branches (#3746): every pane a squad session gets carries the squad's list, for the push hook ----
// a glob and a slash in the value (C11): it reaches herdr as one argument, never split or expanded
const ENV = ['--env', 'CB_PROTECTED_BRANCHES=development,releases/*'];
const paneMaker = (c: Call) => (c.args[0] === 'tab' && c.args[1] === 'create') || (c.args[0] === 'pane' && c.args[1] === 'split')
  || (c.args[0] === 'workspace' && c.args[1] === 'create');
// four launches: the Mac's workspace is made, then split, then a new tab there; the lead on the PC opens a plain tab
function launchFour(s: any) {
  const launch = (name: string) => launchFor('demo', s, wantList('demo', s).find((w) => w.name === name)!);
  let made = false, n = 1;
  const f = fake((c) => {
    if (c.args[0] === 'workspace' && c.args[1] === 'list') return made ? wsList(['w7', 'Iris Squad']) : wsList();
    if (c.args[0] === 'workspace' && c.args[1] === 'create') {
      made = true;
      return { status: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: 'w7' }, root_pane: { pane_id: 'w7:p1' } } }), stderr: '' };
    }
    if (c.args[0] === 'tab' || c.args[1] === 'split') return paneOut(`w7:p${++n}`);
  });
  const tabs = {};
  for (const name of ['demo-B1@macbook', 'demo-B2@macbook', 'demo-R1@macbook', 'orch@shaltoot']) assert.ok(startOne(launch(name), f.run, tabs).ok);
  assert.deepEqual(f.calls.filter(paneMaker).map((c) => c.args.slice(0, 2).join(' ')), ['workspace create', 'pane split', 'tab create', 'tab create']);
  return { f, launch };
}

// every pane also gets its session's role and agent (#4002), in launchFour's order: B1, B2, R1, the lead
const ROLE_ENV = ['builder', 'builder', 'reviewer', 'lead'].map((r) => ['--env', `CB_ROLE=${r}`, '--env', 'CB_AGENT=claude']);

test('protected branches: tab create, pane split and workspace create each carry --env CB_PROTECTED_BRANCHES (#3746)', () => {
  const { f, launch } = launchFour({ ...wsSquad, protected: ['development', 'releases/*'] });
  assert.deepEqual(launch('demo-B1@macbook').env, { CB_ROLE: 'builder', CB_AGENT: 'claude', CB_PROTECTED_BRANCHES: 'development,releases/*' });
  f.calls.filter(paneMaker).forEach((c, i) => assert.deepEqual(c.args.slice(-6), [...ROLE_ENV[i]!, ...ENV], c.args.join(' ')));
  assert.ok(f.calls.filter((c) => !paneMaker(c)).every((c) => !c.args.includes('--env')), 'only the calls that make a pane');
});

test('protected branches: a squad without them, or with an empty list, passes no CB_PROTECTED_BRANCHES; CB_ROLE and CB_AGENT always (#3746, #4002)', () => {
  for (const s of [wsSquad, { ...wsSquad, protected: [] }]) {
    const { f, launch } = launchFour(s);
    assert.deepEqual(launch('demo-B1@macbook').env, { CB_ROLE: 'builder', CB_AGENT: 'claude' });
    f.calls.filter(paneMaker).forEach((c, i) => assert.deepEqual(c.args.slice(-4), ROLE_ENV[i], c.args.join(' ')));
    assert.ok(f.calls.every((c) => !c.args.some((a) => a.startsWith('CB_PROTECTED_BRANCHES'))));
    assert.ok(f.calls.filter((c) => !paneMaker(c)).every((c) => !c.args.includes('--env')), 'only the calls that make a pane');
  }
});

test('squad up: the saved squad\'s protected list reaches every pane it makes (#3746)', async () => {
  const f = fake((c) => {
    if (c.args[0] === 'agent' && c.args[1] === 'list') return { status: 0, stdout: '{"agents":[]}', stderr: '' };
    if (c.args[0] === 'agent' && c.args[1] === 'get') return GONE;
    if (c.args[0] === 'tab' || c.args[1] === 'split') return paneOut('p1');
  });
  const out = await squadUp('demo', false, async (fn: string) => (fn === 'squad_get' ? { ...squad, protected: ['development', 'releases/*'] } : []), f.run);
  const made = f.calls.filter(paneMaker);
  assert.ok(made.length >= 2 && made.some((c) => c.args[1] === 'split'), out);
  for (const c of made) assert.deepEqual(c.args.slice(-2), ENV, c.args.join(' '));
});

// ---- the agent-neutral core (#4002): a squad seat names its agent; only agents with an adapter start ----
test('launchFor sets CB_ROLE and CB_AGENT and defaults missing agent to claude', () => {
  for (const w of wantList('demo', squad)) {
    const l = launchFor('demo', squad, w);
    assert.equal(l.agent, 'claude', w.name);
    assert.deepEqual(l.env, { CB_ROLE: w.role, CB_AGENT: 'claude' }, w.name);
    assert.equal(l.board, squad.machines[l.machine as 'shaltoot' | 'macbook'].board, w.name);
    assert.ok(!l.prompt.includes('--agent'), l.prompt);
    assert.ok(!('fallback' in l), w.name);
  }
});

// synthetic: cb.squad_set refuses a non-Claude primary seat in phase 1, so this squad never comes from the board
const MIXED: any = { ...squad, roles: { ...squad.roles,
  builder: { count: 3, model: 'sonnet', machine: 'macbook', fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }],
    seats: { '2': { model: 'opus' }, '3': { agent: 'codex', model: 'gpt-6.1-sol', fallback: [{ agent: 'opencode', model: 'anthropic/claude-opus-5-5' }] } } },
  owner: { model: 'sonnet', machine: 'macbook', seats: { claims: { agent: 'agy', model: 'gemini-4-neon-xhigh' } } } } };
const mixedWant = (n: string) => wantList('demo', MIXED).find((w) => w.name === n)!;

test('seatSpec resolves per-seat overrides and non-Claude prompt includes --agent', () => {
  const codexFb = [{ agent: 'codex', model: 'gpt-6.1-sol' }];
  // no seat: the role's agent, model and fallback
  assert.deepEqual(seatSpec(MIXED, mixedWant('demo-B1@macbook')), { agent: 'claude', model: 'sonnet', fallback: codexFb });
  // a seat's model overrides; with no fallback of its own it keeps the role's
  assert.deepEqual(seatSpec(MIXED, mixedWant('demo-B2@macbook')), { agent: 'claude', model: 'opus', fallback: codexFb });
  // a seat's agent and model override; its own fallback replaces the role's
  assert.deepEqual(seatSpec(MIXED, mixedWant('demo-B3@macbook')), { agent: 'codex', model: 'gpt-6.1-sol', fallback: [{ agent: 'opencode', model: 'anthropic/claude-opus-5-5' }] });
  // a role with no fallback gives none; an owner's seat is its area
  assert.deepEqual(seatSpec(MIXED, mixedWant('demo-R1@macbook')), { agent: 'claude', model: 'opus' });
  assert.deepEqual(seatSpec(MIXED, mixedWant('demo-O-claims@macbook')), { agent: 'agy', model: 'gemini-4-neon-xhigh' });

  const b3 = launchFor('demo', MIXED, mixedWant('demo-B3@macbook'));
  assert.equal(b3.agent, 'codex');
  assert.equal(b3.model, 'gpt-6.1-sol');
  assert.deepEqual(b3.fallback, [{ agent: 'opencode', model: 'anthropic/claude-opus-5-5' }]);
  assert.deepEqual(b3.env, { CB_ROLE: 'builder', CB_AGENT: 'codex' });
  assert.equal(b3.prompt, 'cb iam demo-B3@macbook demo --role builder --model gpt-6.1-sol --agent codex, then cb role builder, then cb next');
  // a Claude seat's override changes its model only: the prompt has no --agent
  assert.equal(launchFor('demo', MIXED, mixedWant('demo-B2@macbook'), 'resume').prompt, 'cb iam demo-B2@macbook demo --role builder --model opus, then cb role builder, then cb resume');
  assert.equal(launchFor('demo', MIXED, mixedWant('demo-O-claims@macbook')).prompt,
    'cb iam demo-O-claims@macbook demo --role owner --area claims --model gemini-4-neon-xhigh --agent agy, then cb role owner, then cb next');

  // with repos, a builder's seat is <repo>:<n>, the home repo's too: a bare number names no seat there
  const q = structuredClone(ZED);
  q.roles.builder.seats = { 'api:2': { model: 'opus' }, 'dashboard:1': { model: 'haiku' }, '1': { model: 'fable' } };
  const qw = (n: string) => wantList('zed', q).find((w) => w.name === n)!;
  assert.equal(seatSpec(q, qw('zed-B1@macbook')).model, 'sonnet');
  assert.equal(seatSpec(q, qw('zed-B2@macbook')).model, 'opus');
  assert.equal(seatSpec(q, qw('zed-dashboard-B1@macbook')).model, 'haiku');
});

test('squad up --dry-run names a non-Claude seat agent/model; a Claude seat as before', async () => {
  const out = await squadUp('demo', true, async (fn: string) => (fn === 'squad_get' ? MIXED : []), fake((c) => (c.args[1] === 'get' ? GONE : undefined)).run);
  assert.match(out, /^start demo-B3@macbook \(builder, codex\/gpt-6\.1-sol\) on macbook$/m);
  assert.match(out, /^start demo-B2@macbook \(builder, opus\) on macbook$/m);
  assert.match(out, /^start demo-B1@macbook \(builder, sonnet\) on macbook$/m);
});

test('startOne refuses an unimplemented agent before creating a pane', () => {
  const b3 = launchFor('demo', MIXED, mixedWant('demo-B3@macbook'));
  const each: Record<string, { pane: string; panes: number }>[] = [{}, { macbook: { pane: 'w4:p1', panes: 1 } }];
  for (const tabs of each) { // a new tab, or a split of this run's tab
    const f = fake((c) => (c.args[0] === 'tab' || c.args[1] === 'split' ? paneOut('p1') : undefined));
    const r = startOne(b3, f.run, tabs);
    assert.equal(r.ok, false);
    assert.equal(r.line, 'failed demo-B3@macbook: agent "codex" is not installed yet (phase 1 supports claude only)');
    assert.equal(r.pane, undefined);
    assert.deepEqual(f.calls, [], 'no herdr call: no pane, never a Claude start in its place');
  }
  const f = fake(() => undefined);
  assert.match(startOne({ ...b3, agent: 'grok' as any }, f.run, {}).line, /^failed demo-B3@macbook: unknown agent "grok"$/);
  assert.equal(f.calls.length, 0);
});

test('squad up starts the Claude seats and refuses the codex one without touching a pane for it', async () => {
  const f = fake((c) => (c.args[1] === 'get' ? GONE : c.args[0] === 'tab' || c.args[1] === 'split' ? paneOut('p1') : undefined));
  const out = await squadUp('demo', false, async (fn: string) => (fn === 'squad_get' ? MIXED : []), f.run);
  assert.match(out, /^failed demo-B3@macbook: agent "codex" is not installed yet/m);
  assert.match(out, /^started demo-B2@macbook$/m);
  assert.ok(f.calls.filter((c) => c.args.includes('demo-b3-macbook')).every((c) => c.args[1] === 'get'), 'only herdr agent get for the codex seat');
  assert.ok(!f.calls.some((c) => c.args.includes('demo-B3@macbook')), 'no tab labelled for it');
  const b2 = f.calls.find((c) => c.args[1] === 'start' && c.args[2] === 'demo-b2-macbook')!;
  assert.deepEqual(b2.args.slice(b2.args.indexOf('--')), ['--', '--model', 'opus', '--permission-mode', 'bypassPermissions', '--settings', '/Users/me/board/kit/permissions/builder.json',
    '--strict-mcp-config', '--mcp-config', '/Users/me/board/kit/mcp/none.json']);
});

test('squadShow: Claude roles exactly as before; another agent in brackets, a fallback and seat overrides when there', () => {
  const plain = { roles: { lead: { count: 1, model: 'opus', machine: 'shaltoot' }, builder: { count: 2, model: 'sonnet', machine: 'macbook' } }, areas: [] };
  assert.equal(squadShow(plain), 'lead  1 × opus on shaltoot\nbuilder  2 × sonnet on macbook\nareas: none');
  const odd = { roles: {
    builder: { count: 2, model: 'gpt-6.1-sol', machine: 'macbook', agent: 'codex', fallback: [{ agent: 'claude', model: 'sonnet' }, { agent: 'opencode', model: 'anthropic/claude-opus-5-5' }],
      seats: { '2': { agent: 'claude', model: 'opus' } } },
    reviewer: { count: 1, model: 'opus', machine: 'macbook', seats: { '1': { fallback: [{ agent: 'agy', model: 'gemini-4-neon-xhigh' }] } } } }, areas: ['claims'] };
  assert.equal(squadShow(odd), [
    'builder  2 × gpt-6.1-sol (codex) on macbook; fallback sonnet (claude), anthropic/claude-opus-5-5 (opencode)',
    '  seat 2: opus (claude)',
    'reviewer  1 × opus on macbook',
    '  seat 1: opus; fallback gemini-4-neon-xhigh (agy)',
    'areas: claims'].join('\n'));
});
