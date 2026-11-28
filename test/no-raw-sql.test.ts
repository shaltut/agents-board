// #3222 S1: cb reaches the board only through named functions (cli/board.ts), so the worker API can carry the same
// calls. Pure: it reads source files. S1a covers cli/cb.ts, S1b the relay, the hooks, jobs, usage, update and the stage
// words; the later slices add their files here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['cli/cb.ts', 'cli/relay.ts', 'cli/relay-refusal.ts', 'cli/jobs.ts', 'cli/usage.ts', 'cli/update-install.ts',
  'cli/stage-words.ts', 'hooks/session-start.mjs', 'hooks/usage-stop.mjs'];
// the relay keeps its own LISTEN until the worker API streams the notices (#3222 S3)
const STILL: Record<string, string[]> = { 'cli/relay.ts': ['LISTEN'] };

const BANNED: [string, RegExp][] = [
  ['tagged SQL', /\b(?:sql|tx|db|direct)\s*`/],
  ['a template that starts like SQL', /[A-Za-z_$\])]`\s*(?:select|insert|update|delete|with)\b/i],
  ['.unsafe(', /\.unsafe\s*\(/],
  ['.begin(', /\.begin\s*\(/],
  ['an advisory lock', /pg_advisory/],
  ['pg_notify', /pg_notify/],
  ['LISTEN', /\.listen\s*\(/],
];

for (const file of FILES) {
  test(`${file} holds no SQL of its own`, () => {
    const found = readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
      BANNED.filter(([what, re]) => re.test(line) && !STILL[file]?.includes(what))
        .map(([what]) => `${file}:${i + 1} ${what}: ${line.trim().slice(0, 100)}`));
    assert.deepEqual(found, [], 'make it a cb.* function in db/schema.sql, list it in server/ops.ts and use call() (cli/board.ts)');
  });
}
