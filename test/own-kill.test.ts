// #4922: a test cleanup ends only what is still its own. A process number is free again once its process ends, and
// Windows soon gives it to another: on a PC that runs many jobs at once that can be another job's Postgres, a relay or
// the runner. No database. Every process here is one the test starts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { killChild, killMarked } from './own-kill.ts';

const MARK = `cb-own-kill-${randomBytes(6).toString('hex')}`;
const started: ChildProcess[] = [];
after(() => { for (const c of started) c.kill('SIGKILL'); }); // by handle: safe whether or not it still runs
const sleeper = async (...args: string[]) => {
  const c = spawn(process.execPath, ['-e', "console.log('up'); setTimeout(() => {}, 60000)", '--', ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(c);
  await new Promise((r) => c.stdout!.once('data', r));
  return c;
};
const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
const gone = (c: ChildProcess) => new Promise<boolean>((r) => {
  if (!running(c)) return r(true);
  const t = setTimeout(() => r(false), 10_000);
  c.once('exit', () => { clearTimeout(t); r(true); });
});
// long enough for a kill that was sent to be seen
const survives = async (c: ChildProcess) => { await new Promise((r) => setTimeout(r, 1000)); return running(c); };

test('killMarked leaves alone a process that does not carry the mark: its number was reused', { timeout: 60_000 }, async () => {
  const other = await sleeper('somebody-else');
  assert.deepEqual(killMarked([other.pid!], MARK), []);
  assert.ok(await survives(other), 'a process without the mark was ended');
});

test('killMarked ends the processes that carry the mark, and only those', { timeout: 60_000 }, async () => {
  const mine = await sleeper(MARK), other = await sleeper('somebody-else');
  assert.deepEqual(killMarked([mine.pid!, other.pid!], MARK), [mine.pid]);
  assert.ok(await gone(mine), 'the marked process still runs');
  assert.ok(await survives(other));
});

test('killMarked is quiet about numbers no process has, about none at all, and refuses an empty mark', { timeout: 60_000 }, async () => {
  const done = await sleeper(MARK);
  done.kill('SIGKILL');
  await gone(done);
  assert.deepEqual(killMarked([done.pid!], MARK), []);
  assert.deepEqual(killMarked([], MARK), []);
  assert.throws(() => killMarked([process.pid], ''), /mark/);
});

test('killChild does nothing for a child that has ended, whatever runs under its number now', { timeout: 60_000 }, async () => {
  const now = await sleeper('somebody-else'); // stands for the process that got the ended child's number
  assert.equal(killChild({ pid: now.pid, exitCode: 0, signalCode: null }), false);
  assert.equal(killChild({ pid: now.pid, exitCode: null, signalCode: 'SIGKILL' }), false);
  assert.equal(killChild(undefined), false);
  assert.ok(await survives(now), 'an ended child\'s number was killed');
});

test('killChild ends a child that still runs', { timeout: 60_000 }, async () => {
  const c = await sleeper();
  assert.equal(killChild(c), true);
  assert.ok(await gone(c));
});

test('the runner tests end processes only through these two', () => {
  const src = readFileSync('test/runner.test.ts', 'utf8');
  assert.deepEqual(src.split('\n').filter((l) => /'taskkill'|process\.kill\([^)]*'SIG/.test(l)), []);
});
