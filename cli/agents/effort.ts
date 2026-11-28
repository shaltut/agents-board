// #4763: the effort levels each agent takes when a seat starts; an agent with none takes no effort. cb._efforts() in
// db/schema.sql is the same list (test/squad-effort.test.ts compares them).
export const EFFORTS: Record<string, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], // not every Codex model takes ultra
  opencode: [], // `--variant` is on `opencode run` only: the TUI a seat runs takes none (1.19.4)
  agy: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** The effort a launch passes: undefined for none (the agent's own default). Throws, naming the seat, an effort this
 *  agent does not take: the value goes on a command line. */
export function checkedEffort(agent: string, seat: string, effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined;
  const levels = EFFORTS[agent] ?? [];
  if (!levels.length) throw new Error(`${agent} seat ${seat}: ${agent} takes no effort when a seat starts: leave it out of the squad`);
  if (!levels.includes(effort)) throw new Error(`${agent} seat ${seat}: effort must be one of ${levels.join(', ')} (got ${JSON.stringify(effort)}): change it in the squad`);
  return effort;
}
