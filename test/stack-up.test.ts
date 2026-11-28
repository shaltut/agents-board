// #4710: a runner's DB test stacks start spaced apart, and a stack-up that failed only on an unhealthy container is
// taken down and run once more. A fake clock and fake steps: no board, no docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STACK_UNHEALTHY, stackGate, stackUp } from '../cli/runner-job.ts';
import { boardStackGap, STACK_GAP_S } from '../cli/runner-board.ts';

const never = new AbortController().signal;

test('stackGate: DB jobs claimed together start their stacks one gap apart; a later one waits only what is left', async () => {
  let t = 0;
  const waits: number[] = [];
  const turn = stackGate(30_000, () => t, async (ms) => { waits.push(ms); });
  // 9 lanes claimed in the same second after a restart (27 Nov 20:02): 0, 30, 60 ... 240 s
  assert.deepEqual(await Promise.all(Array.from({ length: 9 }, () => turn(never))), [0, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000, 210_000, 240_000]);
  assert.deepEqual(waits, [30_000, 60_000, 90_000, 120_000, 150_000, 180_000, 210_000, 240_000]);
  // long after the last one: no wait
  t = 600_000;
  assert.equal(await turn(never), 0);
  // 8 s later (27 Nov 20:21: two started 8 s apart, both died): the rest of the gap
  t = 608_000;
  assert.equal(await turn(never), 22_000);
  // a gap of 0 never waits
  const free = stackGate(0, () => 5, async () => { throw new Error('waited'); });
  assert.deepEqual([await free(never), await free(never)], [0, 0]);
});

test('stackGate: a cancelled job stops waiting for its turn at once', async () => {
  const turn = stackGate(3_600_000);
  await turn(never); // takes the first start, so the next waits an hour
  const stop = new AbortController();
  const began = Date.now();
  setTimeout(() => stop.abort(), 20);
  assert.ok(await turn(stop.signal) > 0);
  assert.ok(Date.now() - began < 5_000, 'the wait outlived the stop');
});

// a fake stack-up step: each call takes the next result
const fake = (...outs: { code: number | null; out: string; timedOut?: boolean; stopped?: boolean }[]) => {
  const calls: string[] = [];
  let stop = false;
  const up = async () => {
    calls.push('up');
    const o = outs.shift()!;
    return { r: { code: o.code, stopped: !!o.stopped, timedOut: !!o.timedOut, startFailed: false }, out: o.out };
  };
  return { calls, up, down: async () => { calls.push('down'); }, turn: async () => { calls.push('turn'); }, stopped: () => stop, stopNow: () => { stop = true; } };
};
const UNHEALTHY = 'dependency failed to start: container cb-runner-it-3-postgres-1 is unhealthy\nError: docker up exited 1';

test('stackUp: an unhealthy container takes the stack down, waits a turn and brings it up once more', async () => {
  assert.match(UNHEALTHY, STACK_UNHEALTHY);
  const f = fake({ code: 1, out: UNHEALTHY }, { code: 0, out: 'Claims integration stack provisioned and reachable.' });
  const s = await stackUp(f.up, f.down, f.turn, f.stopped);
  assert.deepEqual([s.r.code, s.retried], [0, true]);
  assert.deepEqual(f.calls, ['up', 'down', 'turn', 'up']);
});

test('stackUp: retried once only; a second unhealthy start fails the job', async () => {
  const f = fake({ code: 1, out: UNHEALTHY }, { code: 1, out: UNHEALTHY }, { code: 0, out: 'never reached' });
  const s = await stackUp(f.up, f.down, f.turn, f.stopped);
  assert.deepEqual([s.r.code, s.retried], [1, true]);
  assert.deepEqual(f.calls, ['up', 'down', 'turn', 'up']);
});

test('stackUp: a test or provisioning failure, a timeout, a pass or a stop is never run again', async () => {
  for (const o of [
    { code: 1, out: 'not ok 3 - claim routes to review\nfail 1' }, // a failure that is not the stack's health
    { code: 1, out: 'Error: pnpm exited 1' },
    { code: null, out: UNHEALTHY, timedOut: true },
    { code: null, out: UNHEALTHY, stopped: true },
    { code: 0, out: UNHEALTHY }, // a passing step is never retried, whatever it printed
  ]) {
    const f = fake(o, { code: 0, out: 'never reached' });
    const s = await stackUp(f.up, f.down, f.turn, f.stopped);
    assert.equal(s.retried, false, o.out);
    assert.deepEqual(f.calls, ['up'], o.out);
  }
});

test('stackUp: a job cancelled while its stack goes down is not brought up again', async () => {
  const f = fake({ code: 1, out: UNHEALTHY }, { code: 0, out: 'never reached' });
  const s = await stackUp(f.up, async () => { await f.down(); f.stopNow(); }, f.turn, f.stopped);
  assert.deepEqual([s.r.stopped, s.retried], [true, true]);
  assert.deepEqual(f.calls, ['up', 'down']);
});

test('boardStackGap: the board\'s setting when set, else 30 s; a board without the column, or any failure, keeps 30', async () => {
  const said: string[] = [];
  const sql = (row: unknown, code?: string) => Object.assign(async (s: TemplateStringsArray) => {
    assert.match(s.join('?'), /select stack_gap_set from cb\.runners/);
    if (code) throw Object.assign(new Error('x'), { code });
    return row === undefined ? [] : [row];
  }, { json: (x: unknown) => x });
  const gap = (row: unknown, code?: string) => boardStackGap(sql(row, code), 'pc', (m) => said.push(m));
  assert.equal(STACK_GAP_S, 30);
  assert.equal(await gap({ stack_gap_set: 45 }), 45);
  assert.equal(await gap({ stack_gap_set: 0 }), 0);
  assert.equal(await gap({ stack_gap_set: null }), 30);
  assert.equal(await gap(undefined), 30); // no row for this runner yet
  assert.equal(await gap({ stack_gap_set: 999 }), 30);
  assert.equal(said.length, 0);
  assert.equal(await gap(undefined, '42703'), 30); // a board older than the column: quietly the default
  assert.equal(said.length, 0);
  assert.equal(await gap(undefined, '08006'), 30);
  assert.match(said[0]!, /could not read the board's stack gap.*30 s/);
});
