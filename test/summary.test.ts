import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, mask, logTail } from '../cli/summary.ts';
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

test('vitest output gives counts and the failing path', () => {
  assert.equal(summarize(fx('vitest-fail.txt')).text, '1 passed, 1 failed, 1 skipped. Failing: c.test.ts > suite > breaks on purpose');
});

test('TAP output works too', () => {
  assert.equal(summarize('ok 1 - a\nnot ok 2 - b\n# pass 1\n# fail 1').text, '1 passed, 1 failed, 0 skipped. Failing: b');
});

test('other output gives the last 10 lines', () => {
  const all = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  assert.equal(summarize(all.join('\n')).text, all.slice(20).join('\n'));
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
