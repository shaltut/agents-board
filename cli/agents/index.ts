// The adapter registry. An agent that has no adapter yet throws: never a silent fall back to Claude.
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import type { AgentAdapter, AgentKind } from './types.ts';

export type { AgentAdapter, AgentKind } from './types.ts';
export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'opencode', 'agy'];
export const isAgentKind = (v: unknown): v is AgentKind => typeof v === 'string' && (AGENT_KINDS as readonly string[]).includes(v);

export function getAdapter(kind: string): AgentAdapter {
  if (kind === 'claude') return claudeAdapter;
  if (kind === 'codex') return codexAdapter;
  if (isAgentKind(kind)) throw new Error(`agent "${kind}" is not installed yet (phase 1 supports claude only)`);
  throw new Error(`unknown agent "${kind}"`);
}

/** The model a role gets when the squad file names none; the same answer as the SQL cb._role_model(role, agent). */
export const defaultModelFor = (agent: AgentKind, role: string): string | null =>
  agent !== 'claude' ? null : role === 'builder' || role === 'qa' ? 'sonnet' : 'opus';
