// #4610: the relay's seat helpers, kept pure for tests. A non-Claude seat's relay is started by its seat prestart, before
// herdr starts the agent there, so it must wait for the agent instead of leaving at once, and it learns the seat's herdr
// agent name (codex and agy read liveness and deliver through herdr by that name) from herdr itself, by the pane.

/** How long a relay waits for an agent it has never seen alive: herdr's agent start waits up to 120 s, and a startup
 *  dialog keeps the agent registered (alive) anyway. Past it, the relay leaves as for a dead agent. A test may shorten it
 *  (CB_RELAY_START_GRACE_MS); a value that is not a positive number keeps the default. */
export const START_GRACE_MS = Number(process.env.CB_RELAY_START_GRACE_MS) > 0 ? Number(process.env.CB_RELAY_START_GRACE_MS) : 180_000;

export type Watch = { dead: number; seenAlive: boolean; startedAt: number };
/** One 2 s watchdog reading. Once seen alive: leave on the second dead reading in a row (one blip never ends a relay).
 *  Never seen alive: dead readings count only after START_GRACE_MS. */
export function watchdogStep(s: Watch, alive: boolean, now: number): { state: Watch; leave: boolean } {
  if (alive) return { state: { ...s, dead: 0, seenAlive: true }, leave: false };
  if (!s.seenAlive && now - s.startedAt < START_GRACE_MS) return { state: s, leave: false };
  const dead = s.dead + 1;
  return { state: { ...s, dead }, leave: dead >= 2 };
}

/** The agents whose relay reads liveness and delivers through herdr by the seat's herdr name. OpenCode goes through its
 *  own endpoint file and Claude through its socket: neither needs the name. */
export const HERDR_NAMED: ReadonlySet<string> = new Set(['codex', 'agy']);

/** Review 98 I1: a codex or agy relay with no herdr name yet has no agent it could reach, so it reads as not alive
 *  (no heartbeat, and the start grace ends it when the agent never comes up). agy's own isAlive says alive with no name. */
export const namelessDead = (agent: string, herdrName: string | undefined) => HERDR_NAMED.has(agent) && !herdrName;

/** #4786: reads the model the seat really runs off its visible screen and saves it, for an agent whose adapter can tell
 *  from the screen. Only the model id leaves this function: no screen text is stored or logged. A read that fails saves
 *  nothing (the board keeps the last reading). */
export async function readRunningModel(o: { adapter: { runningModel?(screen: string): string | null }; pane: string;
  read: (args: string[]) => { status: number | null; stdout?: unknown }; save: (model: string) => Promise<unknown> }): Promise<void> {
  if (!o.adapter.runningModel) return;
  let model: string | null = null;
  try {
    const r = o.read(['pane', 'read', o.pane, '--source', 'visible', '--format', 'text']);
    if (r.status === 0) model = o.adapter.runningModel(String(r.stdout ?? ''));
  } catch { return; }
  if (model) await o.save(model);
}

/** The herdr agent of this kind running in this pane, from `herdr agent list` JSON ({result: {agents: [{name, pane_id,
 *  agent}]}}). The kind must match (review 98 M1): a codex relay never takes a Claude agent's name and types into it. */
export function herdrNameForPane(list: unknown, pane: string, agent: string): string | null {
  const agents = (list as any)?.result?.agents ?? (list as any)?.agents;
  if (!Array.isArray(agents)) return null;
  const a = agents.find((x: any) => x && x.pane_id === pane && x.agent === agent && typeof x.name === 'string' && x.name);
  return a ? a.name : null;
}
