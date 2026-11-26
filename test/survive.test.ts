// #3902: in the 11-25 internet drop the PC runner exited on an unhandled "read ECONNRESET" (a dropped board connection
// surfacing as an error nothing awaited) and stayed down 20 minutes with 33 jobs queued. A lost connection is weather:
// log it and carry on (postgres.js reconnects on the next query, sql.listen re-subscribes). Anything else still exits
// loudly, as before. Pure: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isNetworkError } from '../cli/survive.ts';

const net = (code: string) => Object.assign(new Error(`read ${code}`), { code });

test('isNetworkError: dropped, refused, unreachable and timed-out connections, and postgres.js connection errors', () => {
  for (const c of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN',
    'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT', '57P01', '57P03']) assert.equal(isNetworkError(net(c)), true, c);
  for (const e of [new TypeError('x is undefined'), net('ENOENT'), net('EACCES'), Object.assign(new Error('dup'), { code: '23505' }), null, 'ECONNRESET'])
    assert.equal(isNetworkError(e), false, String(e));
  // wrapped: an AggregateError or a cause
  assert.equal(isNetworkError(new AggregateError([net('ECONNREFUSED')], 'all failed')), true);
  assert.equal(isNetworkError(new Error('query failed', { cause: net('ECONNRESET') })), true);
});

const child = (body: string) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { survive } from ${JSON.stringify(new URL('../cli/survive.ts', import.meta.url).href)};
  survive((l) => console.log(l));
  ${body}`], { encoding: 'utf8', timeout: 20_000 });

test('survive: an uncaught or unhandled lost connection is logged and the process goes on', () => {
  const r = child(`
    setTimeout(() => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); }, 10);
    Promise.reject(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    setTimeout(() => console.log('still running'), 200);`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lost the board connection: read ECONNRESET \(ECONNRESET\); carrying on/);
  assert.match(r.stdout, /lost the board connection: write EPIPE \(EPIPE\); carrying on/);
  assert.match(r.stdout, /still running/);
});

test('survive: any other uncaught error still ends the process, non-zero, with the error said', () => {
  const r = child(`setTimeout(() => { throw new TypeError('cfg.slots is undefined'); }, 10); setTimeout(() => console.log('never'), 500);`);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /never/);
  assert.match(r.stdout + r.stderr, /cfg\.slots is undefined/);
});
