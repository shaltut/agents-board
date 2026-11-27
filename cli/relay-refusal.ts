// #4429: a relay that cannot serve its seat's agent says so on the board, not only in its log. relay.ts runs on import,
// so the wording and the tell live here, where tests reach them.
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { getAdapter, isAgentKind, type AgentKind } from './agents/index.ts';

type Opts = { env?: NodeJS.ProcessEnv; installed?: ReadonlySet<AgentKind> };

/** Why the relay refuses `kind`, in plain words for the board, or null when it may start. Never the adapter's own
 *  message: the MCP gate text names config paths, and an unknown name is whatever the flag or env said. */
export function refusalWords(kind: string, o: Opts = {}): string | null {
  try { getAdapter(kind, o); return null; } catch {}
  if (!isAgentKind(kind)) return 'the pane names an agent the board does not know';
  // refused with this env but served once the gate names it: the gate is the reason
  const gateOnly = (() => { try { getAdapter(kind, { ...o, env: { CB_MCP_GATE_OK: kind } }); return true; } catch { return false; } })();
  return gateOnly ? `the MCP check for ${kind} is not done on this seat's machine (CB_MCP_GATE_OK does not name ${kind} there)`
    : `the board does not run ${kind} seats yet`;
}

type Sql = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

const DAY_MS = 24 * 3600_000;

/** Claims the tell for `mark` (seat's bound name and reason): an exclusive create of `memo`, so two refusals at the same
 *  moment tell once. The same mark claimed in the last day: false. Another mark, or one a day old: moved aside (a rename,
 *  so of two racing replacers only one gets to create) and claimed anew. A memo that cannot be written: true. */
export function claimTell(memo: string, mark: string, now = Date.now()): boolean {
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(memo, mark, { flag: 'wx' }); return true; }
    catch (e: any) { if (e?.code !== 'EEXIST') return true; }
    try {
      if (readFileSync(memo, 'utf8') === mark && now - statSync(memo).mtimeMs < DAY_MS) return false;
      const old = `${memo}.${process.pid}.old`;
      renameSync(memo, old);
      rmSync(old, { force: true });
    } catch {} // gone meanwhile: the create is tried again
  }
  return false; // another refusal claimed it between our move and create
}

/** Tells the seat's project, as a new bug is routed (cb.triagers: its leads seen today, else its recent sessions), that
 *  this seat has no relay. Once a day per seat, bound name and reason (claimTell); the claim is dropped when the tell
 *  fails, and none is made with nobody to tell, so the next refusal tries again. Returns a log line. */
export async function tellRefusal(sql: Sql, seat: { machine: string; pane: string }, words: string, memo: string): Promise<string> {
  const [row] = await sql`select actor, project from cb.sessions where machine = lower(trim(${seat.machine})) and pane = trim(${seat.pane})`;
  if (!row?.project) return 'nobody told: the pane is not bound to a project yet';
  const [{ to }] = await sql`select cb.triagers(${row.project}) as to`;
  const leads = (to as string[]).filter((a) => a !== row.actor);
  if (!leads.length) return `nobody told: ${row.project} has no other session seen today`;
  const mark = `${row.actor}\n${words}`;
  if (!claimTell(memo, mark)) return 'already told';
  const text = `${row.actor}'s relay did not start: ${words}. Until it runs, that seat gets no answers, messages or task changes pushed; fix that, then run cb relay in its pane.`;
  try { for (const a of leads) await sql`select cb.tell(${a}, ${text}, ${row.actor})`; }
  catch (e) { clearRefusal(memo); throw e; }
  return `told ${leads.join(', ')}`;
}

/** A relay that started: the next refusal of this seat is news again. */
export const clearRefusal = (memo: string) => { try { rmSync(memo, { force: true }); } catch {} };
