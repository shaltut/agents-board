// The runner's job_finish call against a fake board (no DB): which errors are a refusal and which are a retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finish, rootMatches, type Result } from '../cli/runner-job.ts';

const pgError = (code: string, message: string) => Object.assign(new Error(message), { name: 'PostgresError', code });
// a tagged-template stand-in for postgres.js: records each call's values, answers from a script
function fakeSql(script: (Error | boolean)[]) {
  const calls: unknown[][] = [];
  const sql = async (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    const next = script.shift();
    if (next instanceof Error) throw next;
    return [{ ok: next }];
  };
  return { sql, calls };
}
const R: Result = { state: 'failed', exit_code: 3, summary: '1 passed, 1 failed. Failing: breaks' };

test('a looks-like refusal is resent once with the summary withheld, the exit code kept', async () => {
  const { sql, calls } = fakeSql([pgError('P0001', 'the summary looks like an email; the board keeps no such text'), true]);
  assert.equal(await finish(sql, 'pc', 7, R, () => {}, 0), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [7, 'pc', 'failed', 3, 'summary withheld: see cb job log 7']);
});

test('a board that is busy or restarting is retried, not a refusal: summary and exit code kept', async () => {
  const { sql, calls } = fakeSql([pgError('53300', 'sorry, too many clients already'), pgError('57P01', 'terminating connection due to administrator command'), true]);
  assert.equal(await finish(sql, 'pc', 7, R, () => {}, 0), true);
  assert.equal(calls.length, 3);
  for (const c of calls) assert.deepEqual(c, [7, 'pc', 'failed', 3, R.summary]);
});

test('an error the board will keep giving (function missing, no permission) is given up on, not retried forever', async () => {
  const { sql, calls } = fakeSql([pgError('42883', 'function cb.job_finish does not exist'), true]);
  const said: string[] = [];
  assert.equal(await finish(sql, 'pc', 7, R, (m) => said.push(m), 0), false);
  assert.equal(calls.length, 1);
  assert.equal(said.length, 1);
});

test('a network error is retried', async () => {
  const { sql, calls } = fakeSql([Object.assign(new Error('read ECONNRESET'), { name: 'Error' }), true]);
  assert.equal(await finish(sql, 'pc', 7, R, () => {}, 0), true);
  assert.equal(calls.length, 2);
});

test('a POSIX root matches on the program or, behind a shebang, the script', () => {
  assert.equal(rootMatches('node /x/pnpm i', 'pnpm'), true);
  assert.equal(rootMatches('/usr/bin/pnpm i', 'pnpm'), true);
  assert.equal(rootMatches('node x.js', 'pnpm'), false);
});
