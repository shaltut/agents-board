// #4786: the model a seat really runs, read from the agent itself. Pure: no database, no agent CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgyAdapter } from '../cli/agents/agy.ts';
import { getAdapter } from '../cli/agents/index.ts';
import { readRunningModel } from '../cli/relay-seat.ts';
import { modelDrift } from '../cli/squad-show.ts';

const agy = createAgyAdapter((() => ({ status: 0 })) as any);
// the shape of the footer as it was reported from an agy seat: mode, the model's display name, the effort
const screen = (footer: string) => `some output\n\n> \n\n  ${footer}\n\n`;

test("agy: the footer's model reads as the id 'agy models' prints for that name and effort", () => {
  assert.equal(agy.runningModel!(screen('auto · Gemini 4 Neon · high')), 'gemini-4-neon-high');
  assert.equal(agy.runningModel!(screen('auto · Claude Opus 5.5 · medium')), 'claude-opus-5-5-medium');
  assert.equal(agy.runningModel!('auto · Gemini 4 Neon · high\r\n'), 'gemini-4-neon-high');
});

test('agy: anything else on the screen is no reading, never a wrong one', () => {
  for (const s of ['', 'working...', screen('auto · Gemini 4 Neon'), screen('auto · Gemini 4 Neon · turbo'), screen('auto · Gemini 4 Neon · high · 12% context'),
    screen('auto · $(whoami) · high'), screen(`auto · ${'x'.repeat(200)} · high`), screen('the footer said auto · Gemini 4 Neon · high yesterday.'),
    // only the screen's last lines are the footer: the same text higher up is the agent's own output
    'auto · Gemini 4 Neon · high\none\ntwo\nthree\n']) assert.equal(agy.runningModel!(s), null, JSON.stringify(s.slice(0, 80)));
});

test('agy: a long screen is read in linear time', () => {
  const at = Date.now();
  agy.runningModel!(`auto · ${'A '.repeat(100000)}`);
  agy.runningModel!('a · '.repeat(100000));
  assert.ok(Date.now() - at < 1000);
});

test("only an agent whose screen names its model is read: Claude's comes from its usage hook", () => {
  assert.equal(getAdapter('claude').runningModel, undefined);
});

test("the relay saves what the adapter reads on the visible screen, and nothing else of the screen", async () => {
  const saved: string[] = [], reads: string[][] = [];
  const read = (args: string[]) => { reads.push(args); return { status: 0, stdout: screen('auto · Gemini 4 Neon · high') }; };
  const save = async (m: string) => { saved.push(m); };
  await readRunningModel({ adapter: agy, pane: 'w1:p2', read, save });
  assert.deepEqual(reads, [['pane', 'read', 'w1:p2', '--source', 'visible', '--format', 'text']]);
  assert.deepEqual(saved, ['gemini-4-neon-high']);
  // a failed read, a screen with no footer, a read that throws and an agent with no reader save nothing
  await readRunningModel({ adapter: agy, pane: 'w1:p2', read: () => ({ status: 1, stdout: screen('auto · Gemini 4 Neon · high') }), save });
  await readRunningModel({ adapter: agy, pane: 'w1:p2', read: () => ({ status: 0, stdout: 'busy' }), save });
  await readRunningModel({ adapter: agy, pane: 'w1:p2', read: () => { throw new Error('no herdr'); }, save });
  await readRunningModel({ adapter: { }, pane: 'w1:p2', read: () => { throw new Error('must not be read'); }, save });
  assert.deepEqual(saved, ['gemini-4-neon-high']);
});

test('cb sessions names both models only when the board says they differ', () => {
  assert.equal(modelDrift({ model: 'claude-opus-5-5-high', running_model: 'gemini-4-neon-high', model_differs: true }),
    '  ⚠ model: started on claude-opus-5-5-high, now runs gemini-4-neon-high');
  assert.equal(modelDrift({ model: 'sonnet', running_model: 'claude-sonnet-5-5', model_differs: false }), null);
  assert.equal(modelDrift({ model: null, running_model: null }), null);
});
