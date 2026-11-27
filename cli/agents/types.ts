// The contract every agent CLI (Claude, Codex, OpenCode, Antigravity) meets. Pure types: no runtime code.
import type { Runner } from '../squad-up.ts';

export type { Runner };
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'agy';
export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type SeatHandle = { machine: string; pane: string; actor?: string; herdr?: string | null; herdrName?: string; agent: AgentKind };
/** `args` are what follows `--` in `herdr agent start <name> --kind <kind> --pane <pane> -- <args>`. */
export type LaunchSpec = { kind: string; args: string[]; env: Record<string, string> };
export type AgentStatus = { state: AgentState; safeToClose: boolean; detail?: string };
export type QuotaSignal = { kind: 'quota' | 'rate_limit'; retryAfterSec?: number; raw: string };
export type GuardInstallSpec = { targetPath: string; shimFile: string; matchers: Record<'win32' | 'darwin' | 'linux', string>; notes: string };
export type InstructionMapping = { nativeFiles: string[]; extraArgs: string[]; env: Record<string, string>; note: string };
export type TrustSpec = { dialogHint: string; preseedPath?: string; extraArgs: string[] };
export type DisableAskSpec = { toolName: string; mechanism: 'hook' | 'permission'; target: string };
/** How a seat starts with no MCP server (#4392): `args` and `env` for this run only (buildLaunch adds them; never the
 *  user's own config). What they cannot turn off is the adapter's `mcpGate`. */
export type McpOffSpec = { args: string[]; env: Record<string, string>; note: string };
export type LaunchInput = { name: string; role: string; area?: string; repo: string; agent: AgentKind; model: string; board: string; cwd: string; env?: Record<string, string> };

export interface AgentAdapter {
  readonly kind: AgentKind;
  readonly relayStart: 'session-hook' | 'pane-prestart';
  buildLaunch(launch: LaunchInput): LaunchSpec;
  deliver(seat: SeatHandle, text: string, opts?: { raw?: boolean }): Promise<void>;
  isAlive(seat: SeatHandle): Promise<boolean>;
  readStatus(seat: SeatHandle, herdrAgent: { agent_status?: string } | null): Promise<AgentStatus>;
  close(seat: SeatHandle, run: Runner): Promise<'sent' | 'failed'>;
  detectQuotaStop(seat: SeatHandle, herdrAgent: { agent_status?: string } | null, paneTail?: string): QuotaSignal | null;
  guardInstallSpec(boardDir: string, platform: NodeJS.Platform): GuardInstallSpec;
  instructionMapping(launch: LaunchInput): InstructionMapping;
  trustSpec(repoPaths: string[], platform: NodeJS.Platform): TrustSpec;
  disableAskSpec(): DisableAskSpec;
  mcpOff(board: string): McpOffSpec;
  /** Null when mcpOff turns every MCP source off. Otherwise what the CLI cannot turn off per run, which must hold on every
   *  machine that runs this agent's seats: getAdapter refuses the agent until CB_MCP_GATE_OK names it (#4392). */
  readonly mcpGate: string | null;
}
