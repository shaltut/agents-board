// #4261: a board query on a dropped connection can never settle. Awaited at the top level with nothing else pending,
// Node exits (code 13, "unsettled top-level await") instead of logging a failed tick and trying again. withDeadline
// turns "never" into a rejection, and its timer keeps the process alive meanwhile. Pure: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { withDeadline } from '../cli/deadline.ts';

test('withDeadline: a value in time passes through, a rejection stays itself, never becomes a named timeout', async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 1_000, 'tick'), 7);
  await assert.rejects(withDeadline(Promise.reject(new Error('board down')), 1_000, 'tick'), /^Error: board down$/);
  await assert.rejects(withDeadline(new Promise(() => {}), 50, 'the lock check'), /the lock check did not answer within 0\.05 s/);
});

test('a loop awaiting a promise that never settles logs it and goes on, instead of exiting with code 13', () => {
  const script = `
    import { withDeadline } from ${JSON.stringify(new URL('../cli/deadline.ts', import.meta.url).href)};
    for (let i = 0; i < 2; i++) {
      try { await withDeadline(new Promise(() => {}), 50, 'tick'); } catch (e) { console.log('tick failed: ' + e.message); }
    }
    console.log('still looping');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.match(/tick failed: tick did not answer/g)?.length, 2, r.stdout);
  assert.match(r.stdout, /still looping/);
  // the bug itself: the same loop without a deadline exits 13
  const bare = spawnSync(process.execPath, ['--input-type=module', '-e', 'await new Promise(() => {}); console.log("never")'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(bare.status, 13);
});
