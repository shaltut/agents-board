// #3222 S3: cb's HTTP side of the worker API (cli/board.ts), against a stand-in server. Pure: loopback only, no board.
// The shapes here are the contract agreed with the server side (#4911). Every key is made up on the spot.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiBoard, call } from '../cli/board.ts';
import { neverSent, withConnectRetry } from '../cli/connect-retry.ts';
import { isNetworkError } from '../cli/survive.ts';

const KEY = `cbk1_0123456789_${'S'.repeat(43)}`;
const keyFile = join(mkdtempSync(join(tmpdir(), 'cb-api-')), 'machine.key');
writeFileSync(keyFile, `${KEY}\n`);

const servers: { close: () => void }[] = [];
after(() => servers.forEach((s) => s.close()));

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: any };
type Reply = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string>; bare?: boolean };

/** A stand-in board: answers each request with what `answer` returns; null: the handler wrote (or will never write). */
async function stub(answer: (seen: Seen, res: http.ServerResponse) => Reply | null) {
  const seen: Seen[] = [];
  let connections = 0;
  const open = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (d) => { text += d; });
    req.on('end', () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body: text ? JSON.parse(text) : undefined };
      seen.push(s);
      const r = answer(s, res);
      if (!r) return;
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...(r.bare ? {} : { 'x-cb-proto': '1' }), ...r.headers });
      res.end(r.raw ?? JSON.stringify(r.body));
    });
  });
  server.on('connection', (s) => { connections++; open.add(s); s.on('close', () => open.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const close = () => { for (const s of open) s.destroy(); server.close(); };
  servers.push({ close });
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return { url, seen, connections: () => connections, close };
}
const client = (url: string, o: Record<string, unknown> = {}) => apiBoard({ url, keyFile, code: 'abc1234', ...o });
const ok = (result: unknown): Reply => ({ body: { ok: true, result } });
const failure = async (p: Promise<unknown>) => {
  try { await p; } catch (e: any) {
    // a board key is never put in an error
    assert.ok(!`${e.message} ${e.stack} ${JSON.stringify(e)}`.includes('S'.repeat(20)), 'the key is in the error');
    return e;
  }
  assert.fail('the call did not fail');
};

test('a call is a POST with the key from its file, the protocol and the code, and its arguments as JSON', async () => {
  const s = await stub(() => ok(7));
  const board = client(s.url);
  assert.equal(await call('task_add', { project: 'demo', title: 't', parent: undefined, tags: ['a'], due: new Date('2026-01-02T03:04:05.000Z'), blob: Buffer.from('hi') }, board), 7);
  const [r] = s.seen;
  assert.deepEqual([r!.method, r!.url, r!.headers.authorization, r!.headers['x-cb-proto'], r!.headers['x-cb-code']],
    ['POST', '/w/v1/call/task_add', `Bearer ${KEY}`, '1', 'abc1234']);
  // an argument left undefined is a null, as it is on the database
  assert.deepEqual(r!.body, { args: { project: 'demo', title: 't', parent: null, tags: ['a'], due: '2026-01-02T03:04:05.000Z', blob: { $bytes: 'aGk=' } } });
});

test('the key is read for every call, so a new one takes effect at once; calls share one connection', async () => {
  const s = await stub(() => ok(null));
  const own = join(mkdtempSync(join(tmpdir(), 'cb-api-')), 'machine.key');
  writeFileSync(own, KEY);
  const board = apiBoard({ url: s.url, keyFile: own, code: 'x' });
  await call('brief', { project: 'demo' }, board);
  const next = `cbk1_abcdef0123_${'n'.repeat(43)}`;
  writeFileSync(own, next);
  await call('brief', { project: 'demo' }, board);
  assert.deepEqual(s.seen.map((r) => r.headers.authorization), [`Bearer ${KEY}`, `Bearer ${next}`]);
  assert.equal(s.connections(), 1);
});

test('a time or bytes come back as such where the board marks them: the one value, or a row\'s own column', async () => {
  const at = '2026-01-02T03:04:05.000Z';
  const s = await stub((r) => ok(r.url.endsWith('task_row') // rows
    ? [{ id: 1, created_at: { $date: at }, image: { $bytes: 'aGk=' }, data: { when: { $date: 'kept' } }, list: [{ $date: 'kept' }] }]
    : r.url.endsWith('page_get') ? { at: { $date: 'kept' } } : { $date: at }));
  const board = client(s.url);
  assert.deepEqual(await call('task_row', { id: 1 }, board),
    [{ id: 1, created_at: new Date(at), image: Buffer.from('hi'), data: { when: { $date: 'kept' } }, list: [{ $date: 'kept' }] }]);
  assert.deepEqual(await call('page_get', {}, board), { at: { $date: 'kept' } });
  assert.deepEqual(await call('digest', {}, board), new Date(at));
});

test('a database error comes back as the one the database would have thrown', async () => {
  const s = await stub((r) => r.url.endsWith('task_add')
    ? { status: 400, body: { ok: false, code: 'P0001', error: 'no such project "x": see cb help', detail: 'd', hint: 'h' } }
    : { status: 404, body: { ok: false, code: '42883', error: 'function cb.nope does not exist' } });
  const board = client(s.url);
  const e = await failure(call('task_add', {}, board));
  assert.deepEqual([e.name, e.code, e.message, e.detail, e.hint], ['PostgresError', 'P0001', 'no such project "x": see cb help', 'd', 'h']);
  assert.equal((await failure(call('brief', {}, board))).code, '42883');
  assert.ok(!neverSent(e) && !isNetworkError(e));
});

test('only a 429, or the board\'s own 503 saying it never ran, is safe to send again', async () => {
  const replies: Record<string, Reply> = {
    task_add: { status: 429, body: { ok: false, code: 'rate', error: 'slow down' }, headers: { 'retry-after': '1' } },
    log: { status: 503, body: { ok: false, code: 'busy', error: 'no connection free', never_ran: true } },
  };
  const s = await stub((r) => replies[r.url.split('/').pop()!]!);
  for (const fn of ['task_add', 'log']) {
    const e = await failure(call(fn, {}, client(s.url)));
    assert.ok(neverSent(e) && isNetworkError(e), `${fn}: ${e.code} ${e.message}`);
  }
});

test('any other lost or odd answer may have run: a network error, never sent again', async () => {
  const cases: [string, Reply | 'drop' | 'hang'][] = [
    ['a proxy 503', { status: 503, bare: true, raw: '<html>unavailable</html>' }],
    ['a proxy 503 that claims never_ran', { status: 503, bare: true, body: { never_ran: true } }],
    ['a board 503 with no never_ran', { status: 503, body: { ok: false, code: 'x', error: 'x' } }],
    ['a 502', { status: 502, bare: true, raw: 'bad gateway' }],
    ['a 500', { status: 500, body: { ok: false, code: 'x', error: 'boom' } }],
    ['a 200 that is not the board\'s', { status: 200, bare: true, raw: '<html>sign in</html>' }],
    ['a cut-off body', { status: 200, raw: '{"ok":true,"res' }],
    ['a dropped connection', 'drop'],
    ['no answer in time', 'hang'],
  ];
  for (const [what, reply] of cases) {
    const s = await stub((_r, res) => {
      if (reply === 'drop') { res.socket!.destroy(); return null; }
      return reply === 'hang' ? null : reply;
    });
    const e = await failure(call('task_add', {}, client(s.url, { replyTimeoutMs: 200 })));
    assert.ok(!neverSent(e) && isNetworkError(e), `${what}: ${e.code} ${e.message}`);
    assert.equal(s.seen.length, 1, what);
  }
});

test('a redirect is not followed: the key goes to the board\'s address only', async () => {
  const other = await stub(() => ok(1));
  const s = await stub(() => ({ status: 307, raw: '', headers: { location: `${other.url}/w/v1/call/brief` } }));
  const e = await failure(call('brief', {}, client(s.url)));
  assert.match(e.message, /CB_BOARD_URL/);
  assert.equal(other.seen.length, 0);
});

test('a refused key says what to do, and is neither retried nor taken for the network', async () => {
  const s = await stub(() => ({ status: 401, body: { ok: false, code: 'unauthorized', error: 'no' } }));
  const e = await failure(call('brief', {}, client(s.url)));
  assert.match(e.message, /cb key check/);
  assert.ok(!neverSent(e) && !isNetworkError(e));
});

test('a 403 and a 413 keep the board\'s words', async () => {
  const s = await stub((r) => r.url.endsWith('task_add')
    ? { status: 403, body: { ok: false, code: '42501', error: 'this key acts only as name@thismachine' } }
    : { status: 413, body: { ok: false, code: 'too_big', error: 'the body is over 1 MB' } });
  assert.match((await failure(call('task_add', {}, client(s.url)))).message, /name@thismachine/);
  assert.match((await failure(call('log', {}, client(s.url)))).message, /over 1 MB/);
});

test('a board that refuses the connection, or never finishes it, was never sent to', async () => {
  const gone = await stub(() => ok(1));
  gone.close();
  const refused = await failure(call('task_add', {}, client(gone.url)));
  assert.ok(neverSent(refused), `${refused.code} ${refused.message}`);
  // https to a socket that accepts and says nothing: the TLS handshake never ends, so nothing was written
  const open: net.Socket[] = [];
  const mute = net.createServer((s) => { open.push(s); });
  await new Promise<void>((r) => mute.listen(0, '127.0.0.1', r));
  servers.push({ close: () => { open.forEach((s) => s.destroy()); mute.close(); } });
  const slow = await failure(call('task_add', {}, client(`https://127.0.0.1:${(mute.address() as net.AddressInfo).port}`, { connectTimeoutMs: 200 })));
  assert.equal(slow.code, 'CONNECT_TIMEOUT', slow.message);
  assert.ok(neverSent(slow));
});

test('cb\'s retry sends a never-run call again and nothing else', async () => {
  let n = 0;
  const s = await stub(() => (++n < 3 ? { status: 429, body: { ok: false, code: 'rate', error: 'slow down' } } : ok(5)));
  const board = withConnectRetry(client(s.url), { sleep: async () => {} });
  assert.equal(await call('task_add', {}, board), 5);
  assert.deepEqual([s.seen.length, board.answered, board.retries], [3, 1, 2]);
  const dropped = await stub((_r, res) => { res.socket!.destroy(); return null; });
  await failure(call('task_add', {}, withConnectRetry(client(dropped.url), { sleep: async () => {} })));
  assert.equal(dropped.seen.length, 1);
});

test('hello says who the key is', async () => {
  const who = { ok: true, key: '0123456789', kind: 'machine', machine: 'boxa', runner: null, release: 'r1' };
  const s = await stub(() => ({ body: who }));
  assert.deepEqual(await client(s.url).hello(), who);
  assert.deepEqual([s.seen[0]!.method, s.seen[0]!.url], ['GET', '/w/v1/hello']);
});

test('call() refuses a name server/ops.ts does not list, before anything is sent', async () => {
  const s = await stub(() => ok(1));
  await assert.rejects(call('key_issue', {}, client(s.url)), /unknown board function key_issue/);
  assert.equal(s.seen.length, 0);
});

const until = async (what: () => boolean) => {
  for (const end = Date.now() + 5000; !what();) {
    assert.ok(Date.now() < end, 'it never happened');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('a stream hands over each event, ignores pings, and comes back after an end or a silence', async () => {
  const live: http.ServerResponse[] = [];
  const s = await stub((_r, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-cb-proto': '1' });
    res.write('event: listen\ndata: \n\n');
    live.push(res);
    return null;
  });
  const got: string[] = [];
  const stream = client(s.url).events(['cb', 'cb_bind'], (channel, data) => got.push(`${channel}=${data}`), { retryMs: 10, silenceMs: 400 });
  try {
    await until(() => got.length === 1);
    assert.deepEqual([s.seen[0]!.url, s.seen[0]!.headers.authorization], ['/w/v1/events?ch=cb&ch=cb_bind', `Bearer ${KEY}`]);
    // an event split across two packets, a ping between two, and Windows line ends
    live[0]!.write('event: cb\nda'); live[0]!.write('ta: 12\n\n: ping\n\nevent: cb_bind\r\ndata: boxa:p1\r\n\r\n');
    await until(() => got.length === 3);
    assert.deepEqual(got.slice(1), ['cb=12', 'cb_bind=boxa:p1']);
    live[0]!.end();
    await until(() => live.length === 2 && got.length === 4); // listen again: the caller checks what it missed
    await until(() => live.length === 3); // nothing for silenceMs: taken for dead
  } finally { stream.close(); }
  const n = s.seen.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.seen.length, n, 'a closed stream comes back no more');
});

test('a stream refused for its key ends for good and says so once', async () => {
  const s = await stub(() => ({ status: 401, body: { ok: false, code: 'unauthorized', error: 'no' } }));
  const refused: string[] = [];
  const stream = client(s.url).events(['cb'], () => {}, { retryMs: 10, refused: (e: Error) => refused.push(e.message) });
  await until(() => refused.length === 1);
  await new Promise((r) => setTimeout(r, 100));
  stream.close();
  assert.deepEqual([s.seen.length, refused.length], [1, 1]);
  assert.match(refused[0]!, /cb key check/);
});
