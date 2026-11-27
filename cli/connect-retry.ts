// #4337: a board that is briefly unreachable (the machine waking, a Tailscale relay hiccup, a board restart) used to
// fail the call at once, so every script wrapped cb in its own retry loop, and a blind resend of a write could run it
// twice. cb now retries one statement, and only when the error proves the statement never left this machine: the
// connection to the board was refused, timed out or never resolved before any query was written. A failure after a
// statement was sent (a reset, a read timeout, a closed connection, the relay lost mid-query) is never retried: a
// write may have landed, and task_add or ask would run twice.

import { isNetworkError } from './survive.ts';

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

/** What cb tells the caller about whether its command ran, for a network failure (null: not one). answered: the
 *  command's statements the board already answered. A failed read after a committed write must never read as "it did
 *  not run" (#3331): the caller would send the write again. check: what to do before running it again (checkFirst). */
export function ranWords(e: unknown, answered: number, check: string): string | null {
  if (neverSent(e)) return answered
    ? `the call that failed never reached it, but an earlier step of this command did and may have saved your change: ${check}`
    : 'the call that failed never reached it, so this command did not run';
  if (isNetworkError(e) || (e as any)?.code === 'RELAY_LOST')
    return `the call that failed may have reached it, so this command may have run: ${check}`;
  return null;
}

// #4450: "check with cb before running it again" named no command, so a session could not act on it (it passed the
// every-error-names-a-command check only because "cb before" looked like a command). Name the one that shows whether
// this command landed. READS call only selects or stable functions, so running one again changes nothing.
const READS = new Set(['show', 'search', 'session', 'sessions', 'digest']);
// the first argument is the card they change: cb show <id> shows the change and its note
const ON_CARD = new Set(['tag', 'stage', 'pass', 'fail', 'move', 'done', 'edit', 'log', 'block', 'unblock']);

/** What to do before running again a command that may have run: a blind resend of a write runs it twice (#3331).
 *  me: who this pane acts as. Only a numeric id and the title's first words are echoed back. */
export function checkFirst(cmd: string | undefined, args: string[], me: string): string {
  if (cmd && READS.has(cmd)) return 'it only reads, so running it again is safe';
  // #3331: an unchanged resend of a question still open returns it; one with pictures always posts
  if (cmd === 'ask') return `send the same cb ask again, unchanged: a question still open is returned, not asked twice (with pictures it posts again: check cb brief ${args[0] ?? '<project>'} first)`;
  const id = /^#?\d{1,15}$/.test(args[0] ?? '') ? args[0]!.replace('#', '') : null;
  const words = String(args[1] ?? '').replace(/["`$\\]/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ');
  const check = id && ON_CARD.has(cmd ?? '') ? `cb show ${id}`
    : (cmd === 'add' || cmd === 'bug') && args[0] ? `cb search ${args[0]} "${words || '<title words>'}"`
    // cb.tell records the message as an event of its sender, and cb session lists a name's recent events
    : cmd === 'tell' ? `cb session ${me} (the messages you sent are in its RECENT list)`
    : 'cb mine';
  return `check with ${check} before running it again`;
}

export type RetryOpts = { budgetMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };

const isTemplate = (s: unknown) => Array.isArray(s) && Array.isArray((s as any).raw);

/** Wraps cb's sql (postgres.js or the relay bridge) so each statement is retried, with a short backoff over about
 *  budgetMs, while it fails with neverSent errors. A transaction (begin) is retried only if its body never started.
 *  The error that ends it carries tries (how many attempts) and triedMs. answered counts the statements the board
 *  answered, so cb never says a command did not run after one of its steps did (ranWords). */
export function withConnectRetry(db: any, o: RetryOpts = {}): any {
  const budget = o.budgetMs ?? 10_000, now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  async function attempt<T>(go: () => PromiseLike<T>, safe: () => boolean = () => true): Promise<T> {
    const t0 = now();
    for (let tries = 1, delay = 500; ; tries++, delay *= 2) {
      try { const r = await go(); wrapped.answered++; return r; }
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
  wrapped.answered = 0;
  return wrapped;
}
