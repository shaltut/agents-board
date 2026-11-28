// #4726: schema.sql is applied on every start, beside the board's live readers, and locks nearly every table ('add column
// if not exists' locks even when it adds nothing). Taken one by one while the transaction already holds others, those
// locks deadlock with readers that join tables in another order: the readers lose queries, or the start dies. So the
// apply first takes every table at once, NOWAIT: it never waits while holding one, which means it cannot be part of a
// deadlock. A busy table fails the try at once with nothing held, and the whole apply (one transaction) runs again.
const LOCK_ALL = `do $$ declare names text; begin
  select string_agg(c.oid::regclass::text, ', ' order by c.relname) into names from pg_class c
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'cb' and c.relkind in ('r', 'p', 'v');
  if names is not null then execute 'lock table ' || names || ' in access exclusive mode nowait'; end if;
end $$`;
const LOST_LOCK = new Set(['40P01', '55P03']); // deadlock_detected, lock_not_available
const TRIES = 150; // with the waits below, about 70 s of a board that is never idle for an instant

type Tx = { unsafe: (query: string) => PromiseLike<unknown>; file: (path: string) => PromiseLike<unknown> };
type Opts = { tries?: number; waitMs?: number; onRetry?: (code: string, attempt: number) => unknown };

export async function applySchema(sql: { begin: (work: (tx: any) => Promise<void>) => PromiseLike<unknown> }, path: string, o: Opts = {}) {
  const tries = o.tries ?? TRIES;
  const onRetry = o.onRetry ?? ((code: string, n: number) => {
    if (n === 1 || n % 10 === 0) console.error(`schema apply lost a lock (${code}), try ${n + 1} of ${tries}`);
  });
  for (let n = 1; ; n++) {
    try { await sql.begin(async (tx: Tx) => { await tx.unsafe(LOCK_ALL); await tx.file(path); }); return; }
    catch (e: any) {
      if (n >= tries || !LOST_LOCK.has(e?.code)) throw e;
      await onRetry(e.code, n);
      // uneven waits, so a retry does not keep landing on a reader that polls on a fixed beat
      await new Promise((r) => setTimeout(r, Math.min((o.waitMs ?? 50) * n, 500) * (0.5 + Math.random() / 2)));
    }
  }
}
