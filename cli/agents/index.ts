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
/** The agents the board may run. An adapter joins this list only once relay, squad up, the supervisor and the guard
 *  installer are wired for it and its live checks pass (#4002): until then cb relay, squad up and the supervisor
 *  refuse it exactly as before it was written. */
const INSTALLED: ReadonlySet<AgentKind> = new Set<AgentKind>(['claude']);

export function getAdapter(kind: string): AgentAdapter {
  if (isAgentKind(kind) && INSTALLED.has(kind)) return ADAPTERS[kind];
  if (isAgentKind(kind)) throw new Error(`agent "${kind}" is not installed yet (phase 1 supports claude only)`);
  throw new Error(`unknown agent "${kind}"`);
}

/** The model a role gets when the squad file names none; the same answer as the SQL cb._role_model(role, agent). */
export const defaultModelFor = (agent: AgentKind, role: string): string | null =>
  agent !== 'claude' ? null : role === 'builder' || role === 'qa' ? 'sonnet' : 'opus';
