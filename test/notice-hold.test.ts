// #3221 (Ahmed, Q2996/Q2997, Q3128): the relay holds lines that can wait and delivers them in one push. Routine notices
// wait up to 10 minutes. Session lines (tells, card notices, bugs, Next offers) wait 120 s from the first of them. A
// "closed" card notice never wakes a seat by itself. Urgent lines go at once and take the held ones with them; whatever
// it cannot place goes at once. Pure: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_MS, SETTLE_WINDOW_MS, holdStep } from '../cli/notice-hold.ts';

const box = (o: any = {}) => ({ hold: null, messages: [], events: [], broadcasts: [], memory: [], answers: [], asks: [], sent_back: [],
  answer_copies: [], bugs: [], huddles: [], next_work: [], ...o });
const runner = (id: number, o: any = {}) => ({ id, actor: 'runner', summary: `job #${id} test: passed`, raw: false, notice: null, urgent: false, ...o });
const note = (o: any = {}) => ({ id: 50, kind: 'note', actor: 'orch', task_id: 1, urgent: false, ...o });
const tell = (id: number, o: any = {}) => ({ id, actor: 'orch', summary: 'take #19', raw: false, notice: null, urgent: false, ...o });
const clock = (now = 0, fresh = true) => ({ seen: new Map<string, number>(), now, fresh });
// one relay's reads in turn: the clock keeps when it first saw each line
const step = (c: ReturnType<typeof clock>, now: number, o: any) => { c.now = now; const r = holdStep(box(o), [], c); return [r.action, r.wait]; };

test('routine lines wait 10 minutes, session lines 120 s', () => assert.deepEqual([HOLD_MS, SETTLE_WINDOW_MS], [600_000, 120_000]));

test('a low item is held, then delivered when its window ends (the age is the board clock: a restart keeps it)', () => {
  assert.deepEqual(holdStep(box({ messages: [runner(1), runner(2)] }), [], clock()), { action: 'hold', held: 2, wait: HOLD_MS, since: 0 });
  assert.deepEqual(holdStep(box({ messages: [runner(1)], hold: { from: 7, age_ms: 240_000 } }), [], clock()), { action: 'hold', held: 1, wait: 360_000, since: -240_000 });
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
  assert.deepEqual(holdStep(lows, [], clock()), { action: 'hold', held: 6, wait: HOLD_MS, since: 0 });
});

test('anything urgent goes at once and takes the held items along', () => {
  const held = { messages: [runner(1)] };
  const urgent: Record<string, any> = {
    'a direct question, or a person\'s line (the board marks it)': { messages: [tell(9, { urgent: true })] },
    'the supervisor': { messages: [{ id: 9, actor: 'supervisor', summary: 'B1 waits on a dialog', urgent: false }] },
    'Ahmed typing': { typed: true },
    'an answer': { answers: [{ id: 1 }] },
    'an ask from Ahmed': { asks: [{ id: 1 }] },
    'a send-back': { sent_back: [{ id: 1 }] },
    'an answer copy': { answer_copies: [{ id: 1 }] },
    'a P0 bug to triage': { bugs: [{ event_id: 1, id: 1, priority: 'P0', actor: 'W1@pc' }] },
    'a huddle line': { huddles: [{ id: 1, actor: 'orch' }] },
    'a P0 Next offer': { next_work: [{ id: 3, priority: 'P0' }] },
    'an urgent digest (unmarked)': { messages: [{ id: 9, actor: 'board', notice: null }] },
    "Ahmed's broadcast": { broadcasts: [{ id: 9, actor: 'ahmed' }] },
    "Ahmed's memory change": { memory: [{ id: 9, actor: 'ahmed' }] },
    // a P0 card, a person's line, my card cancelled, blocked or taken off me (review M1): the board marks them
    'an urgent card line': { events: [note({ urgent: true })] },
    'an urgent closed notice': { events: [note({ kind: 'done', urgent: true })] },
    // review M3: a runner result or nudge about a P0 card (the inbox marks it urgent)
    "a P0 card's runner result": { messages: [runner(2, { urgent: true })] },
    'a nudge about a P0 card': { messages: [{ id: 9, actor: 'board', notice: 'nudge', urgent: true }] },
    // review M2: a part freed off me
    'a part freed off me': { messages: [{ id: 9, actor: 'board', notice: null, urgent: true }] },
    // review M4: GitHub lines by Ahmed's own login
    "Ahmed's GitHub line": { messages: [{ id: 9, actor: 'github', notice: null, urgent: true }] },
  };
  for (const [what, o] of Object.entries(urgent)) {
    const { typed, ...rest } = o;
    const r = holdStep(box({ ...held, ...rest, messages: [...held.messages, ...(rest.messages ?? [])], hold: { from: 7, age_ms: 1000 } }), typed ? ['run it'] : []);
    assert.equal(r.action, 'deliver', what);
  }
});

test('what it cannot place goes at once: an unknown sender, a missing field, a board without holds', () => {
  const cases: Record<string, any> = {
    'an unknown sender with no urgent field': box({ messages: [{ id: 1, actor: 'newbot', summary: 'x' }] }),
    'no sender': box({ messages: [{ id: 1, summary: 'x', urgent: false }] }),
    'a board message with no notice field (an older board)': box({ messages: [{ id: 1, actor: 'board', summary: 'Digest' }] }),
    'an unknown event kind': box({ events: [note({ kind: 'renamed' })] }),
    'a card line with no urgent field (a board before the settle window)': box({ events: [note({ urgent: undefined })] }),
    'a bug with no priority': box({ bugs: [{ event_id: 1, id: 1, actor: 'W1@pc' }] }),
    'a broadcast with no sender': box({ broadcasts: [{ id: 1 }] }),
    'a board that keeps no holds (no hold key)': (() => { const b: any = box({ messages: [runner(1)] }); delete b.hold; return b; })(),
  };
  for (const [what, i] of Object.entries(cases)) assert.equal(holdStep(i, []).action, 'deliver', what);
});

test('nothing to push: none, which also ends a hold whose items are gone', () => {
  assert.deepEqual(holdStep(box(), [], clock()), { action: 'none', held: 0, wait: null, since: 0 });
  assert.deepEqual(holdStep(box({ hold: { from: 7, age_ms: 10 } }), [], clock()), { action: 'none', held: 0, wait: null, since: 0 });
});

test('a tell, a card line, a bug and a Next offer wait one 120 s window, counted from the first of them', () => {
  const lines = {
    'a tell': { messages: [tell(9)] },
    'a note on my card': { events: [note()] },
    'a card created for me': { events: [note({ kind: 'task_created' })] },
    'a move or edit of my card': { events: [note({ kind: 'moved' })] },
    'a bug to triage': { bugs: [{ event_id: 1, id: 1, priority: 'P2', actor: 'W1@pc' }] },
    'a Next offer': { next_work: [{ id: 3, priority: 'P2' }] },
  };
  for (const [what, o] of Object.entries(lines)) assert.deepEqual(step(clock(), 0, o), ['hold', SETTLE_WINDOW_MS], what);
  const c = clock();
  assert.deepEqual(step(c, 0, { messages: [tell(9)] }), ['hold', 120_000]);
  assert.deepEqual(step(c, 50_000, { messages: [tell(9)], events: [note()] }), ['hold', 70_000], 'a later line does not restart it');
  assert.deepEqual(step(c, 120_000, { messages: [tell(9)], events: [note()] }), ['deliver', null]);
  assert.deepEqual(step(c, 130_000, { messages: [tell(10)] }), ['hold', 120_000], 'a delivery starts the next window afresh');
});

test('routine lines keep their 10 minutes and ride out with an earlier window', () => {
  const c = clock();
  assert.deepEqual(step(c, 0, { messages: [runner(1)] }), ['hold', HOLD_MS]);
  assert.deepEqual(step(c, 60_000, { messages: [runner(1), tell(9)] }), ['hold', 120_000]);
  assert.deepEqual(step(c, 180_000, { messages: [runner(1), tell(9)] }), ['deliver', null]);
  const late = clock();
  step(late, 0, { messages: [runner(1)] });
  assert.deepEqual(step(late, 570_000, { messages: [runner(1), tell(9)] }), ['hold', 30_000], 'the routine line is due first');
});

test('a "closed" card notice never wakes a seat by itself: it goes with the next push', () => {
  const closed = note({ kind: 'done' });
  const c = clock();
  assert.deepEqual(step(c, 0, { events: [closed] }), ['hold', null]);
  assert.deepEqual(step(c, 36_000_000, { events: [closed] }), ['hold', null], 'ten hours on, still no wake');
  assert.deepEqual(step(c, 36_000_000, { events: [closed], messages: [runner(1)] }), ['hold', HOLD_MS], 'a routine line keeps its own window');
  assert.deepEqual(step(c, 36_100_000, { events: [closed, note({ id: 51 })], messages: [runner(1)] }), ['hold', 120_000]);
  assert.deepEqual(step(c, 36_220_000, { events: [closed, note({ id: 51 })], messages: [runner(1)] }), ['deliver', null]);
});

test('a restarted relay dates what it first reads by the board\'s hold; later lines start their own window', () => {
  const c = clock(1_000_000);
  assert.deepEqual(step(c, 1_000_000, { messages: [tell(9)], hold: { from: 7, age_ms: 100_000 } }), ['hold', 20_000]);
  assert.deepEqual(step(c, 1_010_000, { messages: [tell(9), tell(10)], hold: { from: 7, age_ms: 110_000 } }), ['hold', 10_000]);
  const later = clock(1_000_000);
  step(later, 1_000_000, { events: [note({ kind: 'done' })], hold: { from: 7, age_ms: 100_000 } });
  assert.deepEqual(step(later, 1_010_000, { events: [note({ id: 60 })], hold: { from: 7, age_ms: 110_000 } }), ['hold', 120_000]);
});

test('since: when the oldest line that is on a clock was first seen (a copy of the hold ages from it)', () => {
  const closed = note({ kind: 'done' });
  const c = clock();
  c.now = 5_000; assert.equal(holdStep(box({ events: [closed] }), [], c).since, 5_000, 'only closed notices: now');
  c.now = 9_000; assert.equal(holdStep(box({ events: [closed], messages: [tell(9)] }), [], c).since, 9_000);
  c.now = 12_000; assert.equal(holdStep(box({ events: [closed], messages: [tell(9), runner(1)] }), [], c).since, 9_000);
  // PR 165 review LOW 2: with only closed notices left, a later poll does not make them newer
  const only = clock();
  only.now = 5_000; holdStep(box({ events: [closed] }), [], only);
  only.now = 40_000; assert.equal(holdStep(box({ events: [closed] }), [], only).since, 5_000);
});

// PR 165 review LOW 1: the inbox marks any person's line urgent, not the owner's alone; every list honours the mark
test("another person's broadcast, memory change and bug go at once", () => {
  const marked: Record<string, any> = {
    broadcast: { broadcasts: [{ id: 9, actor: 'cai', urgent: true }] },
    memory: { memory: [{ id: 9, actor: 'cai', urgent: true }] },
    bug: { bugs: [{ event_id: 9, id: 1, priority: 'P2', actor: 'cai', urgent: true }] },
  };
  for (const [what, o] of Object.entries(marked)) assert.equal(holdStep(box(o), [], clock()).action, 'deliver', what);
});
