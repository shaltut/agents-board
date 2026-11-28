// #4722: a global flag before the command (cb --json show, cb --as x run) must not hide the command word. No database:
// every cb run here ends at argument parsing or at --help.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argvShape, SUBS } from '../cli/fault-hook.ts';

const home = mkdtempSync(join(tmpdir(), 'cb-lead-'));
after(() => rmSync(home, { recursive: true, force: true }));
function cb(...args: string[]) {
  const r = spawnSync(process.execPath, ['cli/cb.ts', ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, CB_DATABASE_URL: 'postgres://cb@127.0.0.1:1/claude_board_test', CB_ACTOR: 'W1@test', HERDR_PANE_ID: '',
      CB_FAULTS_HOME: join(home, 'faults'), HOME: home, USERPROFILE: home },
  });
  return { code: r.status, err: r.stderr.trim() };
}

test('cb run takes its free --<param> flags with global flags before it', () => {
  for (const lead of [['--json'], ['--as', 'W2@test'], ['--as=W2@test', '--json']]) {
    const r = cb(...lead, 'run', 'test', '--ws', 'web', '--help');
    assert.equal(r.code, 0, `${lead.join(' ')}: ${r.err}`);
  }
});

test('a --as value that is the word run does not make another command a cb run', () => {
  const r = cb('--as', 'run', 'show', '--ws', 'web');
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown option --ws\. Run: cb help show /);
});

test('the unknown-option hint names the command behind global flags', () => {
  for (const lead of [['--json'], ['--as', 'W2@test'], ['-t', '5']])
    assert.match(cb(...lead, 'show', '--bogus').err, /unknown option --bogus\. Run: cb help show /, lead.join(' '));
  assert.match(cb('--bogus').err, /Run: cb help \(it lists/);
});

const OPTS = { as: { type: 'string' }, json: { type: 'boolean' }, wait: { type: 'boolean' }, task: { type: 'string', short: 't' } };

test('argvShape finds the command and subcommand behind global flags, and still masks their values', () => {
  const a = argvShape(['--json', '--as', 'name-x', 'lock', 'take', 'db'], OPTS);
  assert.deepEqual(a, { cmd: 'lock', sub: 'take', flags: ['as', 'json'], argc: 1, values: ['name-x', 'db'] });
  const b = argvShape(['-t', '5', 'run', 'test', '--ws', 'web', '--wait'], OPTS);
  assert.deepEqual(b, { cmd: 'run', sub: null, flags: ['task', 'wait', 'ws'], argc: 1, values: ['5', 'test', 'web'] });
  assert.equal(argvShape(['--as=run', 'doctor'], OPTS).cmd, 'doctor');
  assert.equal(argvShape(['--json'], OPTS).cmd, null);
});

test('every job and squad subcommand is in the fault log', () => {
  for (const s of ['show', 'cancel', 'log', 'retry', 'move', 'hold', 'release']) assert.ok(SUBS.job!.includes(s), `job ${s}`);
  for (const s of ['show', 'set', 'up', 'trust']) assert.ok(SUBS.squad!.includes(s), `squad ${s}`);
});
