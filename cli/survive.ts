// #3902: a long-running PC process (cb runner) must outlive a dropped board connection. postgres.js reconnects on the
// next query and sql.listen re-subscribes (its onlisten re-runs the claim), but an error from a dead socket that nothing
// awaited reaches the process as uncaught and used to end it. Lost connections are logged and survived; every other
// uncaught error still ends the process, as Node would, so a real bug is never hidden.
const NET = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND',
  'EAI_AGAIN', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT',
  '57P01', '57P02', '57P03']); // postgres: admin shutdown, crash shutdown, cannot connect now (a board restart)

export function isNetworkError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; errors?: unknown[]; cause?: unknown };
  if (typeof err.code === 'string' && NET.has(err.code)) return true;
  if (Array.isArray(err.errors) && err.errors.some(isNetworkError)) return true;
  return err.cause !== undefined && err.cause !== e && isNetworkError(err.cause);
}

// Until ready() a lost connection still ends the process (#3902 review C1): a runner that never got up (runner_hello or
// listen failed) must exit so the supervisor restarts it, not linger with its log port held, never beating.
export function survive(say: (line: string) => void) {
  let up = false;
  const handle = (e: unknown) => {
    if (isNetworkError(e) && !up) {
      say(`fatal: lost the board connection before the runner was up: ${(e as Error).message} (${(e as any).code}); exiting so it is restarted`);
      process.exit(1);
    }
    if (isNetworkError(e)) {
      say(`lost the board connection: ${(e as Error).message} (${(e as any).code ?? 'network'}); carrying on, it reconnects on the next query`);
      return;
    }
    say(`fatal: ${(e as Error)?.stack ?? String(e)}`);
    process.exit(1);
  };
  process.on('uncaughtException', handle);
  process.on('unhandledRejection', handle);
  return { ready: () => { up = true; } };
}
