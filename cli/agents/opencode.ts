// The OpenCode adapter (#4002 phase 3). Pure: no database. OpenCode runs its TUI and a loopback HTTP server in one process
// (`opencode <dir> --port <p>`); the relay (on the seat's own machine) reaches it through an endpoint file written before
// the pane starts the agent, like Claude's. The password lives only in that file and the pane env: never logged, never in argv.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatKey } from '../bridge.ts';
import type { AgentAdapter, AgentState, LaunchInput, QuotaSignal, SeatHandle } from './types.ts';

export type OpencodeEndpoint = { port: number; password: string; username?: string; updatedAt: number };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** provider/model, the spec's section 3 regex for opencode (cb._check_model). */
export const OPENCODE_MODEL = /^[a-z0-9][a-z0-9._-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;
export const opencodeEndpointPath = (machine: string, pane: string) => join(tmpdir(), `cb-seat-${seatKey(machine, pane)}.opencode.json`);

const validPort = (p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535;

/** Atomic and 0600: a reader sees the old file or the new one. The caller (squad-up, before `herdr agent start`) picks the port and password. */
export function writeOpencodeEndpoint(machine: string, pane: string, ep: { port: number; password: string; username?: string }): void {
  if (!validPort(ep.port) || !ep.password) throw new Error('opencode endpoint needs a port 1024-65535 and a password');
  const file = opencodeEndpointPath(machine, pane), tmp = `${file}.tmp.${process.pid}`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, JSON.stringify({ port: ep.port, password: ep.password, username: ep.username, updatedAt: Date.now() }), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

export function readOpencodeEndpoint(machine: string, pane: string): OpencodeEndpoint | null {
  try {
    const o = JSON.parse(readFileSync(opencodeEndpointPath(machine, pane), 'utf8'));
    if (!o || !validPort(o.port) || typeof o.password !== 'string' || !o.password) return null;
    return { port: o.port, password: o.password, username: typeof o.username === 'string' ? o.username : undefined, updatedAt: Number(o.updatedAt) || 0 };
  } catch { return null; }
}

export function clearOpencodeEndpoint(machine: string, pane: string): void {
  try { rmSync(opencodeEndpointPath(machine, pane), { force: true }); } catch {}
}

/** The folder rule of ~/.local/bin/freellm.ps1, mirrored: the free router may train on what it sees, so under F:\Work only
 *  TactiAI and arabcomputers. Null when allowed, else the refusal. Only applied when the model's provider is freellmapi. */
export function freellmRefusal(cwd: string): string | null {
  const p = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/';
  if (!p.startsWith('f:/work/')) return null;
  return p.startsWith('f:/work/tactiai/') || p.startsWith('f:/work/arabcomputers/') ? null
    : `freellmapi refused for ${cwd}: free providers may keep or train on code; only F:\\Work\\TactiAI and F:\\Work\\arabcomputers (or folders outside F:\\Work) are allowed`;
}

/** The env the caller gave, minus Claude-only secrets (a non-Claude seat never inherits them). */
export function opencodeEnv(env: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === 'GITHUB_PERSONAL_ACCESS_TOKEN' || k.toUpperCase().startsWith('CLAUDE_CODE_')) continue;
    out[k] = v;
  }
  return out;
}

const STATES = new Set<string>(['idle', 'working', 'blocked', 'done']);
const QUOTA = /FreeUsageLimitError|insufficient[_ ]quota|(?:usage|free) limit (?:reached|exceeded)|quota (?:exceeded|exhausted)|out of credits|credit balance is too low/i;
const RATE = /rate[ _-]?limit|\b429\b|too many requests|retrying in \d+/i;
const RETRY = /(?:retry(?:ing)?|try again) (?:in|after) (\d+)\s*(s|sec|seconds|m|min|minutes)\b/i;

const auth = (ep: OpencodeEndpoint) => 'Basic ' + Buffer.from(`${ep.username || 'opencode'}:${ep.password}`).toString('base64');
const base = (ep: OpencodeEndpoint) => `http://127.0.0.1:${ep.port}`;
const TIMEOUT = 5000;

/** The newest session (by time.updated) of a v1 `GET /session` answer: an array, or { data | items: [...] }. */
export function newestSession(body: unknown): string | null {
  const b = body as any;
  const list = Array.isArray(b) ? b : Array.isArray(b?.data) ? b.data : Array.isArray(b?.items) ? b.items : [];
  let best: { id: string; t: number } | null = null;
  for (const s of list) {
    if (!s || typeof s.id !== 'string') continue;
    const t = Number(s.time?.updated ?? s.time?.created ?? s.updated ?? 0) || 0;
    if (!best || t >= best.t) best = { id: s.id, t };
  }
  return best?.id ?? null;
}

export function makeOpencodeAdapter(f: Fetch = (u, i) => fetch(u, i), readEp: typeof readOpencodeEndpoint = readOpencodeEndpoint): AgentAdapter {
  const call = (ep: OpencodeEndpoint, path: string, init: RequestInit = {}) =>
    f(base(ep) + path, { ...init, headers: { authorization: auth(ep), 'content-type': 'application/json', ...(init.headers as object) }, signal: AbortSignal.timeout(TIMEOUT) });

  return {
    kind: 'opencode',
    relayStart: 'pane-prestart',

    // Through `herdr agent start <name> --kind opencode --pane <p> -- <args>`: herdr runs the bare `opencode` executable, so the
    // freellm.ps1 wrapper (folder guard) is NOT in this path; freellmRefusal() re-applies its folder rule here, and the env
    // sets what the wrapper sets. The caller must supply CB_OPENCODE_PORT and OPENCODE_SERVER_PASSWORD in `env` (the same
    // pair it wrote with writeOpencodeEndpoint): a seat nobody can reach is not started.
    buildLaunch(l: LaunchInput) {
      if (!OPENCODE_MODEL.test(l.model ?? '')) throw new Error(`opencode model must be provider/model (got ${JSON.stringify(l.model)})`);
      if (l.model.startsWith('freellmapi/')) { const r = freellmRefusal(l.cwd); if (r) throw new Error(r); }
      const env = opencodeEnv(l.env);
      const port = Number(env.CB_OPENCODE_PORT);
      if (!validPort(port)) throw new Error('opencode launch needs env CB_OPENCODE_PORT (1024-65535)');
      if (!env.OPENCODE_SERVER_PASSWORD) throw new Error('opencode launch needs env OPENCODE_SERVER_PASSWORD');
      return {
        kind: 'opencode',
        args: [l.cwd, '--hostname', '127.0.0.1', '--port', String(port), '-m', l.model, '--auto'],
        env: { ...env, OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' },
      };
    },

    // v1 `POST /session/<id>/prompt_async` (204; queues behind a running turn) on the newest session of `GET /session`.
    async deliver(seat: SeatHandle, text: string) {
      const ep = readEp(seat.machine, seat.pane);
      if (!ep) throw new Error('no opencode endpoint for this seat');
      const list = await call(ep, '/session');
      if (!list.ok) throw new Error(`opencode session list answered ${list.status}`);
      const id = newestSession(await list.json());
      if (!id) throw new Error('opencode has no session yet');
      const r = await call(ep, `/session/${encodeURIComponent(id)}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text }] }) });
      if (!r.ok) throw new Error(`opencode prompt answered ${r.status}`);
    },

    // `GET /global/health`. Only a refused connection is dead; a timeout or any HTTP answer (even 401) counts as alive.
    async isAlive(seat) {
      const ep = readEp(seat.machine, seat.pane);
      if (!ep) return false;
      try { await call(ep, '/global/health'); return true; }
      catch (e) {
        const code = (e as any)?.cause?.code ?? (e as any)?.code;
        return code !== 'ECONNREFUSED' && code !== 'ENOENT';
      }
    },

    async readStatus(_seat, herdrAgent) {
      const s = herdrAgent?.agent_status ?? '';
      const state: AgentState = STATES.has(s) ? (s as AgentState) : 'unknown';
      return { state, safeToClose: state === 'idle' || state === 'done' };
    },

    async close(seat, run) {
      if (!seat.herdrName) return 'failed';
      const r = run(seat.herdr ?? null, ['agent', 'prompt', seat.herdrName, '/exit'], 30_000);
      return r.status === 0 && !r.error ? 'sent' : 'failed';
    },

    detectQuotaStop(_seat, _herdrAgent, paneTail): QuotaSignal | null {
      if (!paneTail) return null;
      const retry = RETRY.exec(paneTail);
      const sec = retry ? Number(retry[1]) * (/^m/i.test(retry[2]!) ? 60 : 1) : undefined;
      const q = QUOTA.exec(paneTail);
      if (q) return { kind: 'quota', raw: q[0], ...(sec !== undefined ? { retryAfterSec: sec } : {}) };
      const r = RATE.exec(paneTail);
      return r ? { kind: 'rate_limit', raw: r[0], ...(sec !== undefined ? { retryAfterSec: sec } : {}) } : null;
    },

    guardInstallSpec(boardDir) {
      const t = 'bash|powershell|edit|write|patch|apply_patch|multiedit|question';
      return {
        targetPath: '~/.config/opencode/plugins/cb-guard.js',
        shimFile: `${boardDir.replace(/[\/\\]+$/, '')}/kit/guard/shim-opencode.mjs`,
        matchers: { win32: t, darwin: t, linux: t },
        notes: 'A plugin whose tool.execute.before runs the shim for these tools and throws Error(reason) on {"decision":"block"}; the plugin must itself throw if the shim fails',
      };
    },

    instructionMapping() {
      return {
        nativeFiles: ['AGENTS.md', 'CLAUDE.md (project, fallback only)', '~/.config/opencode/AGENTS.md'],
        extraArgs: [],
        env: { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1' },
        note: '~/.config/opencode/AGENTS.md exists on purpose so OpenCode never falls back to ~/.claude/CLAUDE.md; the env flag is what freellm.ps1 sets',
      };
    },

    trustSpec() {
      return { dialogHint: 'none expected: OpenCode has no folder-trust dialog (--auto answers permission prompts)', extraArgs: [] };
    },

    disableAskSpec() {
      return { toolName: 'question', mechanism: 'permission', target: '~/.config/opencode/opencode.jsonc permission.question = "deny"' };
    },
  };
}

export const opencodeAdapter: AgentAdapter = makeOpencodeAdapter();
