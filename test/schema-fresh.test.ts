// schema.sql must apply to an EMPTY database, not only re-apply over the last one (#3703: a sql-language function that
// called a function created further down passed every test, whose databases persist, and would have failed the deploy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { TEST_URL } from './helpers.ts'; // also the claude_board_test* guard
import { ensureTestPg } from '../db/pg.ts';

test('schema.sql applies to a brand-new database, twice', { timeout: 120_000 }, async () => {
  const db = `claude_board_test_fresh_${process.pid}`;
  ensureTestPg(TEST_URL); // the admin connection below comes before setup.ts would start it (a worktree's stopped cluster, #4413)
  const adminUrl = new URL(TEST_URL); adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${db}" with (force)`);
    const env = { ...process.env, CB_TEST_DB: db };
    for (let i = 0; i < 2; i++) assert.match(execFileSync('node', ['db/setup.ts', '--test'], { env, encoding: 'utf8' }), new RegExp(`${db} ready`));
  } finally {
    await admin.unsafe(`drop database if exists "${db}" with (force)`);
    await admin.end();
  }
});
