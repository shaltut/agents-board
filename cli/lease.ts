// #3222 slice S5: the supervisor's lease, in place of a session advisory lock: one supervisor anywhere. A row on the board
// (cb.leases), taken for 180 s and renewed by its token, so it needs no database session of its own and works the same
// over an API. Renewed on its own timer, on a thread of its own, apart from the tick.
import { Worker } from 'node:worker_threads';
import { DeadlineError, withDeadline } from './deadline.ts';
import type { Runner } from './squad-up.ts';

export const RENEW_MS = 30_000;
// how long after the last renewal the lease is still counted on: the board gives 180 s, less room for a late answer
export const SURE_MS = 150_000;
const ANSWER_MS = 20_000;
// the two numbers the renewal thread shares with the main thread: counted on until (ms since 1970); 1 once refused
export const UNTIL = 0, REFUSED = 1;
const msg = (e: unknown) => ((e as Error)?.message ?? String(e)).trim();

export type Lease = {
  /** null: held now (taken or renewed); else why it is not ours. Throws when the board does not answer. */
  keep: () => Promise<string | null>;
  holds: () => boolean;
  /** the held lease's token, for the thread that renews it; null when not held */
  token: () => string | null;
  /** renewed lately enough that no other can have taken it */
  sure: () => boolean;
  /** until when that holds, ms since 1970 */
  sureUntil: () => number;
  release: () => Promise<void>;
};

/** token: a lease just taken elsewhere (the renewal thread is given the main thread's). */
export function supervisorLease(o: { connect: () => any; holder: string; clock?: () => number; token?: string; sureMs?: number }): Lease {
  const clock = o.clock ?? Date.now, sureMs = o.sureMs ?? SURE_MS;
  let sql = o.connect(), token: string | null = o.token ?? null, sureFrom = o.token ? clock() : -Infinity, givenBack = false;
  const ask = async (query: (s: any) => PromiseLike<any>) => {
    try { return (await withDeadline(Promise.resolve(query(sql)), ANSWER_MS, 'the supervisor lease'))[0]; }
    catch (e) { // #4261: a query that hangs means a connection that may never error: drop it, ask on a fresh one
      if (e instanceof DeadlineError) { const old = sql; sql = o.connect(); old.end({ timeout: 0 }).catch(() => {}); }
      throw e;
    }
  };
  return {
    async keep() {
      if (givenBack) throw new Error('the supervisor lease was given back: this supervisor is stopping');
      const asked = clock(); // from before the question: the board's 180 s starts no earlier
      if (token) {
        if (!(await ask((s) => s`select cb.lease_renew('supervisor', ${token}) as ok`)).ok) return "the supervisor lease is no longer this supervisor's: another took it";
      } else {
        const { r } = await ask((s) => s`select cb.lease_take('supervisor', ${o.holder}) as r`);
        if (!r.token) return `another supervisor is running: ${r.holder} holds the lease, for ${r.left_s} s more unless it renews it`;
        token = r.token;
      }
      sureFrom = asked;
      return null;
    },
    holds: () => token !== null,
    token: () => token,
    sure: () => clock() < sureFrom + sureMs,
    sureUntil: () => sureFrom + sureMs,
    async release() { // at exit: the next start need not wait the lease out. A board that is away: it runs out by itself
      const mine = token;
      givenBack = true; token = null; // at once: neither the timer nor the loop asks for it while it goes
      if (mine) await ask((s) => s`select cb.lease_release('supervisor', ${mine}) as ok`).catch(() => {});
      await sql.end({ timeout: 5 }).catch(() => {});
    },
  };
}

/** The renewal on its own timer. The board saying the lease is not ours: the tick is aborted, then lost (which exits). A
 *  board that does not answer is not that (a restart, a deploy): asked again next time, and the tick is aborted once the
 *  lease can no longer be counted on. Answers the function that stops it. */
export function keepAlive(lease: Lease, o: { every?: number; silent?: () => boolean; kept?: () => void; abort: () => void; lost: (why: string) => void; say: (line: string) => void }) {
  const every = o.every ?? RENEW_MS;
  let asking = false, quiet = false;
  const timer = setInterval(async () => {
    if (asking || !lease.holds()) return;
    if (o.silent?.()) { // the one it renews for is hung: the lease runs out, so another can take over
      if (!quiet) { o.say("nothing from the supervisor's main thread for too long: the lease is not renewed until it speaks again"); o.abort(); }
      quiet = true;
      return;
    }
    quiet = false;
    asking = true;
    try {
      const why = await lease.keep();
      if (why) { clearInterval(timer); o.abort(); o.lost(why); } else o.kept?.();
    } catch (e) {
      o.say(`the supervisor lease was not renewed (${msg(e)}): trying again in ${Math.round(every / 1000)} s`);
      if (!lease.sure()) o.abort();
    } finally { asking = false; }
  }, every);
  return () => clearInterval(timer);
}

/** keepAlive on a thread of its own, for a held lease's token. A seat's start holds the main thread (its herdr calls and
 *  pauses are synchronous), longer than the lease lasts when the first prompt stalls. It renews only while the main
 *  thread speaks (beat(), which gets through even from a thread about to be held): after silentMs with no word it stops,
 *  until the next one. What the thread reports is acted on when the main thread is free again. A thread that fails or
 *  ends is a lease nobody renews: abort, then lost. After stop() nothing is reported. */
export function keepAliveApart(token: string, o: { app: string; every?: number; silentMs: number; sureMs?: number; abort: () => void; lost: (why: string) => void; say: (line: string) => void }) {
  const shared = new BigInt64Array(new SharedArrayBuffer(2 * BigInt64Array.BYTES_PER_ELEMENT));
  Atomics.store(shared, UNTIL, BigInt(Date.now() + (o.sureMs ?? SURE_MS))); // the lease was taken just now
  const thread = new Worker(new URL('./lease-worker.ts', import.meta.url),
    { workerData: { token, app: o.app, every: o.every, silentMs: o.silentMs, sureMs: o.sureMs, shared } });
  let over = false;
  const gone = (why: string) => { if (over) return; over = true; o.abort(); o.lost(why); };
  thread.on('message', ([what, line]: [string, string]) => {
    if (over) return;
    if (what === 'abort') o.abort();
    else if (what === 'say') o.say(line);
    else { over = true; o.lost(line); }
  });
  thread.on('error', (e) => gone(`the lease renewal thread failed: ${msg(e)}`));
  thread.on('exit', (code) => gone(`the lease renewal thread ended (${code})`));
  return {
    beat: () => { thread.postMessage('beat'); },
    // read from the memory the thread writes, so it answers while this thread is held. Until-times only move with a
    // renewal that answered, and run out before the board lets another take the lease
    sure: () => !over && Atomics.load(shared, REFUSED) === 0n && Date.now() < Number(Atomics.load(shared, UNTIL)),
    stop: async () => { over = true; await thread.terminate(); },
  };
}

/** Every herdr call of the supervisor goes through this: a word to the renewal thread, then the question whether the
 *  lease still stands. While a seat's start holds the main thread, what the thread reports waits in the queue, so each
 *  call asks for itself. A call already running is not cut off. No renewal (a dry run): as it is. */
export const fenced = (run: Runner, renewal: () => { beat(): void; sure(): boolean } | undefined): Runner => (m, args, timeout) => {
  const r = renewal();
  if (r) {
    r.beat();
    if (!r.sure()) throw new Error('the supervisor lease cannot be counted on: no herdr call is made');
  }
  return run(m, args, timeout);
};
