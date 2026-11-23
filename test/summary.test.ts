import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, mask, logTail } from '../cli/summary.ts';
import * as summary from '../cli/summary.ts';
import { freshDb } from './helpers.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/runner/${n}`, import.meta.url), 'utf8');

test('node:test output gives counts and the failing name', () => {
  assert.equal(summarize(fx('node-test-fail.txt')).text, '1 passed, 1 failed, 1 skipped. Failing: breaks on purpose');
});

test('a mangled summary glyph still counts', () => {
  assert.equal(summarize(fx('node-test-fail.txt').replaceAll('ℹ', '?')).text, '1 passed, 1 failed, 1 skipped. Failing: breaks on purpose');
});

test('ran is null without counts and 0 when nothing ran', () => {
  assert.equal(summarize('just some text').ran, null);
  assert.equal(summarize('ℹ pass 0\nℹ fail 0\nℹ skipped 4').ran, 0);
  assert.equal(summarize(fx('node-test-fail.txt')).ran, 2);
});

test('node:test cancelled and todo counts are kept, and the cancelled tests named', () => {
  const out = ['✖ hangs (3.2ms)', "  'test did not finish before its parent and was cancelled'", 'ℹ tests 15', 'ℹ pass 12', 'ℹ fail 0', 'ℹ cancelled 3', 'ℹ skipped 0', 'ℹ todo 1'].join('\n');
  assert.equal(summarize(out).text, '12 passed, 0 failed, 3 cancelled, 0 skipped, 1 todo. Failing: hangs');
});

test('vitest output gives counts and the failing path', () => {
  assert.equal(summarize(fx('vitest-fail.txt')).text, '1 passed, 1 failed, 1 skipped. Failing: c.test.ts > suite > breaks on purpose');
});

test('TAP output works too', () => {
  assert.equal(summarize('ok 1 - a\nnot ok 2 - b\n# pass 1\n# fail 1').text, '1 passed, 1 failed, 0 skipped. Failing: b');
});

test('other output gives the last 5 lines', () => {
  const all = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  assert.equal(summarize(all.join('\n')).text, all.slice(25).join('\n'));
});

test('prettier frames are dropped, the error line stays', () => {
  const out = ['[error] x.ts: SyntaxError: Unexpected token (1:11)', '[error] > 1 | const x = = 1;', '[error]     |           ^', '[error]   2 | const y = 2;', '[error]   3 |', 'Error occurred when checking code style in the above file.'].join('\n');
  const t = summarize(out).text;
  assert.doesNotMatch(t, /\| /);
  assert.match(t, /SyntaxError: Unexpected token \(1:11\)/);
});

test('pnpm trailer lines do not hide the tsc error', () => {
  const out = ["src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", 'C:\\r\\x\\packages\\y:', ' ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @syn/x@0.0.0 check: `tsc`', 'Exit status 2', ' WARN  Local package.json exists, but node_modules missing'].join('\n');
  assert.match(summarize(out).text, /TS2322/);
});

test('a failed install keeps its cause line', () => {
  const out = [' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json', 'Exit status 1'].join('\n');
  assert.match(summarize(out).text, /ERR_PNPM_OUTDATED_LOCKFILE/);
});

test('a log that is all dropped lines still gives a summary', () => {
  assert.equal(summarize(' WARN  x\nExit status 1').text, 'Exit status 1');
  assert.equal(summarize('  301 │   expect(x)\n     ╰────').text, '(no output)');
});

test('a NUL byte is stripped (the board refuses it)', () => {
  assert.doesNotMatch(summarize('a\0b').text, /\0/);
});

test('lint output drops code-frame lines, so no source reaches the board', () => {
  const out = ['  x no-unused (a.ts:1)', '  301 │   expect(x)', '     ·  ───', '     ╰────', 'Found 3 warnings and 0 errors.'].join('\n');
  const t = summarize(out).text;
  assert.doesNotMatch(t, /[│·╰─]/);
  assert.ok(t.endsWith('Found 3 warnings and 0 errors.'));
});

test('at most 5 failing names', () => {
  const out = Array.from({ length: 8 }, (_, i) => `✖ t${i + 1} (1ms)`).join('\n') + '\nℹ pass 0\nℹ fail 8';
  assert.equal(summarize(out).text, '0 passed, 8 failed, 0 skipped. Failing: t1; t2; t3; t4; t5; and 3 more');
});

test('huge output stays within 1000 characters', () => {
  assert.ok(summarize('x'.repeat(5_000_000)).text.length <= 1000);
});

const samples = [
  'ghp_' + 'a1B2c3D4e5'.repeat(3),
  'Bearer abcdefghijklmnopqrstuvwxyz123',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_def-123',
  'postgres://u:pw@h/db',
  'password=hunter2!x',
  '--token abc123',
  'ID 1234567890',
  'mail a.person@example.org',
  '+966 55 123 4567',
];
test('mask hides what the board would refuse', async () => {
  const sql = await freshDb();
  after(() => sql.end());
  for (const x of samples) {
    const m = mask(x);
    assert.ok(m.includes('[masked]'), x);
    const [r] = await sql`select cb._sensitive(${m}) as hit`;
    assert.equal(r!.hit, null, `${x} -> ${m}`);
  }
  const keep = '1 passed, 2 failed, ok a/b.test.ts 221ms 2147483647';
  assert.equal(mask(keep), keep);
});

test('logTail reads only the end', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'cb-tail-')), 'x.log');
  writeFileSync(p, 'a'.repeat(3_000_000) + '\nthe last line\n');
  const t = logTail(p);
  assert.ok(t.length <= 1_048_576);
  assert.ok(t.endsWith('the last line\n'));
});

test('a stray "Tests" line does not hide node counts', () => {
  const r = summarize('Tests skipped: no db\nℹ pass 5\nℹ fail 0');
  assert.equal(r.text, '5 passed, 0 failed, 0 skipped.');
  assert.equal(r.ran, 5);
});

test('cut keeps masked text within 1000 characters', () => {
  const emails = Array.from({ length: 200 }, () => 'a@b.cc').join(' ');
  const out = summary.cut('no tests ran: ' + mask(emails));
  assert.ok(out.length <= 1000);
  assert.ok(out.endsWith('…'));
});

test('a huge whitespace line is linear', () => {
  const t = Date.now();
  summarize(' '.repeat(1_000_000) + 'x');
  summarize('FAIL' + ' '.repeat(1_000_000) + 'x');
  assert.ok(Date.now() - t < 1000);
});
