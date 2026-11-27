// The supervisor's pure planner: from the board's facts and herdr's, decide this tick's restores, starts, closes and notes.
import { herdrName, launchFor, wantList, type Launch, type Squad } from './squad-up.ts';

export type Session = { actor: string; role: string; area: string | null; repo: string; machine: string | null; pane: string | null; live: boolean;
  holds: number; questions: number; jobs: number; asks: number; last_event: string | null; closing: boolean; last_restore: string | null;
  last_restore_failed: boolean; down_again_logged: boolean; down_again_since_bind: boolean;
  agent?: string | null }; // the agent the session runs (#4002); null or absent (a holder with no session row): claude
export type State = { project: string; squad: Squad; supervised: boolean;
  // builder and reviewer: per repo (#3703); owner: per area
  waiting: { builder: Record<string, number>; reviewer: Record<string, number>; qa: number; investigator: number; architect: number; owner: Record<string, number> };
  sessions: Session[] };
// launched: names this supervisor run started or restored that the board has not yet seen live
// herdrStatus: herdr's agent_status per herdr name (idle, working, blocked, done, unknown); only READY may be closed
// safeToClose (#4002): per session (actor), its agent adapter's answer, which then decides instead of herdrStatus; a
// session it does not name is not closed. Omitted: herdrStatus and READY, as before
// pastSeats (#3770): non-lead names an earlier saved version of this squad generated (pastSeatNames); omitted: none
export type TickInput = { state: State; herdrLive: Set<string>; herdrStatus: Record<string, string>; herdrDown: Set<string>; launched: Set<string>; macLive: number; startsLeft: number; failedAt: Map<string, number>; now: number;
  safeToClose?: Record<string, boolean>; pastSeats?: Set<string> };
// leaving (#3770): seats the squad file no longer generates that stay open for now: busy (live with work), down holding
// work, on a machine that is not one of the squad's, or every seat while the squad names none besides the lead (empty).
// The supervisor never closes or frees these: a person hands over.
export type Leaving = { session: string; why: 'busy' | 'down' | 'machine' | 'empty' };
export type TickPlan = { restore: Launch[]; start: Launch[]; close: string[]; notes: { what: 'down_again'; session: string }[]; leaving: Leaving[] };

/** herdr agent_status values that mean ready for input; an unfocused pane stays `done` after its turn, never `idle`. */
export const READY = new Set(['idle', 'done']);
const MIN = 60_000, CLOSE_AFTER = 20 * MIN, RETRY_AFTER = 10 * MIN, RESTORE_EVERY = 30 * MIN, MAC = 'macbook', MAC_CAP = 8;
const LEAVING_CLOSES = 2; // a bad squad save cannot drain a squad in one tick

/** The non-lead names any of these saved squad versions generated (#3770); a version wantList cannot read is skipped. */
export function pastSeatNames(project: string, squads: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const sq of squads) {
    try { for (const w of wantList(project, sq as Squad)) if (w.role !== 'lead') names.add(w.name); } catch {}
  }
  return names;
}
/** Whether a tick needs pastSeats: a live or holding non-lead session the squad does not want now. */
export function mayBeLeaving(state: State, herdrLive: Set<string>): boolean {
  const now = new Set(wantList(state.project, state.squad).map((w) => w.name));
  return state.sessions.some((s) => s.role !== 'lead' && !now.has(s.actor) && (s.live || s.holds > 0 || herdrLive.has(herdrName(s.actor))));
}

export function planTick(i: TickInput): TickPlan {
  const { state, herdrLive, herdrDown, now } = i;
  const plan: TickPlan = { restore: [], start: [], close: [], notes: [], leaving: [] };
  if (!state.supervised) return plan;
  const { squad, project } = state;
  const by = new Map(state.sessions.map((s) => [s.actor, s]));
  const machineOf = (n: string) => n.split('@')[1];
  const isMac = (n: string) => machineOf(n) === MAC || squad.machines[machineOf(n)]?.herdr === MAC;
  const isLive = (n: string) => !!by.get(n)?.live || herdrLive.has(herdrName(n));
  const failed = (n: string) => now - (i.failedAt.get(n) ?? -Infinity) < RETRY_AFTER;
  const ok = (n: string) => !herdrDown.has(machineOf(n)) && !failed(n);
  const safe = (n: string) => (i.safeToClose ? i.safeToClose[n] === true : READY.has(i.herdrStatus[herdrName(n)] ?? ''));
  let startsLeft = i.startsLeft, macRoom = MAC_CAP - i.macLive;
  const take = (n: string) => { startsLeft--; if (isMac(n)) macRoom--; };
  const room = (n: string) => startsLeft > 0 && (!isMac(n) || macRoom > 0);
  const wanted = wantList(project, squad).filter((w) => w.role !== 'lead');
  const restored = new Set<string>();
  const idle = (s: Session) => s.live && !s.holds && !s.questions && !s.jobs && !s.asks && !s.closing;
  // #3770: a name an earlier version of this squad generated but this one does not (its role moved machine, its count
  // went down, its role or repo left) is leaving: it counts toward no role's slots, cancels no waiting work, and is closed
  // once idle whatever waits (the work is the new seats'), at most 2 a tick. Busy, or down holding work, it stays and is
  // listed. A hand-started name no squad version generated is never leaving; a dead row holding nothing: ignored
  const wantedNames = new Set(wanted.map((w) => w.name));
  const leaving = new Set(state.sessions.filter((s) => s.role !== 'lead' && !wantedNames.has(s.actor) && !!i.pastSeats?.has(s.actor)
    && (isLive(s.actor) || s.holds > 0)).map((s) => s.actor));

  for (const w of wanted) {
    const s = by.get(w.name);
    if (!s || !s.holds || isLive(w.name) || herdrDown.has(machineOf(w.name))) continue;
    if (s.down_again_since_bind) continue; // down again after a restore: a person restores it; no loop until it binds again
    const since = s.last_restore ? now - Date.parse(s.last_restore) : Infinity;
    if (s.last_restore_failed) { if (since < RETRY_AFTER) continue; } // it never started: tried again after 10 minutes
    else if (since < RESTORE_EVERY) {
      if (!s.down_again_logged) plan.notes.push({ what: 'down_again', session: w.name });
      continue;
    }
    if (!ok(w.name) || !room(w.name)) continue;
    plan.restore.push(launchFor(project, squad, w, 'resume'));
    restored.add(w.name);
    take(w.name);
  }

  // one want group per role (owners: one per area; builders and reviewers: one per repo)
  const perRepo = (role: string): role is 'builder' | 'reviewer' => role === 'builder' || role === 'reviewer';
  const groups = new Map<string, { role: string; area?: string; repo: string; waiting: number; names: typeof wanted }>();
  for (const w of wanted) {
    const key = `${w.role}/${w.area ?? ''}/${w.repo}`;
    const waiting = w.role === 'owner' ? state.waiting.owner[w.area!] ?? 0
      : perRepo(w.role) ? state.waiting[w.role][w.repo] ?? 0
      : state.waiting[w.role as 'qa' | 'investigator' | 'architect'] ?? 0;
    (groups.get(key) ?? groups.set(key, { role: w.role, area: w.area, repo: w.repo, waiting, names: [] }).get(key)!).names.push(w);
  }
  for (const g of groups.values()) {
    const mine = state.sessions.filter((s) => !leaving.has(s.actor) && s.role === g.role && (g.area === undefined || s.area === g.area) && (!perRepo(g.role) || s.repo === g.repo));
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
      if (s && !herdrDown.has(machineOf(w.name)) && idle(s) && safe(w.name)
        && s.last_event && now - Date.parse(s.last_event) >= CLOSE_AFTER) plan.close.push(w.name);
    }
  }
  let closesLeft = LEAVING_CLOSES;
  for (const n of leaving) {
    const s = by.get(n)!;
    if (!wanted.length) plan.leaving.push({ session: n, why: 'empty' }); // a squad with no seats besides the lead: likely a bad save
    else if (!Object.hasOwn(squad.machines, machineOf(n))) plan.leaving.push({ session: n, why: 'machine' }); // its herdr is unknown
    else if (!isLive(n)) plan.leaving.push({ session: n, why: 'down' });
    else if (!idle(s)) { if (!s.closing) plan.leaving.push({ session: n, why: 'busy' }); } // closing: a close is under way
    else if (closesLeft > 0 && !herdrDown.has(machineOf(n)) && safe(n) && s.last_event && now - Date.parse(s.last_event) >= CLOSE_AFTER) { plan.close.push(n); closesLeft--; }
  }
  return plan;
}
