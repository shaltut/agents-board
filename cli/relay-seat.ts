// #4610: the relay's seat helpers, kept pure for tests. A non-Claude seat's relay is started by its seat prestart, before
// herdr starts the agent there, so it must wait for the agent instead of leaving at once, and it learns the seat's herdr
// agent name (codex and agy read liveness and deliver through herdr by that name) from herdr itself, by the pane.

/** How long a relay waits for an agent it has never seen alive: herdr's agent start waits up to 120 s, and a startup
 *  dialog keeps the agent registered (alive) anyway. Past it, the relay leaves as for a dead agent. */
export const START_GRACE_MS = 180_000;

export type Watch = { dead: number; seenAlive: boolean; startedAt: number };
/** One 2 s watchdog reading. Once seen alive: leave on the second dead reading in a row (one blip never ends a relay).
 *  Never seen alive: dead readings count only after START_GRACE_MS. */
export function watchdogStep(s: Watch, alive: boolean, now: number): { state: Watch; leave: boolean } {
  if (alive) return { state: { ...s, dead: 0, seenAlive: true }, leave: false };
  if (!s.seenAlive && now - s.startedAt < START_GRACE_MS) return { state: s, leave: false };
  const dead = s.dead + 1;
  return { state: { ...s, dead }, leave: dead >= 2 };
}

/** The herdr agent running in this pane, from `herdr agent list` JSON ({result: {agents: [{name, pane_id}]}}). */
export function herdrNameForPane(list: unknown, pane: string): string | null {
  const agents = (list as any)?.result?.agents ?? (list as any)?.agents;
  if (!Array.isArray(agents)) return null;
  const a = agents.find((x: any) => x && x.pane_id === pane && typeof x.name === 'string' && x.name);
  return a ? a.name : null;
}
