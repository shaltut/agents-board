// Live updates re-fetch only what a change touched, at most once per gap, and never in a hidden tab (2026-11-18:
// one open board tab re-read ~12 endpoints every 2 s all afternoon). No database: pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keysFor, refresher, TABLE_KEYS } from '../web/src/lib/invalidate.ts';

const tables = (...t: string[]) => new Set(t);

test('every table that notifies is mapped: a new one fails here, not silently on the page', () => {
  const schema = readFileSync(join(import.meta.dirname, '..', 'db', 'schema.sql'), 'utf8');
  const notifying = [...schema.matchAll(/trigger \w+ after [a-z ]+ on cb\.(\w+)\s+for each statement execute function cb\.notify\(\)/g)].map((m) => m[1]);
  assert.ok(notifying.length >= 10, `found ${notifying.length} notifying tables`);
  for (const t of notifying) assert.ok(t in TABLE_KEYS, `cb.${t} notifies but invalidate.ts does not map it`);
});

test('a history line alone (a note, a message) leaves the board, goals and accounts alone', () => {
  const keys = keysFor(tables('events'));
  assert.ok(Array.isArray(keys));
  for (const k of ['events', 'today', 'task', 'huddle']) assert.ok(keys.includes(k), k);
  assert.ok(keys.includes('page'), 'a design page save (its history line) re-reads the open page');
  for (const k of ['tasks', 'goals', 'epics', 'projects', 'users', 'whoami', 'telegram', 'questions']) assert.ok(!keys.includes(k), k);
});

test('a card change re-fetches the lists that show cards; a question change, the question lists', () => {
  const card = keysFor(tables('tasks', 'events'));
  assert.ok(Array.isArray(card));
  for (const k of ['tasks', 'task', 'epics', 'epic', 'goals', 'goal', 'today', 'projects', 'me']) assert.ok(card.includes(k), k);
  assert.ok(!card.includes('users') && !card.includes('whoami'));
  assert.ok(card.includes('page'), 'a card change re-reads the open design page');
  const q = keysFor(tables('questions'));
  assert.ok(Array.isArray(q));
  for (const k of ['questions', 'me', 'task', 'projects']) assert.ok(q.includes(k), k);
});

test('a reconnect or a table nobody mapped re-fetches everything', () => {
  assert.equal(keysFor(tables('listen')), 'all');
  assert.equal(keysFor(tables('events', 'brand_new_table')), 'all');
});

test('refresher: a burst is one fetch; then at most one per gap; a hidden tab waits and catches up once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let hidden = false;
  const calls: (string[] | 'all')[] = [];
  const r = refresher({ invalidate: (k) => calls.push(k), hidden: () => hidden, gap: 2000, settle: 120 });

  r.change('tasks'); r.change('events');
  t.mock.timers.tick(119);
  assert.equal(calls.length, 0, 'waits for the burst to settle');
  t.mock.timers.tick(1);
  assert.equal(calls.length, 1);
  assert.ok(Array.isArray(calls[0]) && calls[0].includes('tasks') && calls[0].includes('events'), 'one fetch for both tables');

  r.change('questions'); // right after a fetch: held to the gap
  t.mock.timers.tick(1000);
  r.change('asks');
  t.mock.timers.tick(999);
  assert.equal(calls.length, 1, 'no second fetch inside the gap');
  t.mock.timers.tick(1);
  assert.equal(calls.length, 2);
  assert.ok(Array.isArray(calls[1]) && calls[1].includes('questions') && calls[1].includes('asks'));

  hidden = true;
  t.mock.timers.tick(5000);
  r.change('tasks'); r.change('memories');
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, 2, 'a hidden tab fetches nothing that does not ring');
  // ...but a new question still reaches it: the tab title and the ring are how Ahmed hears of one in the background
  r.change('questions');
  t.mock.timers.tick(2000); // within a gap (the mocked Date reads the end of a tick inside timers, so a whole gap)
  assert.equal(calls.length, 3);
  assert.deepEqual([...calls[2]].sort(), ['me', 'questions'], 'only what rings, while hidden');
  hidden = false;
  r.visible();
  t.mock.timers.tick(2000);
  assert.equal(calls.length, 4, 'one catch-up on return');
  assert.ok(Array.isArray(calls[3]) && ['tasks', 'memories', 'questions'].every((k) => (calls[3] as string[]).includes(k)));

  r.visible(); // back again with nothing pending: nothing to fetch
  t.mock.timers.tick(5000);
  assert.equal(calls.length, 4);
  r.stop();
});
