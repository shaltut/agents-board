import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGES, GROUPS, digitView, headerPages, isOwner, navGroups, pageOf, parse, visiblePages, type View } from '../web/src/lib/route.ts';
import { CHORD_MS, chord } from '../web/src/lib/keys.ts';

const all = () => true; // every page treated as built, so the owner filter is what is tested
const admin = (name: string) => ({ role: 'admin' as const, user: { name } });

test('number keys keep the pages they had before the menus (#4528)', () => {
  const was: Record<string, View> = { 1: 'today', 2: 'board', 3: 'backlog', 4: 'sessions', 5: 'huddles', 6: 'history', 7: 'people', 8: 'epics', 9: 'memory', 0: 'goals' };
  const pages = visiblePages(false, all);
  for (const [key, view] of Object.entries(was)) assert.equal(digitView(key, pages), view, `key ${key}`);
  assert.equal(digitView('c', pages), undefined);
  assert.equal(PAGES.filter((p) => p.digit).length, 10, 'no page gained a digit');
});

test('every page has its own g letter and its own digit; every page is on the header or in a group', () => {
  const letters = PAGES.map((p) => p.g);
  assert.equal(new Set(letters).size, letters.length, 'g letters are unique');
  for (const g of letters) assert.match(g, /^[a-z]$/, 'g then a letter');
  const digits = PAGES.flatMap((p) => (p.digit ? [p.digit] : []));
  assert.equal(new Set(digits).size, digits.length, 'digits are unique');
  assert.deepEqual(headerPages(PAGES).map((p) => p.view), ['today', 'board']);
  assert.deepEqual(GROUPS.map((g) => g.label), ['Work', 'Team', 'Knowledge', 'Machines', 'Settings']);
  const inGroup = (id: string) => PAGES.filter((p) => p.group === id).map((p) => p.label);
  assert.deepEqual(inGroup('work'), ['Backlog', 'Goals', 'Epics']);
  assert.deepEqual(inGroup('team'), ['Sessions', 'Huddles', 'Users']);
  assert.deepEqual(inGroup('knowledge'), ['Memory', 'History']);
  assert.deepEqual(inGroup('machines'), ['Runners', 'Usage']);
  assert.deepEqual(inGroup('settings'), ['Project settings']);
});

test('owner: the PC screen and the admin ahmed; nobody else', () => {
  assert.equal(isOwner({ role: 'local' }), true);
  assert.equal(isOwner(admin('ahmed')), true);
  assert.equal(isOwner(admin('sam')), false);
  assert.equal(isOwner({ role: 'guest', user: { name: 'ahmed' } }), false);
  assert.equal(isOwner(undefined), false);
});

test('owner-only pages are hidden from another admin: menus, command menu and g keys all read this list', () => {
  const mine = visiblePages(true, all).map((p) => p.view);
  const theirs = visiblePages(false, all);
  assert.ok(mine.includes('usage') && mine.includes('settings'));
  assert.ok(!theirs.some((p) => p.view === 'usage' || p.view === 'settings'));
  assert.ok(theirs.some((p) => p.view === 'runners'), 'Runners is for every admin');
  assert.deepEqual(navGroups(theirs, 'board').find((g) => g.id === 'machines')?.pages.map((p) => p.view), ['runners']);
  assert.equal(navGroups(theirs, 'board').find((g) => g.id === 'settings'), undefined, 'an empty group is not drawn');
  assert.equal(chord(0, 'p', 100, theirs).view, undefined, 'g p does nothing for another admin');
  assert.equal(chord(0, 'p', 100, visiblePages(true, all)).view, 'settings');
});

test('a page with no screen yet stays out of the nav, and its route falls back to Today', () => {
  const built = new Set<View>(['today', 'board', 'backlog', 'sessions', 'huddles', 'history', 'people', 'epics', 'memory', 'goals']);
  const pages = visiblePages(true, (v) => built.has(v));
  assert.ok(!pages.some((p) => p.view === 'runners'));
  assert.deepEqual(navGroups(pages, 'board').map((g) => g.label), ['Work', 'Team', 'Knowledge']);
  assert.equal(parse('#/nope').view, 'today');
  assert.equal(parse('#/runners?p=x').view, 'runners'); // known view; App shows Today until its screen lands
});

test('the open page shows on its group button', () => {
  const pages = visiblePages(true, all);
  const groups = navGroups(pages, 'memory');
  assert.equal(groups.find((g) => g.id === 'knowledge')?.current?.label, 'Memory');
  assert.equal(groups.filter((g) => g.current).length, 1, 'only one group is active');
  assert.equal(navGroups(pages, 'today').filter((g) => g.current).length, 0, 'a header page leaves every group plain');
  assert.equal(pageOf('questions')?.view, 'today', 'the questions route is Today');
});

test('g then a letter: goes within the time, swallows the second key, resets on timeout and Esc', () => {
  const pages = visiblePages(false, all);
  const start = chord(null, 'g', 1000, pages);
  assert.deepEqual(start, { since: 1000, used: true });
  assert.deepEqual(chord(1000, 'm', 1000 + CHORD_MS, pages), { since: null, used: true, view: 'memory' });
  assert.deepEqual(chord(1000, 'g', 1500, pages), { since: null, used: true, view: 'goals' }, 'g g is Goals');
  assert.deepEqual(chord(1000, 'c', 1500, pages), { since: null, used: true }, 'g c is swallowed: no new task');
  assert.deepEqual(chord(1000, 'Escape', 1500, pages), { since: null, used: true });
  assert.deepEqual(chord(1000, 'm', 1001 + CHORD_MS, pages), { since: null, used: false }, 'too late: m is just m');
  assert.deepEqual(chord(1000, 'g', 1001 + CHORD_MS, pages), { since: 1001 + CHORD_MS, used: true }, 'too late g starts again');
  assert.deepEqual(chord(null, '3', 1000, pages), { since: null, used: false }, 'digits pass through');
});
