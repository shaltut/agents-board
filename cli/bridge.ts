// cb through its session's relay (2026-11-18 slowness work). A cb call used to open its own connection to the board:
// TCP, SCRAM sign-in and postgres.js's type fetch are ~5 round trips before the first query, ~650 ms from the PC or
// the Mac to the VPS, then 2 round trips per query (describe, execute). The session's relay already holds an open
// connection with its statements prepared, so cb hands its calls to the relay over a local socket instead. A call is
// a board function's name and its arguments (#3222, v2), never SQL: the relay runs only what server/ops.ts lists.
//
// Only the relay's own machine user can use it: the socket (a named pipe on Windows) is announced in a file in the
// user's temp dir, with a random token every request must carry. A cb pointed at another database (a test run inside
// a live session inherits its socket) is refused, and connects itself as before. So is a cb with no relay: an old
// relay, a plain terminal, a relay that is restarting.
import net from 'node:net';
import v8 from 'node:v8';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call } from './board.ts';

const V = 2; // bump when a message changes: an older relay is then refused and cb connects itself

/** The relay's per-seat key: the same for every process on one machine and pane, whatever agent runs there. */
export const seatKey = (machine: string, pane: string) => createHash('sha1').update(`${machine.trim().toLowerCase()}:${pane.trim()}`).digest('hex').slice(0, 12);

/** The relay holding a seat lock (cli/relay.ts LOCK), or 0. Held = its pid answers AND the file was touched in the last
 *  15 s (a running relay touches it every 2 s): a lock a relay left behind names a pid Windows may have reused. */
export function seatLockHolder(lock: string): number {
  try {
    const pid = Number(readFileSync(lock, 'utf8')) || 0;
    if (pid <= 0 || Date.now() - statSync(lock).mtimeMs > 15_000) return 0;
    process.kill(pid, 0);
    return pid;
  } catch { return 0; }
}

export function bridgeFiles(key: string) {
  return {
    info: join(tmpdir(), `cb-relay-${key}.bridge`),
    socket: process.platform === 'win32' ? String.raw`\\.\pipe\cb-relay-bridge-` + key : join(tmpdir(), `cb-relay-${key}.bridge.sock`),
  };
}
const urlId = (url: string) => createHash('sha256').update(url).digest('hex');

/** Length-prefixed v8 frames: Dates, Buffers and nested jsonb survive as they are. */
function framed(sock: net.Socket, onMessage: (m: any) => void) {
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0), body = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      let m; try { m = v8.deserialize(body); } catch { sock.destroy(); return; }
      onMessage(m);
    }
  });
  return (m: any) => { const b = v8.serialize(m); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); sock.write(Buffer.concat([h, b])); };
}

// syscall: cb retries a timed-out or unreachable board only when it came from connect() (connect-retry.ts, #4337)
const errorOut = (e: any) => ({ message: String(e?.message ?? e), name: e?.name, code: e?.code, syscall: e?.syscall, detail: e?.detail, hint: e?.hint, severity: e?.severity });

/** What the relay adds (#3256): binding(who) is the pane's cb iam binding when the relay holds it, handed over with
 *  the hello so cb skips its own lookup; served(fn) is told each call it ran, once it returned. */
export type BridgeOpts = { binding?: (who: { machine: string; pane: string }) => unknown; served?: (fn: string) => void };

const REQUEST = new Set(['id', 'fn', 'args']);
/** A request is a function's name and its arguments, nothing beside them. */
const isCall = (m: any) => typeof m?.fn === 'string' && !!m.args && typeof m.args === 'object' && !Array.isArray(m.args)
  && Object.keys(m).every((k) => REQUEST.has(k));

/** The relay's side: run each request on its connection. Returns stop(). */
export async function serveBridge(sql: any, key: string, url: string, log: (m: string) => void = () => {}, opts: BridgeOpts = {}) {
  const files = bridgeFiles(key);
  // prepared, unlike a plain unsafe: the text is a function's name and its argument names (the values are
  // parameters), a small fixed set, so after its first call each is one round trip instead of two
  const board = sql.api ? sql
    : { unsafe: (text: string, values: any[]) => sql.unsafe(text, values, values.length ? { prepare: true } : {}) };
  const token = randomBytes(24).toString('hex');
  const open = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    open.add(sock); sock.on('close', () => open.delete(sock));
    let ok = false, served = 0;
    const send = framed(sock, async (m) => {
      if (!ok) { // the first message: who is asking, for which database
        const good = m?.v === V && typeof m.token === 'string' && m.token.length === token.length &&
          timingSafeEqual(Buffer.from(m.token), Buffer.from(token)) && m.url === urlId(url);
        const binding = good && m.who ? opts.binding?.(m.who) : undefined;
        send(binding === undefined ? { ok: good } : { ok: good, binding });
        if (good) ok = true; else sock.end();
        return;
      }
      const id = m?.id;
      try {
        if (!isCall(m)) throw new Error('the relay bridge carries a board function\'s name and its arguments, nothing else');
        const result = await call(m.fn, m.args, board);
        served++;
        opts.served?.(m.fn);
        // rows as a plain array: cb reads rows, never .count or .columns
        send({ id, result: Array.isArray(result) ? [...result] : result });
      } catch (e) {
        send({ id, error: errorOut(e) });
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => served && log(`bridge: served ${served} call${served === 1 ? '' : 's'}`));
  });
  if (process.platform !== 'win32') rmSync(files.socket, { force: true }); // a relay that died left it
  // a relay handing over to its successor may still hold a Windows pipe name for a moment
  for (let i = 0; ; i++) {
    try { await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(files.socket, () => { server.off('error', rej); res(); }); }); break; }
    catch (e) { if (i >= 10) throw e; await new Promise((r) => setTimeout(r, 300)); }
  }
  if (process.platform !== 'win32') chmodSync(files.socket, 0o600);
  writeFileSync(files.info, JSON.stringify({ socket: files.socket, token, pid: process.pid }), { mode: 0o600 });
  return () => {
    try { if (JSON.parse(readFileSync(files.info, 'utf8')).pid === process.pid) rmSync(files.info, { force: true }); } catch {}
    const closed = new Promise<void>((r) => server.close(() => r()));
    for (const s of open) s.destroy(); // a cb mid-query hears RELAY_LOST at once
    return closed;
  };
}

/** cb's side: a connection call() (cli/board.ts) can run on, or null if there is no relay to use. */
export async function openBridge(key: string, url: string, who?: { machine: string; pane: string }): Promise<any> {
  const files = bridgeFiles(key);
  let info: any;
  try { info = JSON.parse(readFileSync(files.info, 'utf8')); } catch { return null; }
  const sock = net.connect(info.socket);
  const pending = new Map<number, { res: (r: any) => void; rej: (e: any) => void }>();
  let hello: ((ok: boolean) => void) | undefined, binding: unknown;
  const helloOk = new Promise<boolean>((r) => { hello = r; });
  const send = framed(sock, (m) => {
    if (hello) { const h = hello; hello = undefined; binding = m.binding; return h(!!m.ok); }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id);
    if (m.error) p.rej(Object.assign(new Error(m.error.message), m.error)); else p.res(m.result);
  });
  const lost = () => {
    hello?.(false); hello = undefined;
    // the relay went away mid-query: whether a write landed is unknown, so say so rather than run it again
    for (const p of pending.values()) p.rej(Object.assign(new Error('the session relay closed mid-query: check with cb before retrying'), { code: 'RELAY_LOST' }));
    pending.clear();
  };
  sock.on('error', lost); sock.on('close', lost);
  sock.once('connect', () => send({ v: V, token: info.token, url: urlId(url), ...(who ? { who } : {}) }));
  const timer = setTimeout(() => hello?.(false), 500); // a wedged relay must not cost more than the connect it saves
  const ok = await helloOk;
  clearTimeout(timer);
  if (!ok) { sock.destroy(); return null; }
  sock.unref(); // like a postgres.js pool: an open bridge alone does not keep cb running

  let n = 0;
  const ask = (fn: string, args: Record<string, unknown>) => new Promise<any>((res, rej) => {
    if (sock.destroyed) return rej(Object.assign(new Error('the session relay is gone'), { code: 'RELAY_LOST' }));
    const id = ++n; pending.set(id, { res, rej }); sock.ref();
    send({ id, fn, args });
  }).finally(() => { if (!pending.size) sock.unref(); });
  const db: any = { api: ask };
  db.end = async () => { sock.end(); };
  db.binding = binding; // this pane's { actor, project } as the relay holds it; undefined: look it up
  return db;
}
