import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSquad, classifyAgentGet, squadUp, herdrName, type Runner } from '../cli/squad-up.ts';

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
