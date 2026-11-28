// The worker API (#3222 S2; D1: on the board's public HTTPS address): what cb, the relay, the hooks, the runner and the
// supervisor will call instead of Postgres. A worker signs in with its machine's key (Authorization: Bearer cbk1_...);
// nothing here reads a cookie. A call is a cb.* function that server/ops.ts lists for the key's kind, run in one
// transaction bound to the key: the connection's name (never the dashboard's), cb.client (stamped on every event), and
// for a write the key's machine and runner and an actor of that machine. A read runs read-only.
// A key, a call's arguments and a database address are never logged or sent back.
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { connect } from './db.ts';
import { OPS, type Kind } from './ops.ts';
import { selectFn } from './rpc.ts';
import { servedSha } from './release.ts';

const APP_NAME: Record<Kind, string> = { machine: 'cb-api/seat', runner: 'cb-runner/api', supervisor: 'cb-supervisor/api' };
const CHANNELS: Record<Kind, readonly string[]> = { machine: ['cb', 'cb_bind'], runner: ['cb_jobs'], supervisor: [] };
const KEY = /^Bearer cbk1_([0-9a-f]{10})_([A-Za-z0-9_-]{43})$/;
const MB = 1024 * 1024;
const MAX_STREAMS_PER_KEY = 64;
const pingMs = () => Number(process.env.CB_API_PING_MS) || 25_000;
const perMinute = () => Number(process.env.CB_API_RATE) || 1200;

// the workers' own pool: a burst of relays never takes the pages' connections
let pool: any = null;
const db = () => (pool ??= connect(undefined, { app: 'cb-api', max: 10 }));
export async function closeWorker() {
  const closing = pool;
  pool = null;
  await closing?.end();
}

type Who = { kind: Kind; machine: string; runner: string | null };
type Credential = { id: string; hash: Buffer };
type Status = 400 | 401 | 403 | 404 | 413 | 429 | 500 | 503;
type Reply = { status: Status; body: { ok: false; error: string; code?: string; detail?: string; hint?: string; never_ran?: true } };

class Refused extends Error {
  reply: Reply;
  constructor(status: Status, error: string, code?: string) {
    super(error);
    this.reply = { status, body: { ok: false, error, ...(code ? { code } : {}) } };
  }
}
const noSuchFunction = (name: string, why = 'does not exist') => new Refused(404, `function cb.${name} ${why}`, '42883');

// the database's own codes for taking no connection: too many, starting up, shutting down, the connection class
const NO_CONNECTION = /^(53300|57P0[123]|08...)$/;

/** The reply for a failed request. sent: the call may have reached the database. never_ran is the client's word that it
 *  is safe to try again, so it is said only before that. Nothing of an error's query, parameters or address goes out. */
export function failure(e: any, sent: boolean): Reply {
  if (e instanceof Refused) return e.reply;
  if (e?.name === 'PostgresError') {
    const body = { ok: false as const, code: e.code, error: e.message, ...(e.detail ? { detail: e.detail } : {}), ...(e.hint ? { hint: e.hint } : {}) };
    return !sent && NO_CONNECTION.test(e.code) ? { status: 503, body: { ...body, never_ran: true } } : { status: 400, body };
  }
  return sent ? { status: 500, body: { ok: false, error: 'server error' } }
    : { status: 503, body: { ok: false, error: 'the board database is not reachable', never_ran: true } };
}

const tag = (v: unknown) => v instanceof Date ? { $date: v.toISOString() } : Buffer.isBuffer(v) ? { $bytes: v.toString('base64') } : v;
/** JSON loses a time and bytes: the result itself, or a row's own column, is tagged for the client to turn back. Nothing
 *  deeper is touched, so a jsonb value arrives as it is stored. */
export function wire(result: any, rows: boolean): any {
  if (!rows) return tag(result);
  return Array.from(result as any[], (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, tag(v)])));
}
const untag = (v: any) => v && typeof v === 'object' && typeof v.$bytes === 'string' && Object.keys(v).length === 1 ? Buffer.from(v.$bytes, 'base64') : v;

/** The key's owner, or 401. Runs on the pool or inside a call's transaction (a key revoked meanwhile is refused). */
async function whoIs(conn: any, key: Credential, from: string | null): Promise<Who> {
  try {
    const [row] = await conn`select cb.key_check(${key.id}, ${key.hash}, ${from}) as who`;
    return row.who as Who;
  } catch (e: any) {
    if (e?.name === 'PostgresError' && e.code === '28000') throw new Refused(401, 'unknown or revoked worker key');
    throw e;
  }
}

// ponytail: counted per process and per minute, in memory, like the login limit: one board server serves the workers
const windows = new Map<string, { from: number; n: number }>();
/** Seconds until the key may call again, or 0. */
function overLimit(id: string, now = Date.now()): number {
  let w = windows.get(id);
  if (!w || now - w.from >= 60_000) windows.set(id, (w = { from: now, n: 0 }));
  return ++w.n > perMinute() ? Math.max(1, Math.ceil((w.from + 60_000 - now) / 1000)) : 0;
}

/** The request body, read no further than `max`. */
async function readBody(c: Context<any>, max: number): Promise<string> {
  const tooBig = () => new Refused(413, `the request is over ${max / MB} MB`);
  if (Number(c.req.header('content-length') ?? 0) > max) throw tooBig();
  const reader = c.req.raw.body?.getReader();
  const parts: Uint8Array[] = [];
  for (let size = 0; reader;) {
    const { value, done } = await reader.read();
    if (done) break;
    if ((size += value.length) > max) { void reader.cancel().catch(() => {}); throw tooBig(); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

async function argsOf(c: Context<any>, max: number): Promise<Record<string, unknown>> {
  const text = await readBody(c, max);
  let args: unknown;
  try { args = JSON.parse(text)?.args; } catch {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Refused(400, 'the body is {"args": {...}}');
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, untag(v)]));
}

// a function's argument names and whether it writes, as the database has them (the schema is applied before the server starts)
type Signature = { writes: boolean; args: Set<string> };
const signatures = new Map<string, Signature>();
async function signature(conn: any, fn: string): Promise<Signature> {
  const known = signatures.get(fn);
  if (known) return known;
  const found = await conn`select p.provolatile = 'v' as writes,
      case when p.proargmodes is null then p.proargnames
           else array(select p.proargnames[i] from generate_subscripts(p.proargmodes, 1) i where p.proargmodes[i] in ('i', 'b', 'v')) end as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cb' and p.proname = ${fn}`;
  if (!found.length) throw noSuchFunction(fn, 'is not in this board\'s database: deploy the board first');
  const made = { writes: found.some((f: any) => f.writes), args: new Set<string>(found.flatMap((f: any) => f.args ?? [])) };
  signatures.set(fn, made);
  return made;
}

/** A write is the key's own: its machine and runner, filled in or refused when another is named, and an actor it may be. */
async function bind(tx: any, who: Who, sig: Signature, args: Record<string, unknown>, machineIsLabel: boolean) {
  const own = (name: 'machine' | 'runner', value: string | null) => {
    if (!sig.args.has(name) || value === null) return;
    if (args[name] != null && args[name] !== value) throw new Refused(403, `this key is for ${name} ${value}: it cannot write as another`);
    args[name] = value;
  };
  if (!machineIsLabel) own('machine', who.machine);
  if (who.kind === 'runner') own('runner', who.runner);
  if (!sig.args.has('actor')) return;
  const actor = args.actor;
  const [row] = typeof actor === 'string' ? await tx`select cb._actor_ok(${who.kind}, ${who.machine}, ${actor}) as ok` : [];
  if (!row?.ok) {
    throw new Refused(403, who.kind === 'machine' ? `a write with this key names an actor of its machine, like name@${who.machine} (--as), never the owner`
      : `a ${who.kind} key cannot write as this actor`);
  }
}

type Subscriber = (channel: string, payload: string) => void;
const subscribers = new Set<Subscriber>();
/** What the server's LISTEN heard, to every open worker stream; 'listen': it (re)connected, so each worker looks again. */
export const notify = (channel: string, payload = '') => subscribers.forEach((send) => send(channel, payload));
const streams = new Map<string, number>();

/** The routes under /w/v1. listen: the server's one LISTEN, started when the first stream opens. */
export function workerApp(listen: () => Promise<unknown>) {
  const w = new Hono();
  w.use('*', async (c, next) => {
    c.header('X-CB-Proto', '1');
    await next();
  });

  type Signed = { key: Credential; who: Who; from: string | null; ran: () => void };
  /** Signs the request in, counts it, runs `run`, and writes one log line. */
  const signedIn = (label: (c: Context<any>) => string, run: (c: Context<any>, s: Signed) => Promise<Response>) => async (c: Context<any>) => {
    const started = Date.now();
    const m = KEY.exec(c.req.header('authorization') ?? '');
    let sent = false, why = '', res: Response;
    try {
      if (!m) throw new Refused(401, 'a worker key is needed: Authorization: Bearer cbk1_...');
      const key = { id: m[1]!, hash: createHash('sha256').update(m[2]!).digest() };
      const from = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim().slice(0, 64) || null;
      const who = await whoIs(db(), key, from);
      const release = servedSha();
      if (release) c.header('X-CB-Code', release); // only a signed-in worker is told what the board runs
      const wait = overLimit(key.id);
      if (wait) {
        c.header('Retry-After', String(wait));
        throw new Refused(429, `too many requests with this key: try again in ${wait} s`);
      }
      res = await run(c, { key, who, from, ran: () => { sent = true; } });
    } catch (e: any) {
      const reply = failure(e, sent);
      res = c.json(reply.body, reply.status);
      // the code alone says what broke; a message can hold an address or an argument
      if (reply.status >= 500) why = ` ${String((e as any)?.code ?? (e as any)?.name).replace(/[^\w]/g, '').slice(0, 40)}`;
    }
    console.log(`worker api: key ${m?.[1] ?? '-'} ${label(c)} ${res.status} ${Date.now() - started}ms${why}`);
    return res;
  };

  w.get('/hello', signedIn(() => 'hello', async (c, { key, who }) =>
    c.json({ ok: true, key: key.id, kind: who.kind, machine: who.machine, runner: who.runner, release: servedSha() ?? null })));

  // the label is the function's name only when it is listed: the path is the caller's text
  const named = (c: Context<any>) => Object.hasOwn(OPS, c.req.param('fn')!) ? c.req.param('fn')! : 'unlisted';
  w.post('/call/:fn', signedIn(named, async (c, { key, who, from, ran }) => {
    const fn = c.req.param('fn')!;
    const op = Object.hasOwn(OPS, fn) ? OPS[fn]! : null;
    if (!op || !op.kinds.length) throw noSuchFunction(/^[a-z_]{1,63}$/.test(fn) ? fn : '(that name)');
    if (!op.kinds.includes(who.kind)) throw new Refused(403, `a ${who.kind} key cannot call cb.${fn}`);
    const args = await argsOf(c, op.bytes ? 32 * MB : MB);
    const result = await db().begin(async (tx: any) => {
      const now = await whoIs(tx, key, from);
      await tx.unsafe(`set local application_name = '${APP_NAME[now.kind]}'`); // one of three constants
      await tx`select set_config('cb.client', ${key.id}, true), set_config('statement_timeout', '30s', true)`;
      const sig = await signature(tx, fn);
      if (sig.writes) await bind(tx, now, sig, args, !!op.machineLabel);
      else await tx`set transaction read only`; // a read may name any actor, so it must not be able to write
      ran();
      return selectFn(tx, fn, args, !!op.setof);
    });
    return c.json({ ok: true, result: wire(result, !!op.setof) });
  }));

  w.get('/events', signedIn(() => 'events', async (c, { key, who }) => {
    const wanted = c.req.queries('ch') ?? [];
    if (!wanted.length || !wanted.every((ch) => CHANNELS[who.kind].includes(ch))) {
      throw new Refused(403, `a ${who.kind} key listens on: ${CHANNELS[who.kind].join(', ') || 'nothing'}`);
    }
    if ((streams.get(key.id) ?? 0) >= MAX_STREAMS_PER_KEY) throw new Refused(429, 'too many open streams with this key');
    await listen();
    c.header('X-Accel-Buffering', 'no'); // nginx would otherwise hold the events back
    return streamSSE(c, async (stream) => {
      const send: Subscriber = (channel, payload) => {
        if (channel !== 'listen' && !wanted.includes(channel)) return;
        if (channel === 'cb_bind' && !payload.startsWith(`${who.machine}:`)) return; // "machine:pane"
        stream.writeSSE({ event: channel, data: payload }).catch(() => {});
      };
      subscribers.add(send);
      streams.set(key.id, (streams.get(key.id) ?? 0) + 1);
      try {
        await stream.writeSSE({ event: 'listen', data: '' });
        while (!stream.aborted) {
          await stream.sleep(pingMs());
          // a revoked key's stream ends here; so does one that cannot be checked (the worker connects again)
          if (stream.aborted || !(await whoIs(db(), key, null).then(() => true, () => false))) break;
          await stream.write(': ping\n\n').catch(() => {});
        }
      } finally {
        subscribers.delete(send);
        const left = streams.get(key.id)! - 1;
        if (left) streams.set(key.id, left); else streams.delete(key.id);
      }
    });
  }));

  return w;
}
