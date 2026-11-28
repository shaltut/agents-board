// #3222 S3: cb key install and cb key check. Pure: temp folders, a stand-in server on loopback, and cb spawned with a
// database address nothing listens on, so a command that reached for a database would fail. Keys are made up here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyCmd } from '../cli/key.ts';

const SECRET = 'S'.repeat(43), KEY = `cbk1_0123456789_${SECRET}`;
const temp = (name: string) => mkdtempSync(join(tmpdir(), `cb-${name}-`));
const input = (text: string) => async () => text;
const noFile = () => undefined;

const servers: http.Server[] = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));
async function board(status: number, body: object) {
  const server = http.createServer((_req, res) => { res.writeHead(status, { 'x-cb-proto': '1' }); res.end(JSON.stringify(body)); });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}
const who = (over: object = {}) => ({ ok: true, key: '0123456789', kind: 'machine', machine: 'boxa', runner: null, release: 'r42', ...over });
const withKey = (kind = 'machine') => { const d = temp('keys'); writeFileSync(join(d, `${kind}.key`), KEY); return d; };
/** The failure's words, which never hold the key. */
async function refused(p: Promise<unknown>) {
  try { await p; } catch (e: any) {
    assert.ok(!`${e.message} ${e.stack} ${JSON.stringify(e)}`.includes(SECRET.slice(0, 20)), 'the key is in the error');
    assert.equal(e.code, undefined, 'a code would let cb take it for the database being down');
    return String(e.message);
  }
  assert.fail('it did not fail');
}

test('install stores the key from stdin and says where, never what', async () => {
  const d = temp('keys');
  const r = await keyCmd(['install', 'machine'], { input: input(`${KEY}\n`), tty: false, env: { CB_KEY_DIR: d, CB_BOARD_URL: 'https://board.example' }, file: noFile });
  assert.equal(readFileSync(join(d, 'machine.key'), 'utf8'), `${KEY}\n`);
  assert.ok(r.includes(join(d, 'machine.key')) && /cb key check machine/.test(r) && !r.includes(SECRET.slice(0, 20)), r);
  assert.doesNotMatch(r, /CB_BOARD_URL/);
  const alone = await keyCmd(['install', 'runner'], { input: input(KEY), tty: false, env: { CB_KEY_DIR: d }, file: noFile });
  assert.match(alone, /CB_BOARD_URL/);
});

test('install takes a key on stdin only: not typed at a terminal, never as an argument', async () => {
  const d = temp('keys'), env = { CB_KEY_DIR: d };
  let read = false;
  assert.match(await refused(keyCmd(['install', 'machine'], { input: async () => { read = true; return KEY; }, tty: true, env, file: noFile })), /pipe/);
  assert.equal(read, false);
  assert.match(await refused(keyCmd(['install', 'machine', KEY], { input: input(''), tty: false, env, file: noFile })), /never as an argument.*revoke/);
  assert.match(await refused(keyCmd(['install', KEY], { input: input(KEY), tty: false, env, file: noFile })), /machine, runner or supervisor/);
  assert.match(await refused(keyCmd(['install', 'machine'], { input: input(`junk ${SECRET}`), tty: false, env, file: noFile })), /not a board key/);
  assert.deepEqual(readdirSync(d), []);
});

test('check asks the board who the key is, even where cb still uses the database', async () => {
  const url = await board(200, who());
  const env = { CB_KEY_DIR: withKey(), CB_BOARD_URL: url, CB_DATABASE_URL: 'postgres://x@127.0.0.1:1/db', CB_MACHINE: 'boxa' };
  const r = await keyCmd(['check'], { env, file: noFile });
  for (const part of [url, '0123456789', 'machine boxa', 'r42']) assert.ok(r.includes(part), `${part}: ${r}`);
  assert.doesNotMatch(r, /CB_MACHINE/);
});

test('check says so when this machine goes by another name than its key: its writes would be refused', async () => {
  const env = { CB_KEY_DIR: withKey(), CB_BOARD_URL: await board(200, who()), CB_MACHINE: 'Laptop' };
  assert.match(await keyCmd(['check'], { env, file: noFile }), /calls itself laptop.*CB_MACHINE=boxa/s);
});

test('check fails on a key of another kind, a refused key, no key, no address and no board', async () => {
  const url = await board(200, who({ kind: 'runner', runner: 'pc' }));
  assert.match(await refused(keyCmd(['check', 'machine'], { env: { CB_KEY_DIR: withKey(), CB_BOARD_URL: url }, file: noFile })), /is a runner key, not a machine key/);
  const no = await board(401, { ok: false, code: 'unauthorized', error: 'no' });
  assert.match(await refused(keyCmd(['check'], { env: { CB_KEY_DIR: withKey(), CB_BOARD_URL: no }, file: noFile })), /401/);
  assert.match(await refused(keyCmd(['check'], { env: { CB_KEY_DIR: temp('keys'), CB_BOARD_URL: no }, file: noFile })), /cb key install machine/);
  assert.match(await refused(keyCmd(['check'], { env: { CB_KEY_DIR: withKey() }, file: noFile })), /set CB_BOARD_URL/);
  assert.match(await refused(keyCmd(['check'], { env: { CB_KEY_DIR: withKey(), CB_BOARD_URL: 'http://127.0.0.1:1' }, file: noFile })), /could not check/);
});

test('anything else names the two commands', async () => {
  for (const args of [[], ['show'], ['install'], ['check', 'machine', 'x']]) {
    assert.match(await refused(keyCmd(args, { env: { CB_KEY_DIR: temp('keys') }, file: noFile, tty: false, input: input('') })), /cb key (install|check)/, args.join(' '));
  }
});

test('cb key install runs with no database, prints no key and writes none to the fault log', () => {
  const d = temp('keys'), faults = temp('faults');
  const run = (args: string[], stdin: string) => spawnSync('node', ['cli/cb.ts', ...args], {
    input: stdin, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CB_KEY_DIR: d, CB_FAULTS_HOME: faults, CB_DATABASE_URL: 'postgres://cb@127.0.0.1:1/claude_board_test',
      CB_BOARD_URL: 'https://board.example', CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', CB_AGENT: '', CLAUDE_CODE_MESSAGING_SOCKET: '' },
  });
  const ok = run(['key', 'install', 'machine'], `${KEY}\n`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(join(d, 'machine.key')));
  const bad = run(['key', 'install', 'runner', KEY], '');
  assert.equal(bad.status, 1, bad.stdout);
  const logged = readdirSync(faults, { recursive: true, withFileTypes: true }).filter((f) => f.isFile())
    .map((f) => readFileSync(join(f.parentPath, f.name), 'utf8')).join('\n');
  assert.ok(![ok.stdout, ok.stderr, bad.stdout, bad.stderr, logged].join('\n').includes(SECRET.slice(0, 20)));
});
