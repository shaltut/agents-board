// #4337: a board that is briefly unreachable (the machine waking, a Tailscale relay hiccup, a board restart) used to
// fail the call at once, so every script wrapped cb in its own retry loop, and a blind resend of a write could run it
// twice. cb now retries one statement, and only when the error proves the statement never left this machine: the
// connection to the board was refused, timed out or never resolved before any query was written. A failure after a
// statement was sent (a reset, a read timeout, a closed connection, the relay lost mid-query) is never retried: a
// write may have landed, and task_add or ask would run twice.

// The connection never opened, whatever the syscall: refused, DNS, postgres.js's own connect timer (it is cancelled at
// the first ReadyForQuery, before postgres.js executes the query that opened the connection).
const BEFORE_CONNECT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'CONNECT_TIMEOUT']);
// These also happen on an open socket (after a write), so only when Node says they came from connect() itself.
// Through the relay bridge an older relay forwards no syscall: then they are not retried.
const ON_CONNECT = new Set(['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']);

/** True only when the error shows no statement could have reached the board. */
export function neverSent(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; syscall?: unknown; message?: unknown; errors?: unknown[] };
  // Node's happy-eyeballs connect (several addresses) fails with an AggregateError: every attempt must be pre-send
  if (Array.isArray(err.errors) && err.errors.length) return err.errors.every(neverSent);
  if (typeof err.code !== 'string') return false;
  if (BEFORE_CONNECT.has(err.code)) return true;
  if (ON_CONNECT.has(err.code) && (err.syscall === 'connect' || err.syscall === 'getaddrinfo')) return true;
  // TLS never finished, so nothing after it (startup, the query) was written
  return err.code === 'ECONNRESET' && /before secure TLS connection was established/.test(String(err.message));
}

export type RetryOpts = { budgetMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };

const isTemplate = (s: unknown) => Array.isArray(s) && Array.isArray((s as any).raw);

/** Wraps cb's sql (postgres.js or the relay bridge) so each statement is retried, with a short backoff over about
 *  budgetMs, while it fails with neverSent errors. A transaction (begin) is retried only if its body never started.
 *  The error that ends it carries tries (how many attempts) and triedMs. */
export function withConnectRetry(db: any, o: RetryOpts = {}): any {
  const budget = o.budgetMs ?? 10_000, now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  async function attempt<T>(go: () => PromiseLike<T>, safe: () => boolean = () => true): Promise<T> {
    const t0 = now();
    for (let tries = 1, delay = 500; ; tries++, delay *= 2) {
      try { return await go(); }
      catch (e: any) {
        if (!neverSent(e) || !safe()) throw e;
        if (now() - t0 + delay > budget) {
          if (tries > 1 && typeof e === 'object') Object.assign(e, { tries, triedMs: now() - t0 });
          throw e;
        }
        await sleep(delay);
      }
    }
  }
  // a fresh query each attempt: a postgres.js query is lazy and runs once
  const wrapped: any = (strings: any, ...values: any[]) => isTemplate(strings) ? attempt(() => db(strings, ...values)) : db(strings, ...values);
  wrapped.unsafe = (...a: any[]) => attempt(() => db.unsafe(...a));
  wrapped.begin = (...a: any[]) => {
    const body = a.pop(); let started = false;
    return attempt(() => db.begin(...a, (tx: any) => { started = true; return body(tx); }), () => !started);
  };
  wrapped.end = (...a: any[]) => db.end(...a);
  wrapped.binding = db.binding;
  return wrapped;
}
