// #3222 S3 against S2: cb's HTTP client (cli/board.ts) and the board's worker API (server/worker.ts) over a real socket.
// Each side is tested alone against what the two seats agreed; this checks they agree. Keys are the test database's own.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql, connect } = await import('../server/db.ts');
const { closeWorker } = await import('../server/worker.ts');
const { serve } = await import('@hono/node-server');
const { apiBoard, call } = await import('../cli/board.ts');
const { keyCmd } = await import('../cli/key.ts');
const { installKey } = await import('../cli/transport.ts');
const { neverSent } = await import('../cli/connect-retry.ts');

let server: any;
const url = await new Promise<string>((ok) => {
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (at: any) => ok(`http://127.0.0.1:${at.port}`));
});
const open: { end: () => unknown }[] = [];
after(async () => {
  await Promise.all(open.map((c) => c.end()));
  server.closeAllConnections?.();
  server.close();
  await closeWorker();
  await serverSql.end();
});

async function board() {
  const sql = await freshDb(); open.push(sql);
  const direct = connect(TEST_URL, { app: 'cb', max: 2 }); open.push(direct);
  await sql`select cb.ensure_project('demo')`;
  const [{ key }] = await sql`select cb.key_issue('boxa', 'machine', null) as key`;
  const env = { CB_KEY_DIR: mkdtempSync(join(tmpdir(), 'cb-contract-')), CB_BOARD_URL: url, CB_MACHINE: 'boxa' };
  const keyFile = installKey('machine', key, env);
  const api = apiBoard({ url, keyFile, code: 'contract' }); open.push(api);
  return { sql, direct, api, env, id: key.split('_')[1] as string };
}
const plain = (v: any) => (Array.isArray(v) ? v.map((row) => (row && typeof row === 'object' ? { ...row } : row)) : v);
const failure = async (p: Promise<unknown>) => {
  try { await p; } catch (e: any) { return e; }
  assert.fail('the call did not fail');
};
const ME = 'W1@boxa';

test('cb key check reads the key the board issued', async () => {
  const { env, id } = await board();
  const r = await keyCmd(['check'], { env, file: () => undefined });
  assert.deepEqual([r.json.key, r.json.kind, r.json.machine, r.json.runner, r.json.this_machine], [id, 'machine', 'boxa', null, 'boxa'], r.out);
});

test('a read answers over the API exactly what it answers on the database: rows, times, jsonb', async () => {
  const { direct, api } = await board();
  await call('iam', { machine: 'boxa', pane: 'p1', actor: ME, project: 'demo' }, api);
  const id = await call('task_add', { project: 'demo', title: 'synthetic card', body: 'two\nlines', actor: ME }, api);
  assert.equal(typeof id, 'number');
  await call('log', { project: 'demo', summary: 'a note', task_id: String(id), actor: ME }, api);
  await call('task_tag', { id, add: ['a', 'b'], remove: [], actor: ME }, api);
  const reads: [string, Record<string, unknown>][] = [
    ['task_row', { id }], ['session_binding', { machine: 'boxa', pane: 'p1' }], ['task_find', { q: 'synthetic', project: 'demo', notes: false, lim: 5 }],
    ['task_notes', { id }], ['mine', { actor: ME }], ['users_overview', {}], ['session_events', { who: ME }],
  ];
  for (const [fn, args] of reads) assert.deepStrictEqual(plain(await call(fn, args, api)), plain(await call(fn, args, direct)), fn);
  const [row] = await call('task_row', { id }, api);
  assert.ok(row.created_at instanceof Date, `created_at is ${typeof row.created_at}`);
});

test('a database error, and each refusal, comes back usable', async () => {
  const { direct, api } = await board();
  const bad = { project: 'demo', title: 'x', priority: 'P9', actor: ME };
  const there = await failure(call('task_add', bad, direct)), over = await failure(call('task_add', bad, api));
  assert.deepEqual([over.name, over.code, over.message], [there.name, there.code, there.message]);
  assert.equal((await failure(call('user_known', { who: 'cai' }, api))).code, '42883');
  const other = await failure(call('task_add', { project: 'demo', title: 'x', actor: 'W1@boxb' }, api));
  assert.match(other.message, /name@boxa/);
  const big = await failure(call('task_add', { project: 'demo', title: 'x', body: 'x'.repeat(1_100_000), actor: ME }, api));
  assert.match(big.message, /over 1 MB/);
  for (const e of [other, big]) assert.ok(typeof e.code === 'string' && e.code !== 'undefined' && !neverSent(e), `code ${e.code}: ${e.message}`);
});

test('the rate limit is a call that never ran', async () => {
  const { api } = await board();
  process.env.CB_API_RATE = '1';
  try {
    await call('resume', { actor: ME }, api);
    const e = await failure(call('resume', { actor: ME }, api));
    assert.ok(neverSent(e), `${e.code} ${e.message}`);
  } finally { delete process.env.CB_API_RATE; }
});

test('the stream carries this machine\'s bindings and ends for good when the key is revoked', async () => {
  const { sql, api, id } = await board();
  const got: string[] = [], refused: string[] = [];
  const stream = api.events(['cb', 'cb_bind'], (channel, data) => got.push(`${channel}=${data}`), { retryMs: 50, refused: (e) => refused.push(e.message) });
  const until = async (what: () => boolean, why: string) => {
    for (const end = Date.now() + 15_000; !what();) {
      assert.ok(Date.now() < end, `${why}: ${JSON.stringify(got)} ${JSON.stringify(refused)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  process.env.CB_API_PING_MS = '100';
  try {
    await until(() => got.includes('listen='), 'no listen');
    await sql`select cb.iam('boxa', 'p1', ${ME}, 'demo')`;
    await until(() => got.includes('cb_bind=boxa:p1'), 'no binding');
    await sql`select cb.key_revoke(${id})`;
    await until(() => refused.length === 1, 'never refused');
    assert.match(refused[0]!, /cb key check/);
    assert.match((await failure(call('resume', { actor: ME }, api))).message, /401/);
  } finally { stream.close(); delete process.env.CB_API_PING_MS; }
});
