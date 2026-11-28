// The board's worker API for a test of a worker process: the real server in the test's own process, behind a proxy the
// test can make lose a reply or cut the notice streams. The key is made by the test database and thrown away with it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { chooseTransport, installKey } from '../cli/transport.ts';

const port = (s: any) => new Promise<number>((ok) => {
  const at = () => (s.address() as AddressInfo).port;
  if (s.listening) ok(at()); else s.once('listening', () => ok(at()));
});

export async function apiBoardFor() {
  const { app } = await import('../server/main.ts');
  const { sql: serverSql } = await import('../server/db.ts');
  const { closeWorker } = await import('../server/worker.ts');
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  const inner = await port(server);

  let lose: ((fn: string, result: unknown) => boolean) | null = null, cut = false;
  const streams = new Set<http.ServerResponse>();
  const seen: string[] = []; // the function of each call, as it arrived
  const proxy = http.createServer((req, res) => {
    const fn = /^\/w\/v1\/call\/(\w+)$/.exec(req.url ?? '')?.[1];
    const stream = req.url!.startsWith('/w/v1/events');
    if (stream && cut) return void req.socket.destroy();
    if (fn) seen.push(fn);
    const forward = http.request({ host: '127.0.0.1', port: inner, path: req.url, method: req.method, headers: req.headers }, (back) => {
      if (fn && lose) {
        let text = '';
        back.on('data', (d) => { text += d; });
        back.on('end', () => {
          // the board has done the call; the worker never hears it
          if (lose?.(fn, JSON.parse(text).result)) { lose = null; return void req.socket.destroy(); }
          res.writeHead(back.statusCode!, back.headers).end(text);
        });
        return;
      }
      res.writeHead(back.statusCode!, back.headers);
      back.pipe(res);
    });
    forward.on('error', () => res.destroy());
    if (stream) {
      streams.add(res);
      res.on('close', () => { streams.delete(res); forward.destroy(); });
    }
    req.pipe(forward);
  });
  proxy.listen(0, '127.0.0.1');
  const outer = await port(proxy);

  return {
    seen,
    /** The reply of the next call this says yes to is lost, after the board has run it. */
    loseReply: (which: (fn: string, result: unknown) => boolean) => { lose = which; },
    /** Ends every open stream and refuses new ones, until restoreStreams. */
    cutStreams: () => { cut = true; for (const s of streams) s.destroy(); },
    restoreStreams: () => { cut = false; },
    /** The environment of a worker process on this board, with `key` installed in dir. It names no database. */
    env(key: string, dir: string): Record<string, string | undefined> {
      installKey('runner', key, { CB_KEY_DIR: dir });
      const env = { CB_BOARD_URL: `http://127.0.0.1:${outer}`, CB_KEY_DIR: dir, CB_DATABASE_URL: undefined };
      // before any process starts with it: a worker that fell back to a database could reach one that is not the test's
      assert.equal(chooseTransport('runner', env, () => undefined).mode, 'api');
      return env;
    },
    async close() {
      proxy.closeAllConnections();
      proxy.close();
      (server as http.Server).closeAllConnections();
      server.close();
      await closeWorker();
      await serverSql.end();
    },
  };
}
