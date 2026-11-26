// The Claude Code adapter. Pure: no database. Claude hands its messaging socket and token to the relay through an
// endpoint file in the temp dir (written by the relay launcher); delivery is today's socket protocol (cli/relay.ts).
// The token lives only in that file and the auth line: it is never logged or put in an error message.
import net from 'node:net';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatKey } from '../bridge.ts';
import type { AgentAdapter, AgentState, QuotaSignal, SeatHandle } from './types.ts';

export type ClaudeEndpoint = { socket: string; token: string; pid?: number; updatedAt: number };

export const claudeEndpointPath = (machine: string, pane: string) => join(tmpdir(), `cb-seat-${seatKey(machine, pane)}.claude.json`);

/** Atomic: a reader sees the old file or the new one, never half of it. `pid` is for people reading the file only. */
export function writeClaudeEndpoint(machine: string, pane: string, ep: { socket: string; token: string; pid?: number }): void {
  const file = claudeEndpointPath(machine, pane), tmp = `${file}.tmp.${process.pid}`;
  try {
    // Always a fresh file: `mode` only applies on create, so a leftover temp file would keep its old (maybe wider) mode.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, JSON.stringify({ socket: ep.socket, token: ep.token, pid: ep.pid, updatedAt: Date.now() }), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

function parseEndpoint(file: string): ClaudeEndpoint | null {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    if (!o || typeof o.socket !== 'string' || typeof o.token !== 'string' || !o.socket || !o.token) return null;
    return { socket: o.socket, token: o.token, pid: typeof o.pid === 'number' ? o.pid : undefined, updatedAt: Number(o.updatedAt) || 0 };
  } catch { return null; }
}

/** The endpoint, or null when there is no file or it is not one. */
export function readClaudeEndpoint(machine: string, pane: string): ClaudeEndpoint | null {
  return parseEndpoint(claudeEndpointPath(machine, pane));
}

/**
 * Remove the file; with `expectedSocket`, only when it still names that socket. The file is claimed by rename first, so a
 * newer Claude's rewrite can never be deleted by a check-then-remove race. Never throws, never leaves the claim file.
 */
export function clearClaudeEndpoint(machine: string, pane: string, expectedSocket?: string): void {
  const file = claudeEndpointPath(machine, pane);
  if (expectedSocket === undefined) { try { rmSync(file, { force: true }); } catch {} return; }
  const claimed = `${file}.clear.${process.pid}`;
  try { renameSync(file, claimed); } catch { return; } // no file, or busy: nothing to do
  try {
    if (parseEndpoint(claimed)?.socket !== expectedSocket) {
      // A newer Claude's endpoint: put it back unless an even newer one landed meanwhile.
      if (!existsSync(file)) { try { renameSync(claimed, file); } catch {} }
    }
  } finally { try { rmSync(claimed, { force: true }); } catch {} }
}

/** One line per connection, opened only when the message is ready (Claude closes idle connections). Same as cli/relay.ts. */
function post(ep: ClaudeEndpoint, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.connect(ep.socket, () => {
      c.end(JSON.stringify({ type: 'auth', token: ep.token }) + '\n' +
            JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    });
    c.setTimeout(5000, () => c.destroy(new Error('inbox timeout')));
    c.on('error', reject);
    c.on('close', (hadError) => (hadError ? null : resolve()));
  });
}

const STATES = new Set<string>(['idle', 'working', 'blocked', 'done']);
const QUOTA = /usage limit reached|you['’]ve hit your (?:usage )?limit|(?:5-hour|weekly|session) limit reached|out of extra usage/i;
const RATE = /rate[ _-]?limit|\b429\b|overloaded_error/i;

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',
  relayStart: 'session-hook',

  // The args after `--` of `herdr agent start <name> --kind claude --pane <pane>`, as cli/squad-up.ts has always sent them.
  buildLaunch(l) {
    return {
      kind: 'claude',
      args: ['--model', l.model, '--permission-mode', 'bypassPermissions', '--settings', `${l.board.replace(/[\/]+$/, '')}/kit/permissions/${l.role}.json`],
      env: { ...(l.env ?? {}) },
    };
  },

  async deliver(seat, text) {
    const ep = readClaudeEndpoint(seat.machine, seat.pane);
    if (!ep) throw new Error('no claude endpoint for this seat');
    try { return await post(ep, text); }
    catch (e) {
      // A new Claude rewrote the endpoint between our read and our connect: retry once on what the file says now.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw e;
      const now = readClaudeEndpoint(seat.machine, seat.pane);
      if (!now || (now.socket === ep.socket && now.token === ep.token)) throw e;
      return await post(now, text);
    }
  },

  async isAlive(seat) {
    const ep = readClaudeEndpoint(seat.machine, seat.pane);
    return Boolean(ep && existsSync(ep.socket));
  },

  async readStatus(_seat, herdrAgent) {
    const s = herdrAgent?.agent_status ?? '';
    const state: AgentState = STATES.has(s) ? (s as AgentState) : 'unknown';
    return { state, safeToClose: state === 'idle' || state === 'done' }; // cli/supervise-plan.ts READY
  },

  async close(seat: SeatHandle, run) {
    if (!seat.herdrName) return 'failed';
    const r = run(seat.herdr ?? null, ['agent', 'prompt', seat.herdrName, '/exit'], 30_000);
    return r.status === 0 && !r.error ? 'sent' : 'failed';
  },

  detectQuotaStop(_seat, _herdrAgent, paneTail): QuotaSignal | null {
    if (!paneTail) return null;
    const q = QUOTA.exec(paneTail);
    if (q) return { kind: 'quota', raw: q[0] };
    const r = RATE.exec(paneTail);
    return r ? { kind: 'rate_limit', raw: r[0] } : null;
  },

  guardInstallSpec(boardDir) {
    return {
      targetPath: '~/.claude/settings.json',
      shimFile: `${boardDir.replace(/[\/\\]+$/, '')}/kit/guard/shim-claude.mjs`,
      matchers: { win32: 'Bash|PowerShell', darwin: 'Bash', linux: 'Bash' },
      notes: 'PreToolUse hook in the user settings; per-role permissions come from kit/permissions/<role>.json',
    };
  },

  instructionMapping() {
    return { nativeFiles: ['CLAUDE.md', '~/.claude/CLAUDE.md'], extraArgs: [], env: {}, note: 'Claude Code reads CLAUDE.md natively' };
  },

  trustSpec() {
    return { dialogHint: 'folder trust or bypass warning', extraArgs: [] };
  },

  disableAskSpec() {
    return { toolName: 'AskUserQuestion', mechanism: 'hook', target: 'hooks/deny-ask.mjs' };
  },
};
