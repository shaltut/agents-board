// #4630: the relay's copy of held notices outlives the relay (a seat file the next relay in the pane reads), every copy
// is kept until its session binds (a second session change keeps the first), and none is pushed once older than the
// hold window. Pure: no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCopies, sortOrphans, writeCopies, type HeldCopy } from '../cli/held-copy.ts';
import { HOLD_MS } from '../cli/notice-hold.ts';

const SEAT = 'w1:p3@pc';
const copy = (o: Partial<HeldCopy>): HeldCopy =>
  ({ actor: 'W1@pc', project: 'demo', sid: 'S1', messages: [{ id: 1 }], broadcasts: [], memory: [], at: 1_000_000, ...o });

test('sortOrphans: bound under the same name: pushed; another name: dropped; still unbound: kept; same session: the board has it', () => {
  const now = 1_000_000 + 60_000;
  assert.deepEqual(sortOrphans([copy({})], { actor: 'W1@pc' }, 'S2', SEAT, now), { push: [copy({})], keep: [], dropped: 0, expired: 0 });
  assert.deepEqual(sortOrphans([copy({})], { actor: 'R1@pc' }, 'S2', SEAT, now), { push: [], keep: [], dropped: 1, expired: 0 });
  for (const actor of [SEAT, 'session-0123abcd'])
    assert.deepEqual(sortOrphans([copy({})], { actor }, 'S2', SEAT, now), { push: [], keep: [copy({})], dropped: 0, expired: 0 }, actor);
  assert.deepEqual(sortOrphans([copy({})], { actor: 'W1@pc' }, 'S1', SEAT, now), { push: [], keep: [], dropped: 0, expired: 0 });
});

test('sortOrphans (review 78 N3): two session changes before a bind keep both copies; each goes to its own name', () => {
  const a = copy({ actor: 'W1@pc', sid: 'S1', messages: [{ id: 1 }] }), b = copy({ actor: SEAT, sid: 'S2', messages: [{ id: 2 }] });
  const r = sortOrphans([a, b], { actor: 'W1@pc' }, 'S3', SEAT, 1_000_000);
  assert.deepEqual(r.push, [a]);
  assert.equal(r.dropped, 1, 'the unbound session\'s copy names nobody: the new name is not it');
});

test('sortOrphans (review 78 N2): a copy older than the hold window is never pushed, and is counted', () => {
  const old = copy({ at: 0 });
  assert.deepEqual(sortOrphans([old], { actor: 'W1@pc' }, 'S2', SEAT, HOLD_MS + 1), { push: [], keep: [], dropped: 0, expired: 1 });
  assert.deepEqual(sortOrphans([old], { actor: 'W1@pc' }, 'S2', SEAT, HOLD_MS).push, [old], 'at the edge it still goes');
});

test('writeCopies and readCopies: the next relay finds the copies once, without the expired ones; a bad file is nothing', () => {
  const f = join(tmpdir(), `cb-held-copy-test-${process.pid}.held`);
  try {
    writeCopies(f, [copy({ at: 5_000 }), copy({ at: 0, sid: 'S0' })]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'the notices are the seat\'s: owner only');
    assert.deepEqual(readCopies(f, HOLD_MS + 1_000), [copy({ at: 5_000 })]);
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
