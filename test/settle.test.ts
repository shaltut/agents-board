// #4336: the lead creates a card in Next and assigns it a few seconds later (90 of 189 assigned cards in 3 days). An
// idle builder's relay, woken by the create's notify, offered it in that gap; the builder then found it someone else's.
// The relay now holds a Next offer until it has settled, and re-checks it just before pushing. Pure: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleWork } from '../cli/settle.ts';

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
