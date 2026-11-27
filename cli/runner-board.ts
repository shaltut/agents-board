// How the runner starts against Ahmed's slot setting on the board (#4527, Q2984), apart from the daemon (cli/runner.ts)
// so it can be tested without one. The board and the PC runner update apart: a board from before #4527 has no setting
// columns and a 3-argument runner_hello, and the runner then starts on runner.json's counts, as before (review M2).
import { published, withBoard, type RunnerConfig } from './recipes.ts';

/** Postgres undefined_column / undefined_function: the board's schema is older than this runner. */
const OLDER = new Set(['42703', '42883']);
const older = (e: unknown) => OLDER.has(String((e as { code?: unknown } | null)?.code ?? ''));

type Sql = { (s: TemplateStringsArray, ...v: any[]): Promise<any[]>; json: (v: any) => any };

/** Reads the board's setting, fits it to runner.json (a setting the file cannot take keeps the file's counts, and the
 *  reason goes back to the board for the page, review M3), then says hello with the counts it runs. Returns the config
 *  to run, how many jobs the last run left running (now ended), and whether the board's setting is in use. */
export async function boardHello(sql: Sql, name: string, logUrl: string, text: string, file: RunnerConfig,
  say: (m: string) => void): Promise<{ cfg: RunnerConfig; ended: number; fromBoard: boolean }> {
  let board: { slots_set?: number | null; lanes_set?: number | null } | undefined, old = false;
  try { [board] = await sql`select slots_set, lanes_set from cb.runners where name = ${name}`; } catch (e) {
    if (!older(e)) throw e;
    old = true;
  }
  if (!old) {
    let refused: string | null = null;
    const cfg = withBoard(text, file, { slots: board?.slots_set, dbLanes: board?.lanes_set }, (m) => { refused = m; say(m); });
    try {
      const [h] = await sql`select cb.runner_hello(${name}, ${logUrl}, ${sql.json(published(cfg))}, ${cfg.slots}, ${cfg.dbLanes}, ${refused}) as n`;
      return { cfg, ended: Number(h?.n ?? 0), fromBoard: refused === null && (board?.slots_set != null || board?.lanes_set != null) };
    } catch (e) { if (!older(e)) throw e; }
  }
  say(`the board is older than this runner (it has no slot setting yet): running runner.json's ${file.slots} slots and ${file.dbLanes} DB lane(s)`);
  const [h] = await sql`select cb.runner_hello(${name}, ${logUrl}, ${sql.json(published(file))}) as n`;
  return { cfg: file, ended: Number(h?.n ?? 0), fromBoard: false };
}
