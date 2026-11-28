// #3222 S1: cb reaches the board only through named functions (cli/board.ts), so the worker API can carry the same
// calls. Pure: it reads source files. S1a covers cli/cb.ts, S1c the runner and triage; the other slices add their files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['cli/cb.ts', 'cli/runner.ts', 'cli/runner-board.ts', 'cli/runner-job.ts', 'cli/triage.ts'];
// what a file may still do, until the slice that takes it away: the runner listens for new jobs until S4
const STILL: Record<string, string[]> = { 'cli/runner.ts': ['LISTEN'] };

const BANNED: [string, RegExp][] = [
  ['tagged SQL', /\b(?:sql|tx|db|direct)\s*`/],
  ['a template that starts like SQL', /[A-Za-z_$\])]`\s*(?:select|insert|update|delete|with)\b/i],
  ['.unsafe(', /\.unsafe\s*\(/],
  ['.begin(', /\.begin\s*\(/],
  ['an advisory lock', /pg_advisory/],
  ['pg_notify', /pg_notify/],
  ['LISTEN', /\b(?:sql|tx|db|direct)\s*\.listen\s*\(/], // not an HTTP or socket server's listen
];

for (const file of FILES) {
  test(`${file} holds no SQL of its own`, () => {
    const found = readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
      BANNED.filter(([what, re]) => !STILL[file]?.includes(what) && re.test(line)).map(([what]) => `${file}:${i + 1} ${what}: ${line.trim().slice(0, 100)}`));
    assert.deepEqual(found, [], 'make it a cb.* function in db/schema.sql, list it in server/ops.ts and use call() (cli/board.ts)');
  });
}
