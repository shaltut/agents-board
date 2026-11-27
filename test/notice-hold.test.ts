// #3221 (Ahmed, Q2996/Q2997): the relay holds routine notices up to 10 minutes and delivers them in one push; anything
// important goes at once and takes them along; whatever it cannot place goes at once. Pure: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_MS, holdStep } from '../cli/notice-hold.ts';

const box = (o: any = {}) => ({ hold: null, messages: [], events: [], broadcasts: [], memory: [], answers: [], asks: [], sent_back: [],
  answer_copies: [], bugs: [], huddles: [], next_work: [], ...o });
const runner = (id: number, o: any = {}) => ({ id, actor: 'runner', summary: `job #${id} test: passed`, raw: false, notice: null, urgent: false, ...o });
const note = (o: any = {}) => ({ id: 50, kind: 'note', actor: 'orch', task_id: 1, ...o });

test('the window is 10 minutes', () => assert.equal(HOLD_MS, 600_000));

test('a low item is held, then delivered when its window ends (the age is the board clock: a restart keeps it)', () => {
  assert.deepEqual(holdStep(box({ messages: [runner(1), runner(2)] }), []), { action: 'hold', low: 2, wait: HOLD_MS });
  assert.deepEqual(holdStep(box({ messages: [runner(1)], hold: { from: 7, age_ms: 240_000 } }), []), { action: 'hold', low: 1, wait: 360_000 });
  assert.equal(holdStep(box({ messages: [runner(1)], hold: { from: 7, age_ms: HOLD_MS } }), []).action, 'deliver');
  assert.equal(holdStep(box({ messages: [runner(1)], hold: { from: 7, age_ms: HOLD_MS + 5 } }), []).action, 'deliver');
});

test('every routine kind waits: runner, GitHub, digests and nudges, broadcasts and memory by anyone but Ahmed', () => {
  const lows = box({
    messages: [runner(1), { id: 2, actor: 'github', notice: null, urgent: false }, { id: 3, actor: 'board', notice: 'digest', urgent: false },
               { id: 4, actor: 'board', notice: 'nudge', urgent: false }],
    broadcasts: [{ id: 20, actor: 'orch', summary: 'hold uploads' }],
    memory: [{ id: 21, actor: 'W5@pc', action: 'add' }],
  });
  assert.deepEqual(holdStep(lows, []), { action: 'hold', low: 6, wait: HOLD_MS });
});

test('anything important goes at once and takes the held items along', () => {
  const held = { messages: [runner(1)] };
  const important: Record<string, any> = {
    'a teammate tell': { messages: [{ id: 9, actor: 'orch', summary: 'take #19' }] },
    'the supervisor': { messages: [{ id: 9, actor: 'supervisor', summary: 'B1 waits on a dialog' }] },
    'Ahmed typing': { typed: true },
    'an answer': { answers: [{ id: 1 }] },
    'an ask from Ahmed': { asks: [{ id: 1 }] },
    'a send-back': { sent_back: [{ id: 1 }] },
    'an answer copy': { answer_copies: [{ id: 1 }] },
    'a bug to triage': { bugs: [{ id: 1 }] },
    'a huddle line': { huddles: [{ id: 1, actor: 'orch' }] },
    'a Next offer': { next_work: [{ id: 3, priority: 'P2' }] },
    'an urgent digest (unmarked)': { messages: [{ id: 9, actor: 'board', notice: null }] },
    "Ahmed's broadcast": { broadcasts: [{ id: 9, actor: 'ahmed' }] },
    "Ahmed's memory change": { memory: [{ id: 9, actor: 'ahmed' }] },
    // review I1: a card event is never held (the board returns it only while the card is still mine)
    "a teammate's note on my card": { events: [note()] },
    // review M1: the lead cancelling or blocking my card
    'my card moved to cancelled by the lead': { events: [note({ kind: 'moved', summary: 'in_progress → cancelled' })] },
    'a card created for me': { events: [note({ kind: 'task_created' })] },
    // review M3: a runner result or nudge about a P0 card (the inbox marks it urgent)
    "a P0 card's runner result": { messages: [runner(2, { urgent: true })] },
    'a nudge about a P0 card': { messages: [{ id: 9, actor: 'board', notice: 'nudge', urgent: true }] },
    // review M2: a part freed off me
    'a part freed off me': { messages: [{ id: 9, actor: 'board', notice: null, urgent: true }] },
    // review M4: GitHub lines by Ahmed's own login
    "Ahmed's GitHub line": { messages: [{ id: 9, actor: 'github', notice: null, urgent: true }] },
  };
  for (const [what, o] of Object.entries(important)) {
    const { typed, ...rest } = o;
    const r = holdStep(box({ ...held, ...rest, messages: [...held.messages, ...(rest.messages ?? [])], hold: { from: 7, age_ms: 1000 } }), typed ? ['run it'] : []);
    assert.equal(r.action, 'deliver', what);
  }
});

test('what it cannot place goes at once: an unknown sender, a missing field, a board without holds', () => {
  const cases: Record<string, any> = {
    'an unknown sender': box({ messages: [{ id: 1, actor: 'newbot', summary: 'x' }] }),
    'no sender': box({ messages: [{ id: 1, summary: 'x' }] }),
    'a board message with no notice field (an older board)': box({ messages: [{ id: 1, actor: 'board', summary: 'Digest' }] }),
    'an unknown event kind': box({ events: [note({ kind: 'renamed' })] }),
    'a broadcast with no sender': box({ broadcasts: [{ id: 1 }] }),
    'a board that keeps no holds (no hold key)': (() => { const b: any = box({ messages: [runner(1)] }); delete b.hold; return b; })(),
  };
  for (const [what, i] of Object.entries(cases)) assert.equal(holdStep(i, []).action, 'deliver', what);
});

test('nothing to push: none, which also ends a hold whose items are gone', () => {
  assert.deepEqual(holdStep(box(), []), { action: 'none', low: 0, wait: null });
  assert.deepEqual(holdStep(box({ hold: { from: 7, age_ms: 10 } }), []), { action: 'none', low: 0, wait: null });
});
