// cb's one way to the board (#3222): a named cb.* function with named arguments, and nothing else. The call runs on
// Postgres, direct or through the session relay's bridge, or on the board's worker API (apiBoard, S3).
// A board key is never logged, printed, copied or put in an error.
import http from 'node:http';
import https from 'node:https';
import { OPS } from '../server/ops.ts';
import { RpcError, selectFn } from '../server/rpc.ts';
import { boardUrl, readKey } from './transport.ts';

let board: any;
/** The connection calls run on: cb's own, or its session relay's bridge. */
export const useBoard = (db: any) => { board = db; };

export async function call(fn: string, args: Record<string, unknown> = {}, db: any = board): Promise<any> {
  if (!Object.hasOwn(OPS, fn)) throw new RpcError(404, `unknown board function ${fn}: list it in server/ops.ts`);
  const rows = !!OPS[fn]!.setof;
  return db.api ? db.api(fn, args, rows) : selectFn(db, fn, args, rows);
}

export type ApiOpts = { url: string; keyFile: string; code: string; connectTimeoutMs?: number; replyTimeoutMs?: number };
export type StreamOpts = { retryMs?: number; silenceMs?: number; refused?: (e: Error) => void };

const error = (code: string, message: string) => Object.assign(new Error(message), { code });

/** The error a reply that is not a success stands for. mine: the board wrote it (it carries x-cb-proto), not a proxy
 *  on the way. CB_NOT_RUN is safe to send again (connect-retry.ts); CB_NO_ANSWER may have run. */
function refusal(status: number, mine: boolean, body: any): Error {
  const said = mine && typeof body?.error === 'string' ? body.error : '';
  if (status === 429 || (status === 503 && mine && body?.never_ran === true)) {
    return error('CB_NOT_RUN', `the board did not take the call (${status}${said ? `: ${said}` : ''})`);
  }
  if (status === 401) {
    return error('CB_KEY_REFUSED', 'the board refused this machine\'s key (401): run cb key check; if it was revoked, ask the owner for a new one');
  }
  if (status >= 400 && status < 500 && said) {
    // a SQLSTATE: the error the database would have thrown, which the 42883 fallbacks and the runner read. The server's
    // own refusals (another machine's actor, too big) carry no code
    const code = typeof body.code === 'string' ? body.code : 'CB_REFUSED';
    const database = /^[0-9A-Z]{5}$/.test(code);
    return Object.assign(error(code, said), database ? { name: 'PostgresError', detail: body.detail, hint: body.hint } : {});
  }
  if (said) return error('CB_NO_ANSWER', `the board failed (${status}: ${said})`);
  return error('CB_NO_ANSWER', `no answer from the board (${status}): if this repeats, check CB_BOARD_URL`);
}

/** The board writes {$date} and {$bytes} for the result itself or a row's own column, never deeper: a jsonb value that
 *  holds such a key stays as it is. */
function revive(v: any): any {
  if (v && typeof v === 'object' && Object.keys(v).length === 1) {
    if (typeof v.$date === 'string') return new Date(v.$date);
    if (typeof v.$bytes === 'string') return Buffer.from(v.$bytes, 'base64');
  }
  return v;
}
const reviveRow = (row: object) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, revive(v)]));
const wire = (v: unknown) => (v === undefined ? null : v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString('base64') } : v);
const parsed = (text: string): any => { try { return JSON.parse(text); } catch { return undefined; } };

/** The worker API as a board call() can run on. The key is read for every request, so a new one takes effect at once.
 *  Redirects are never followed: the key goes to url only. */
export function apiBoard(o: ApiOpts) {
  const base = boardUrl(o.url); // here too, whoever calls: the key goes only where it may travel
  const secure = base.startsWith('https:');
  const lib = secure ? https : http;
  // one connection for a command's calls; an idle one is dropped before the server drops it under us (5 s)
  const agent = new lib.Agent({ keepAlive: true, timeout: 4000 });

  function send(method: string, path: string, via: http.Agent | false, body?: string): http.ClientRequest {
    const req = lib.request(base + path, {
      method, agent: via,
      headers: {
        authorization: `Bearer ${readKey(o.keyFile)}`, 'x-cb-proto': '1', 'x-cb-code': o.code,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
      },
    });
    // a connection that never finished carried nothing, so this one error is safe to send again
    req.once('socket', (socket) => {
      if (req.reusedSocket) return;
      const t = setTimeout(() => req.destroy(error('CONNECT_TIMEOUT', 'the connection to the board timed out: check CB_BOARD_URL and that the board is up (cb key check)')), o.connectTimeoutMs ?? 5000);
      const done = () => clearTimeout(t);
      socket.once(secure ? 'secureConnect' : 'connect', done);
      req.once('close', done);
    });
    return req;
  }

  const read = (res: http.IncomingMessage) => new Promise<string>((ok, fail) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
    res.on('end', () => ok(text));
    res.on('error', fail);
  });

  async function exchange(method: string, path: string, body?: string): Promise<any> {
    const req = send(method, path, agent, body);
    const timer = setTimeout(() => req.destroy(error('CB_NO_ANSWER', 'the board did not answer in time: if this repeats, check CB_BOARD_URL and ask it with cb key check')), o.replyTimeoutMs ?? 60_000);
    try {
      const res = await new Promise<http.IncomingMessage>((ok, fail) => {
        req.on('response', ok);
        req.on('error', fail);
        req.end(body);
      });
      const reply = parsed(await read(res)), mine = !!res.headers['x-cb-proto'];
      if (res.statusCode === 200 && mine && reply?.ok === true) return reply;
      throw refusal(res.statusCode!, mine, reply);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async api(fn: string, args: Record<string, unknown>, rows: boolean): Promise<any> {
      const body = JSON.stringify({ args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, wire(v)])) });
      const { result } = await exchange('POST', `/w/v1/call/${fn}`, body);
      return rows ? result.map(reviveRow) : revive(result);
    },
    /** Who the key is: { ok, key, kind, machine, runner, release }. */
    hello: (): Promise<any> => exchange('GET', '/w/v1/hello'),
    /** The board's notices as server-sent events, on a connection of their own. on() also gets 'listen' each time the
     *  stream (re)starts: what was said meanwhile is then looked up. A stream that ends or goes silent is reopened,
     *  1 to 30 s later; one the board refuses (401, 403) ends for good. */
    events(channels: string[], on: (channel: string, data: string) => void, so: StreamOpts = {}) {
      const first = so.retryMs ?? 1000, silence = so.silenceMs ?? 60_000; // the board pings every 25 s
      const path = `/w/v1/events?${channels.map((c) => `ch=${encodeURIComponent(c)}`).join('&')}`;
      let closed = false, delay = first, req: http.ClientRequest | undefined, quiet: NodeJS.Timeout, later: NodeJS.Timeout;
      const open = () => {
        let over = false;
        const again = () => {
          if (over) return;
          over = true;
          clearTimeout(quiet);
          req?.destroy();
          if (closed) return;
          later = setTimeout(open, delay);
          delay = Math.min(delay * 2, 30_000);
        };
        const heard = () => { clearTimeout(quiet); quiet = setTimeout(again, silence); };
        try { req = send('GET', path, false); } catch { return again(); } // the key file is being replaced
        heard();
        req.on('error', again);
        req.on('response', (res) => {
          const mine = !!res.headers['x-cb-proto'];
          if (res.statusCode !== 200 || !mine) {
            read(res).then((text) => {
              // only the board's own refusal ends the stream: something on the way may refuse for a while
              if (over || !mine || (res.statusCode !== 401 && res.statusCode !== 403)) return again();
              over = closed = true;
              clearTimeout(quiet);
              so.refused?.(refusal(res.statusCode!, mine, parsed(text)));
            }, again);
            return;
          }
          let buffer = '', event = '', data: string[] = [];
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            heard();
            buffer += chunk;
            for (let end = buffer.indexOf('\n'); end >= 0 && !over; end = buffer.indexOf('\n')) {
              const line = buffer.slice(0, end).replace(/\r$/, '');
              buffer = buffer.slice(end + 1);
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
              else if (line === '') {
                if (event === 'listen') delay = first;
                if (event) on(event, data.join('\n'));
                event = '';
                data = [];
              }
            }
            if (buffer.length > 1_000_000) again(); // no notice is that long
          });
          res.on('end', again);
          res.on('error', again);
        });
        req.end();
      };
      open();
      return { close: () => { closed = true; clearTimeout(quiet); clearTimeout(later); req?.destroy(); } };
    },
    end: async () => agent.destroy(),
  };
}
