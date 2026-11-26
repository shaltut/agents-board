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

export function survive(say: (line: string) => void) {
  const handle = (e: unknown) => {
    if (isNetworkError(e)) {
      say(`lost the board connection: ${(e as Error).message} (${(e as any).code ?? 'network'}); carrying on, it reconnects on the next query`);
      return;
    }
    say(`fatal: ${(e as Error)?.stack ?? String(e)}`);
    process.exit(1);
  };
  process.on('uncaughtException', handle);
  process.on('unhandledRejection', handle);
}
