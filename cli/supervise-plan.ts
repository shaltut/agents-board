// The supervisor's pure planner: from the board's facts and herdr's, decide this tick's restores, starts, closes and notes.
import { herdrName, launchFor, wantList, type Launch, type Squad } from './squad-up.ts';

export type Session = { actor: string; role: string; area: string | null; machine: string | null; pane: string | null; live: boolean;
  holds: number; questions: number; jobs: number; asks: number; last_event: string | null; closing: boolean; last_restore: string | null;
  down_again_logged: boolean; down_again_since_bind: boolean };
export type State = { project: string; squad: Squad; supervised: boolean;
  waiting: { builder: number; reviewer: number; qa: number; investigator: number; architect: number; owner: Record<string, number> };
  sessions: Session[] };
// launched: names this supervisor run started or restored that the board has not yet seen live
// herdrStatus: herdr's agent_status per herdr name (idle, working, blocked, done, unknown); only 'idle' may be closed
export type TickInput = { state: State; herdrLive: Set<string>; herdrStatus: Record<string, string>; herdrDown: Set<string>; launched: Set<string>; macLive: number; startsLeft: number; failedAt: Map<string, number>; now: number };
export type TickPlan = { restore: Launch[]; start: Launch[]; close: string[]; notes: { what: 'down_again'; session: string }[] };

/** herdr agent_status values that mean ready for input; an unfocused pane stays `done` after its turn, never `idle`. */
export const READY = new Set(['idle', 'done']);
const MIN = 60_000, CLOSE_AFTER = 20 * MIN, RETRY_AFTER = 10 * MIN, RESTORE_EVERY = 30 * MIN, MAC = 'macbook', MAC_CAP = 8;

export function planTick(i: TickInput): TickPlan {
  const { state, herdrLive, herdrDown, now } = i;
  const plan: TickPlan = { restore: [], start: [], close: [], notes: [] };
  if (!state.supervised) return plan;
  const { squad, project } = state;
  const by = new Map(state.sessions.map((s) => [s.actor, s]));
  const machineOf = (n: string) => n.split('@')[1];
  const isMac = (n: string) => machineOf(n) === MAC || squad.machines[machineOf(n)]?.herdr === MAC;
  const isLive = (n: string) => !!by.get(n)?.live || herdrLive.has(herdrName(n));
  const failed = (n: string) => now - (i.failedAt.get(n) ?? -Infinity) < RETRY_AFTER;
  const ok = (n: string) => !herdrDown.has(machineOf(n)) && !failed(n);
  let startsLeft = i.startsLeft, macRoom = MAC_CAP - i.macLive;
  const take = (n: string) => { startsLeft--; if (isMac(n)) macRoom--; };
  const room = (n: string) => startsLeft > 0 && (!isMac(n) || macRoom > 0);
  const wanted = wantList(project, squad).filter((w) => w.role !== 'lead');
  const restored = new Set<string>();

  for (const w of wanted) {
    const s = by.get(w.name);
    if (!s || !s.holds || isLive(w.name) || herdrDown.has(machineOf(w.name))) continue;
    if (s.down_again_since_bind) continue; // down again after a restore: a person restores it; no loop until it binds again
    if (s.last_restore && now - Date.parse(s.last_restore) < RESTORE_EVERY) {
      if (!s.down_again_logged) plan.notes.push({ what: 'down_again', session: w.name });
      continue;
    }
    if (!ok(w.name) || !room(w.name)) continue;
    plan.restore.push(launchFor(project, squad, w, 'resume'));
    restored.add(w.name);
    take(w.name);
  }

  // one want group per role (owners: one per area)
  const groups = new Map<string, { role: string; area?: string; waiting: number; names: typeof wanted }>();
  for (const w of wanted) {
    const key = w.role + (w.area ? `/${w.area}` : '');
    const waiting = w.role === 'owner' ? state.waiting.owner[w.area!] ?? 0 : state.waiting[w.role as Exclude<keyof State['waiting'], 'owner'>] ?? 0;
    (groups.get(key) ?? groups.set(key, { role: w.role, area: w.area, waiting, names: [] }).get(key)!).names.push(w);
  }
  for (const g of groups.values()) {
    const mine = state.sessions.filter((s) => s.role === g.role && (g.area === undefined || s.area === g.area));
    const idle = (s: Session) => s.live && !s.holds && !s.questions && !s.jobs && !s.asks && !s.closing;
    // a name this run launched that herdr runs but the board does not see yet (still starting, or on a startup
    // dialog) counts as started: live, and about to take work, so the next tick does not start another for the same
    // card. Only this run's launches: any other herdr-only name would cancel waiting work for as long as its pane lives.
    const pending = g.names.filter((w) => i.launched.has(w.name) && herdrLive.has(herdrName(w.name)) && !by.get(w.name)?.live && !by.get(w.name)?.holds);
    const liveCount = mine.filter((s) => (s.live || herdrLive.has(herdrName(s.actor))) && !s.closing).length
      + pending.filter((w) => !mine.some((s) => s.actor === w.name)).length + g.names.filter((w) => restored.has(w.name)).length;
    let n = Math.min(g.waiting - mine.filter(idle).length - pending.length, g.names.length - liveCount);
    for (const w of g.names) {
      if (n <= 0) break;
      if (isLive(w.name) || restored.has(w.name) || by.get(w.name)?.holds || !ok(w.name) || !room(w.name)) continue;
      plan.start.push(launchFor(project, squad, w));
      take(w.name);
      n--;
    }
    if (g.waiting > 0) continue;
    for (const w of g.names) {
      const s = by.get(w.name);
      if (s && !herdrDown.has(machineOf(w.name)) && idle(s) && READY.has(i.herdrStatus[herdrName(w.name)] ?? '')
        && s.last_event && now - Date.parse(s.last_event) >= CLOSE_AFTER) plan.close.push(w.name);
    }
  }
  return plan;
}
