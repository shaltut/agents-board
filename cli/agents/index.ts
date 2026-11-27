// The adapter registry. An agent that has no adapter yet throws: never a silent fall back to Claude.
import { agyAdapter } from './agy.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { opencodeAdapter } from './opencode.ts';
import type { AgentAdapter, AgentKind } from './types.ts';

export type { AgentAdapter, AgentKind } from './types.ts';
export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'opencode', 'agy'];
export const isAgentKind = (v: unknown): v is AgentKind => typeof v === 'string' && (AGENT_KINDS as readonly string[]).includes(v);

/** Every adapter that is written. Tests and the wiring work use this; the board itself goes through getAdapter.
 *  Getters, not values: squad-up.ts imports this file and the adapters import squad-up.ts, so an adapter may not be
 *  initialised yet while this module runs. */
export const ADAPTERS: Readonly<Record<AgentKind, AgentAdapter>> = {
  get claude() { return claudeAdapter; }, get codex() { return codexAdapter; },
  get opencode() { return opencodeAdapter; }, get agy() { return agyAdapter; },
};
/** The agents the board may run (the launch gate): cb relay, squad up and the supervisor refuse any other (#4002). All
 *  four in every project since #4585 (Q3024); an agent with an mcpGate still needs CB_MCP_GATE_OK where it starts. The
 *  save gate's list is cb._agents_main() (db/schema.sql): change both (test/settings.test.ts compares them). */
export const INSTALLED: ReadonlySet<AgentKind> = new Set<AgentKind>(['claude', 'codex', 'opencode', 'agy']);

/** The kinds whose MCP gate the owner has checked: CB_MCP_GATE_OK=codex,agy (comma separated, any case). It is a claim about
 *  every machine that runs those seats, so it is read where getAdapter runs: squad up, the supervisor and the seat's relay. */
export const mcpGateOk = (env: NodeJS.ProcessEnv = process.env): Set<string> =>
  new Set(String(env.CB_MCP_GATE_OK ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

/** #4392: an adapter whose CLI cannot start a seat with no MCP server for one run is refused by name, not started with
 *  whatever servers the user's own config enables, until CB_MCP_GATE_OK names it. Null when it may start. */
export function mcpGateRefusal(a: AgentAdapter, env: NodeJS.ProcessEnv = process.env): string | null {
  if (a.mcpGate === null || mcpGateOk(env).has(a.kind)) return null;
  return `agent "${a.kind}" cannot start a seat with MCP off for one run: it needs ${a.mcpGate}. Check that on every machine that runs ${a.kind} seats, then set CB_MCP_GATE_OK=${a.kind} (comma separated with other agents) where cb squad up, the supervisor and the seat's relay run`;
}

/** `opts` is for tests: the environment to read CB_MCP_GATE_OK from and an installed set in place of INSTALLED. */
export function getAdapter(kind: string, opts: { env?: NodeJS.ProcessEnv; installed?: ReadonlySet<AgentKind> } = {}): AgentAdapter {
  const installed = opts.installed ?? INSTALLED;
  if (isAgentKind(kind) && installed.has(kind)) {
    const refused = mcpGateRefusal(ADAPTERS[kind], opts.env);
    if (refused) throw new Error(refused);
    return ADAPTERS[kind];
  }
  if (isAgentKind(kind)) throw new Error(`agent "${kind}" is not installed yet (this cb runs ${[...installed].join(', ')} only)`);
  throw new Error(`unknown agent "${kind}"`);
}

/** The model a role gets when the squad file names none; the same answer as the SQL cb._role_model(role, agent). */
export const defaultModelFor = (agent: AgentKind, role: string): string | null =>
  agent !== 'claude' ? null : role === 'builder' || role === 'qa' ? 'sonnet' : 'opus';
