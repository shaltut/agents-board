// How the runner starts against Ahmed's slot setting on the board (#4527, Q2984), apart from the daemon (cli/runner.ts)
// so it can be tested without one. The board and the PC runner update apart: a board from before #4527 has no setting
// columns and a 3-argument runner_hello, and the runner then starts on runner.json's counts, as before (review M2).
import { published, withBoard, type RunnerConfig } from './recipes.ts';

/** Postgres undefined_column / undefined_function: the board's schema is older than this runner. */
const OLDER = new Set(['42703', '42883']);
const older = (e: unknown) => OLDER.has(String((e as { code?: unknown } | null)?.code ?? ''));

/** One named board call (call() in cli/board.ts, on the runner's own connection). */
export type Board = (fn: string, args: Record<string, unknown>) => Promise<any>;

/** #4710: seconds between two of this runner's DB test stack starts, unless the board sets cb.runners.stack_gap_set. */
export const STACK_GAP_S = 30;

/** The stack gap to run: the board's stack_gap_set (0-300) when set, else STACK_GAP_S. Any failure keeps the default. */
export async function boardStackGap(board: Board, name: string, say: (m: string) => void): Promise<number> {
  try {
    const v = (await board('runner_settings', { name }))?.stack_gap_set;
    return Number.isInteger(v) && v >= 0 && v <= 300 ? v : STACK_GAP_S;
  } catch (e) {
    if (!older(e)) say(`could not read the board's stack gap (${(e as Error)?.message ?? e}): using ${STACK_GAP_S} s`);
    return STACK_GAP_S;
  }
}

/** Reads the board's setting, fits it to runner.json (a setting the file cannot take keeps the file's counts, and the
 *  reason goes back to the board for the page, review M3), then says hello with the counts it runs. Returns the config
 *  to run, how many jobs the last run left running (now ended), and whether the board's setting is in use. */
export async function boardHello(board: Board, name: string, logUrl: string, text: string, file: RunnerConfig,
  say: (m: string) => void): Promise<{ cfg: RunnerConfig; ended: number; fromBoard: boolean }> {
  let set: { slots_set?: number | null; lanes_set?: number | null } | null = null, old = false;
  try { set = await board('runner_settings', { name }); } catch (e) {
    if (!older(e)) throw e;
    old = true;
  }
  if (!old) {
    let refused: string | null = null;
    const cfg = withBoard(text, file, { slots: set?.slots_set, dbLanes: set?.lanes_set }, (m) => { refused = m; say(m); });
    try {
      const n = await board('runner_hello', { runner: name, log_url: logUrl, recipes: published(cfg), slots: cfg.slots,
        db_lanes: cfg.dbLanes, setting_refused: refused });
      return { cfg, ended: Number(n ?? 0), fromBoard: refused === null && (set?.slots_set != null || set?.lanes_set != null) };
    } catch (e) { if (!older(e)) throw e; }
  }
  say(`the board is older than this runner (it has no slot setting yet): running runner.json's ${file.slots} slots and ${file.dbLanes} DB lane(s)`);
  const n = await board('runner_hello', { runner: name, log_url: logUrl, recipes: published(file) });
  return { cfg: file, ended: Number(n ?? 0), fromBoard: false };
}
