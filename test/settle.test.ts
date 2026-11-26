// #4336: the lead creates a card in Next and assigns it a few seconds later (90 of 189 assigned cards in 3 days). An
// idle builder's relay, woken by the create's notify, offered it in that gap; the builder then found it someone else's.
// The relay now holds a Next offer until it has settled, and re-checks it just before pushing. Pure: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerSettled, settleWork } from '../cli/settle.ts';

const card = (id: number) => ({ id, title: `card ${id}`, priority: 'P2' });

test('a Next offer is held until it has settled, then offered once', () => {
  const pending = new Map();
  let r = settleWork(pending, [card(1)], 1_000, 8_000);
  assert.deepEqual(r.due, []);
  assert.equal(r.wait, 8_000);
  r = settleWork(pending, [card(1)], 5_000, 8_000); // offered again by the next poll: still the first sighting's clock
  assert.deepEqual(r.due, []);
  assert.equal(r.wait, 4_000);
  r = settleWork(pending, [], 9_000, 8_000); // the inbox no longer lists it (its event is behind `after`): still due
  assert.deepEqual(r.due.map((t) => t.id), [1]);
  assert.equal(r.wait, null);
  assert.deepEqual(settleWork(pending, [], 20_000, 8_000).due, [], 'offered once');
});

test('offers settle each on their own clock; the wait is the soonest', () => {
  const pending = new Map();
  settleWork(pending, [card(1)], 0, 8_000);
  let r = settleWork(pending, [card(2)], 6_000, 8_000);
  assert.equal(r.wait, 2_000);
  r = settleWork(pending, [], 8_000, 8_000);
  assert.deepEqual(r.due.map((t) => t.id), [1]);
  assert.equal(r.wait, 6_000);
  assert.deepEqual(settleWork(pending, [], 14_000, 8_000).due.map((t) => t.id), [2]);
});

// review I3: the wiring, with the board's re-check injected
test('offerSettled: create-then-assign inside the window pushes nothing; a card still open is pushed once', async () => {
  const pending = new Map();
  const board = new Map([[1, 'free'], [2, 'free']]); // id -> free | taken
  const stillOpen = async (ids: number[]) => ids.filter((id) => board.get(id) === 'free');
  const step = (offered: any[], now: number) => offerSettled({ pending, offered, now, settleMs: 8_000, actor: 'W1', stillOpen, log: () => {} });
  let r = await step([card(1), card(2)], 0); // the lead created both in Next
  assert.deepEqual(r.work, []);
  assert.equal(r.wait, 8_000);
  board.set(2, 'taken'); // ...and assigned #2 five seconds later
  r = await step([], 8_000);
  assert.deepEqual(r.work.map((t) => t.id), [1]);
  assert.deepEqual((await step([], 30_000)).work, [], 'once');
});

test('offerSettled: a failing re-check offers what is due unchecked and says so; an unbound seat settles nothing', async () => {
  const lines: string[] = [];
  const pending = new Map();
  const failing = async () => { throw new Error('function cb.work_still_open does not exist'); };
  await offerSettled({ pending, offered: [card(5)], now: 0, settleMs: 8_000, actor: 'W1', stillOpen: failing, log: (l) => lines.push(l) });
  const r = await offerSettled({ pending, offered: [], now: 8_000, settleMs: 8_000, actor: 'W1', stillOpen: failing, log: (l) => lines.push(l) });
  assert.deepEqual(r.work.map((t) => t.id), [5]);
  assert.match(lines.join('\n'), /re-check failed \(offered unchecked\): function cb\.work_still_open does not exist/);
  // no actor: nothing settles or is used up, so the offer is still there once the seat binds
  const p2 = new Map();
  assert.deepEqual(await offerSettled({ pending: p2, offered: [card(6)], now: 0, settleMs: 8_000, actor: null, stillOpen: async (i) => i, log: () => {} }), { work: [], wait: null });
  assert.equal(p2.size, 0);
});
