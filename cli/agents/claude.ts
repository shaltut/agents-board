// The Claude Code adapter. Pure: no database. Claude hands its messaging socket and token to the relay through an
// endpoint file in the temp dir (hooks/claude-endpoint.mjs or the relay launcher); deliver() below is the only sender.
// The token lives only in that file and the auth line: it is never logged or put in an error message.
import net from 'node:net';
import { existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * newer Claude's rewrite is not removed by a check-then-remove race. A non-matching file is put back with a hard link,
 * which refuses to overwrite a newer one; while it is claimed the file is briefly absent (only the pane's relay, which
 * holds its lock, calls this). On a filesystem without hard links the fallback (check, then rename back) can still
 * overwrite an endpoint written in that instant. Does not throw; removing the claim file is best effort.
 */
export function clearClaudeEndpoint(machine: string, pane: string, expectedSocket?: string): void {
  const file = claudeEndpointPath(machine, pane);
  if (expectedSocket === undefined) { try { rmSync(file, { force: true }); } catch {} return; }
  const claimed = `${file}.clear.${process.pid}`;
  try { renameSync(file, claimed); } catch { return; } // no file, or busy: nothing to do
  try {
    if (parseEndpoint(claimed)?.socket !== expectedSocket) {
      // A newer Claude's endpoint: put it back unless an even newer one landed meanwhile.
      try { linkSync(claimed, file); } // EEXIST: an even newer endpoint landed, so drop the claim
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' && !existsSync(file)) { try { renameSync(claimed, file); } catch {} } // no hard links here
      }
    }
  } finally { try { rmSync(claimed, { force: true }); } catch {} }
}

/** One line per connection, opened only when the message is ready (Claude closes idle connections). The relay's only path in. */
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

/** existsSync reads EBUSY on a busy named pipe as "missing" (the stat connects to it); only ENOENT means gone. */
export function socketExists(path: string): boolean {
  try { statSync(path); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

/** The env a relaunched relay gets: the parent's, without the first Claude's inbox (socket and token). The endpoint
 *  file is the only way a relay learns of one, so a relaunch never serves a dead first Claude's. */
export function relaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_MESSAGING_SOCKET: _s, CLAUDE_CODE_MESSAGING_TOKEN: _t, ...rest } = env;
  return rest;
}

/** Connect and hang up without sending a byte. False only when nothing listens (or, on macOS, its accept queue is full):
 *  ECONNREFUSED / ENOENT. */
export function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const c = net.connect(path);
    const finish = (alive: boolean) => { if (done) return; done = true; clearTimeout(timer); c.destroy(); resolve(alive); };
    const timer = setTimeout(() => finish(true), 1000);
    c.on('connect', () => finish(true));
    c.on('error', (e: NodeJS.ErrnoException) => finish(e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT'));
  });
}

const STATES = new Set<string>(['idle', 'working', 'blocked', 'done']);
const QUOTA = /usage limit reached|you['’]ve hit your (?:usage )?limit|(?:5-hour|weekly|session) limit reached|out of extra usage/i;
const RATE = /rate[ _-]?limit|\b429\b|overloaded_error/i;

// #4346 review I1: a seat runs with bypassPermissions, so its --settings file is the whole fence. A missing role file,
// truncated JSON or a deny list without the fence would start a seat with no fence, so the launch is refused instead.
// Checked on this checkout's copy: the seat's own path (l.board) may be on another machine, but it is the same repo.
const PERMISSIONS = new URL('../../kit/permissions/', import.meta.url);
export function checkRoleSettings(role: string, dir: string | URL = PERMISSIONS) {
  const file = typeof dir === 'string' ? join(dir, `${role}.json`) : new URL(`${role}.json`, dir);
  const where = typeof file === 'string' ? file : `kit/permissions/${role}.json`;
  const refuse = (why: string): never => { throw new Error(`refusing to start a ${role} seat: ${where} ${why}`); };
  if (!/^[a-z][a-z0-9-]*$/.test(role)) refuse('is not a role file name');
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return refuse('does not exist'); }
  let f: any;
  try { f = JSON.parse(text); } catch { return refuse('is not valid JSON'); }
  const deny = f?.permissions?.deny;
  if (!Array.isArray(deny)) refuse('has no permissions.deny list');
  for (const must of ['mcp__*', 'PowerShell']) if (!deny.includes(must)) refuse(`does not deny ${must}`);
}

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',
  relayStart: 'session-hook',

  // The args after `--` of `herdr agent start <name> --kind claude --pane <pane>`, as cli/squad-up.ts has always sent them.
  // #4346: --strict-mcp-config with an empty --mcp-config loads no MCP server at all (no process spawned with the
  // seat's env), on top of the mcp__* deny in the role file. Checked live: 83 MCP tools without, 0 with either.
  buildLaunch(l) {
    checkRoleSettings(l.role);
    const board = l.board.replace(/[\/]+$/, '');
    return {
      kind: 'claude',
      args: ['--model', l.model, '--permission-mode', 'bypassPermissions', '--settings', `${board}/kit/permissions/${l.role}.json`,
        '--strict-mcp-config', '--mcp-config', `${board}/kit/mcp/none.json`],
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

  // A dead owner on macOS can leave its unix socket file behind, so on POSIX a file is not enough: connect and send
  // nothing. Unknown outcomes count as alive, so a slow machine never kills a healthy relay. A Windows pipe vanishes
  // with its owner.
  async isAlive(seat) {
    const ep = readClaudeEndpoint(seat.machine, seat.pane);
    if (!ep || !socketExists(ep.socket)) return false;
    if (process.platform === 'win32') return true;
    return probeSocket(ep.socket);
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
