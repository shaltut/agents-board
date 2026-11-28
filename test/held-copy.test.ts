// #4630: the relay's copy of held notices outlives the relay (a seat file the next relay in the pane reads), every copy
// is kept until its session binds (a second session change keeps the first), and none is pushed once older than the
// hold window. Pure: no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAME_SESSION_MS, copyCount, readCopies, sortOrphans, sweepHeld, writeCopies, type HeldCopy } from '../cli/held-copy.ts';
import { HOLD_MS, holdStep } from '../cli/notice-hold.ts';

const SEAT = 'w1:p3@pc';
const copy = (o: Partial<HeldCopy>): HeldCopy =>
  ({ actor: 'W1@pc', project: 'demo', sid: 'S1', messages: [{ id: 1 }], broadcasts: [], memory: [], at: 1_000_000, ...o });

test('sortOrphans, another session: bound under the same name: pushed; another name: dropped; still unbound: kept', () => {
  const now = 1_000_000 + 60_000;
  assert.deepEqual(sortOrphans([copy({})], { actor: 'W1@pc' }, 'S2', SEAT, now), { push: [copy({})], keep: [], mine: [], dropped: 0, expired: 0 });
  assert.deepEqual(sortOrphans([copy({})], { actor: 'R1@pc' }, 'S2', SEAT, now), { push: [], keep: [], mine: [], dropped: 1, expired: 0 });
  for (const actor of [SEAT, 'session-0123abcd'])
    assert.deepEqual(sortOrphans([copy({})], { actor }, 'S2', SEAT, now), { push: [], keep: [copy({})], mine: [], dropped: 0, expired: 0 }, actor);
});

// PR 165 review HIGH 1: the same session's relay restarted. The board kept the row, so it returns the held messages,
// but a card line only while the card is still the seat's: the copy's may be the only one left
test('sortOrphans, the same session: its own copy for the same name and project; a rebind meanwhile pushes it', () => {
  for (const sid of ['S1', null]) {
    const c = copy({ sid, events: [{ id: 7 }] });
    const at = (actor: string, project: string, ms: number) => sortOrphans([c], { actor, project }, sid, SEAT, 1_000_000 + ms);
    assert.deepEqual(at('W1@pc', 'demo', 60_000), { push: [], keep: [], mine: [c], dropped: 0, expired: 0 }, String(sid));
    // a "closed" notice waits for a push however long that is: the hold window is not its limit, the board's day is
    assert.deepEqual(at('W1@pc', 'demo', HOLD_MS + 1).mine, [c]);
    assert.deepEqual(at('W1@pc', 'demo', SAME_SESSION_MS + 1), { push: [], keep: [], mine: [], dropped: 0, expired: 2 });
    for (const [actor, project] of [['R1@pc', 'demo'], ['W1@pc', 'other']] as const)
      assert.deepEqual(at(actor, project, 60_000), { push: [c], keep: [], mine: [], dropped: 0, expired: 0 }, `${actor} ${project}`);
  }
});

test('sortOrphans (review 78 N3): two session changes before a bind keep both copies; each goes to its own name', () => {
  const a = copy({ actor: 'W1@pc', sid: 'S1', messages: [{ id: 1 }] }), b = copy({ actor: SEAT, sid: 'S2', messages: [{ id: 2 }] });
  const r = sortOrphans([a, b], { actor: 'W1@pc' }, 'S3', SEAT, 1_000_000);
  assert.deepEqual(r.push, [a]);
  assert.equal(r.dropped, 1, 'the unbound session\'s copy names nobody: the new name is not it');
});

test('sortOrphans (review 78 N2): a copy older than the hold window is never pushed, and is counted', () => {
  const old = copy({ at: 0 });
  assert.deepEqual(sortOrphans([old], { actor: 'W1@pc' }, 'S2', SEAT, HOLD_MS + 1), { push: [], keep: [], mine: [], dropped: 0, expired: 1 });
  assert.deepEqual(sortOrphans([old], { actor: 'W1@pc' }, 'S2', SEAT, HOLD_MS).push, [old], 'at the edge it still goes');
});

test('writeCopies and readCopies: the next relay finds the copies once, without the expired ones; a bad file is nothing', () => {
  const f = join(tmpdir(), `cb-held-copy-test-${process.pid}.held`);
  try {
    writeCopies(f, [copy({ at: 5_000 }), copy({ at: 0, sid: 'S0' })]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'the notices are the seat\'s: owner only');
    assert.deepEqual(readCopies(f, SAME_SESSION_MS + 1_000), [copy({ at: 5_000 })], 'no relay can use one older than a day');
    assert.equal(fs.existsSync(f), false, 'read once: the file goes');
    assert.deepEqual(readCopies(f, 0), []);
    writeCopies(f, []);
    assert.equal(fs.existsSync(f), false, 'nothing to keep: no file');
    fs.writeFileSync(f, '{not json');
    assert.deepEqual(readCopies(f, 0), []);
    fs.writeFileSync(f, JSON.stringify([{ actor: 7 }]));
    assert.deepEqual(readCopies(f, 0), [], 'a copy of the wrong shape is skipped');
  } finally { fs.rmSync(f, { force: true }); }
});

// PR 106 review N2-a: a copy's age counts from when its oldest line on a clock was first held (holdStep's since), never
// from the last held read, which the 30 s poll keeps renewing.
test('a copy ages from the first held read, however often the hold is read again', () => {
  const seen = new Map<string, number>(), i = { hold: null, messages: [{ id: 1, actor: 'runner', urgent: false }] };
  holdStep(i, [], { seen, now: 0, fresh: true });
  const at = holdStep(i, [], { seen, now: 9.5 * 60_000, fresh: false }).since;
  assert.equal(at, 0);
  // a new session binds the same name at 19 min: too old to push
  assert.deepEqual(sortOrphans([copy({ at })], { actor: 'W1@pc' }, 'S2', SEAT, 19 * 60_000), { push: [], keep: [], mine: [], dropped: 0, expired: 1 });
});

// #3221 settle window: card lines are held too, and the board returns them only while the card is still the seat's
test('a copy keeps its card lines through the file and counts them; a copy from before them still reads', () => {
  const withEvents = copy({ at: 5_000, events: [{ id: 7, kind: 'note' }] });
  assert.equal(copyCount([withEvents]), 2);
  assert.equal(copyCount([copy({})]), 1);
  const f = join(tmpdir(), `cb-held-events-test-${process.pid}.held`);
  try {
    writeCopies(f, [withEvents, copy({ at: 5_000, sid: 'S0' })]);
    assert.deepEqual(readCopies(f, 6_000), [withEvents, copy({ at: 5_000, sid: 'S0' })]);
    fs.writeFileSync(f, JSON.stringify([{ ...withEvents, events: 'x' }]));
    assert.deepEqual(readCopies(f, 6_000), [], 'a copy whose card lines are not a list is skipped');
  } finally { fs.rmSync(f, { force: true }); }
});

// PR 106 review L2: a pane that never gets another relay (herdr never reuses a pane id) leaves its held file behind
// PR 165 review: the same session's copy is good for a day (above), so another pane's relay starting must not remove
// it sooner: its own relay may be down longer than the hold window
test('sweepHeld: removes held files too old for any relay to use, keeps younger ones and other files', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cb-sweep-'));
  try {
    const ages: Record<string, number> = { 'cb-relay-old.held': SAME_SESSION_MS + 60_000, 'cb-relay-down.held': HOLD_MS + 60_000,
      'cb-relay-new.held': 0, 'cb-relay-old.log': SAME_SESSION_MS + 60_000 };
    for (const [f, age] of Object.entries(ages)) {
      fs.writeFileSync(join(dir, f), '[]');
      const then = new Date(Date.now() - age);
      fs.utimesSync(join(dir, f), then, then);
    }
    sweepHeld(dir, Date.now());
    assert.deepEqual(fs.readdirSync(dir).sort(), ['cb-relay-down.held', 'cb-relay-new.held', 'cb-relay-old.log']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
