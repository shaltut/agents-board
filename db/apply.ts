// #4726: schema.sql is applied on every start, beside the board's live readers, so its locks can lose: a deadlock or a
// lock timeout must be a second try, not a dead start. The file is one implicit transaction, so a failed try leaves
// nothing behind and the whole file runs again.
const LOST_LOCK = new Set(['40P01', '55P03']); // deadlock_detected, lock_not_available
const TRIES = 5;

type Opts = { waitMs?: number; onRetry?: (code: string, attempt: number) => unknown };

export async function applySchema(sql: { file: (path: string) => PromiseLike<unknown> }, path: string, o: Opts = {}) {
  const onRetry = o.onRetry ?? ((code: string, n: number) => console.error(`schema apply lost a lock (${code}), try ${n + 1} of ${TRIES}`));
  for (let n = 1; ; n++) {
    try { await sql.file(path); return; }
    catch (e: any) {
      if (n >= TRIES || !LOST_LOCK.has(e?.code)) throw e;
      await onRetry(e.code, n);
      await new Promise((r) => setTimeout(r, (o.waitMs ?? 1000) * n));
    }
  }
}
