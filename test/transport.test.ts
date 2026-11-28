// #3222 S3 (page 3222, 3.8): how a worker reaches the board, and its key file. Pure: temp folders, no board, no network.
// Every key here is made up on the spot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseTransport, installKey, keyDir, keyFile, readKey } from '../cli/transport.ts';

const SECRET = 'A'.repeat(43);
const KEY = `cbk1_0123456789_${SECRET}`;
const URL = 'https://board.example';
const dir = () => mkdtempSync(join(tmpdir(), 'cb-keys-'));
const withKey = (kind = 'machine') => { const d = dir(); writeFileSync(join(d, `${kind}.key`), `${KEY}\n`); return d; };
const choose = (env: Record<string, string>, file: Record<string, string> = {}, kind: any = 'machine') =>
  chooseTransport(kind, env, (k: string) => file[k]);

test('CB_DATABASE_URL in the environment always means the database, key or not', () => {
  assert.deepEqual(choose({ CB_DATABASE_URL: 'postgres://x@h/db', CB_BOARD_URL: URL, CB_KEY_DIR: withKey() }), { mode: 'db' });
  assert.deepEqual(choose({ CB_DATABASE_URL: 'postgres://x@h/db', CB_BOARD_URL: URL, CB_KEY_DIR: dir() }), { mode: 'db' });
});

test('a key and a board address mean the API, even with a database address in .env', () => {
  const d = withKey();
  const want = { mode: 'api', url: URL, keyFile: join(d, 'machine.key') };
  assert.deepEqual(choose({ CB_BOARD_URL: URL, CB_KEY_DIR: d }, { DATABASE_URL: 'postgres://x@h/db' }), want);
  assert.deepEqual(choose({ CB_KEY_DIR: d }, { CB_BOARD_URL: `${URL}/` }), want);
});

test('no board address: the database, even beside a key', () => {
  assert.deepEqual(choose({ CB_KEY_DIR: withKey() }, { DATABASE_URL: 'postgres://x@h/db' }), { mode: 'db' });
  assert.deepEqual(choose({ CB_KEY_DIR: dir() }), { mode: 'db' });
});

test('a board address without this kind\'s key is an error that names the next step, never a fall back to the database', () => {
  for (const [d, kind] of [[dir(), 'machine'], [withKey('runner'), 'machine'], [withKey(), 'supervisor']] as const) {
    assert.throws(() => choose({ CB_BOARD_URL: URL, CB_KEY_DIR: d }, { DATABASE_URL: 'postgres://x@h/db' }, kind),
      new RegExp(`cb key install ${kind}`));
  }
});

test('the key goes over https only, or to this machine itself', () => {
  const d = withKey();
  for (const url of ['http://127.0.0.1:4747', 'http://localhost:4747', 'http://[::1]:4747']) {
    assert.equal((choose({ CB_BOARD_URL: url, CB_KEY_DIR: d }) as any).url, url, url);
  }
  for (const url of ['http://board.example', 'http://127.0.0.1.board.example', 'ftp://board.example', 'board.example',
    'https://user:pw@board.example', 'https://board.example/?u=1', 'https://board.example/#x']) {
    assert.throws(() => choose({ CB_BOARD_URL: url, CB_KEY_DIR: d }), /CB_BOARD_URL/, url);
  }
});

test('the keys folder is ~/.claude-board/keys unless CB_KEY_DIR names another', () => {
  assert.match(keyDir({}), /[\\/]\.claude-board[\\/]keys$/);
  assert.equal(keyFile('runner', { CB_KEY_DIR: 'somewhere' }), join('somewhere', 'runner.key'));
});

test('cb key install writes the key it is given, user-only, and says nothing about it', () => {
  const d = join(dir(), 'keys'), env = { CB_KEY_DIR: d };
  assert.equal(installKey('machine', `  ${KEY}\r\n`, env), join(d, 'machine.key'));
  assert.equal(readFileSync(join(d, 'machine.key'), 'utf8'), `${KEY}\n`);
  assert.equal(readKey(join(d, 'machine.key')), KEY);
  assert.deepEqual(readdirSync(d), ['machine.key']); // no temp file left beside it
  if (process.platform !== 'win32') assert.equal(statSync(join(d, 'machine.key')).mode & 0o777, 0o600);
  const next = `cbk1_abcdef0123_${'b'.repeat(43)}`;
  installKey('machine', next, env);
  assert.equal(readKey(join(d, 'machine.key')), next);
});

test('what is not a key is refused, unwritten and unrepeated', () => {
  const d = dir(), env = { CB_KEY_DIR: d };
  for (const text of ['', 'cbk1_short', `${KEY}x`, `${KEY} ${KEY}`, `xx ${SECRET}`]) {
    assert.throws(() => installKey('machine', text, env), (e: Error) => /not a board key/.test(e.message) && !e.message.includes(SECRET));
  }
  assert.deepEqual(readdirSync(d), []);
  writeFileSync(join(d, 'machine.key'), `garbage ${SECRET}`);
  assert.throws(() => readKey(join(d, 'machine.key')), (e: Error) => /cb key install/.test(e.message) && !e.message.includes(SECRET));
  assert.throws(() => installKey('seat' as any, KEY, env), /machine, runner or supervisor/);
});
