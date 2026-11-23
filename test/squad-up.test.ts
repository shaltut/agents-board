import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSquad, classifyAgentGet } from '../cli/squad-up.ts';

const mach = (herdr: string | null, board: string) => ({ herdr, repo: '~/Work/demo', board });
const squad = {
  machines: { shaltoot: mach(null, 'C:/b'), macbook: mach('macbook', '~/board') },
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
  assert.equal(b.cwd, '~/Work/demo');
  assert.equal(b.settings, '~/board/kit/permissions/builder.json');
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
