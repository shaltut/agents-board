// #3222 S1: cb reaches the board only through named functions (cli/board.ts), so the worker API can carry the same
// calls. Pure: it reads source files. S1a covers cli/cb.ts, S1b the relay, the hooks, jobs, usage, update and the stage
// words, S1c the runner, triage and the supervisor; the other slices add their files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['cli/cb.ts', 'cli/relay.ts', 'cli/relay-refusal.ts', 'cli/jobs.ts', 'cli/usage.ts', 'cli/update-install.ts',
  'cli/stage-words.ts', 'cli/tick.ts', 'hooks/session-start.mjs', 'hooks/usage-stop.mjs',
  'cli/runner.ts', 'cli/runner-board.ts', 'cli/runner-job.ts', 'cli/triage.ts',
  'cli/supervise.ts', 'cli/supervise-plan.ts', 'cli/lease.ts', 'cli/lease-worker.ts'];
// what a file may still do, until the slice that takes it away: the relay and the runner listen for notices until the
// worker API streams them (#3222 S3, S4)
const STILL: Record<string, string[]> = { 'cli/relay.ts': ['LISTEN'], 'cli/runner.ts': ['LISTEN'] };

const BANNED: [string, RegExp][] = [
  ['tagged SQL', /\b(?:sql|tx|db|direct)\s*`/],
  ['a template that starts like SQL', /[A-Za-z_$\])]`\s*(?:select|insert|update|delete|with)\b/i],
  ['.unsafe(', /\.unsafe\s*\(/],
  ['.begin(', /\.begin\s*\(/],
  ['an advisory lock', /pg_advisory/],
  ['pg_notify', /pg_notify/],
  // its default connection runs the web's list as SQL: nothing the bridge or the worker API can carry
  ['the web\'s call list', /\{[^}]*\b(?:callFn|useDb)\b[^}]*\}\s*from\s*'\.\.\/server\/rpc/],
  ['LISTEN', /\b(?:sql|tx|db|direct)\s*\.listen\s*\(/], // not an HTTP or socket server's listen
];

for (const file of FILES) {
  test(`${file} holds no SQL of its own`, () => {
    const found = readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
      BANNED.filter(([what, re]) => !STILL[file]?.includes(what) && re.test(line)).map(([what]) => `${file}:${i + 1} ${what}: ${line.trim().slice(0, 100)}`));
    assert.deepEqual(found, [], 'make it a cb.* function in db/schema.sql, list it in server/ops.ts and use call() (cli/board.ts)');
  });
}
