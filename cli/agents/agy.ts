// The Antigravity CLI (`agy`) adapter, a trial (#4002 phase 5). Pure: no database, no files. Everything it does to a seat
// goes through herdr (the Runner type squad-up.ts already defines), because agy has no inbox of its own: a message is a
// bracketed paste into its TUI (`herdr agent prompt`), liveness is `herdr agent get`, status is herdr's screen detection.
// Design note: docs/superpowers/specs/2026-11-26-agy-adapter-design.md (what is verified on agy 1.5.17 and what is not).
import { classifyAgentGet, realRun, type Runner } from '../squad-up.ts';
import type { AgentAdapter, AgentState, DisableAskSpec, LaunchInput, QuotaSignal, SeatHandle } from './types.ts';

const STATES = new Set<string>(['idle', 'working', 'blocked', 'done']);
const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
/** The same rule as cb._check_model for agy (spec section 3): a plain id, never a bare Claude alias. */
export const AGY_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Throws on a model agy cannot be given. '' is allowed: no --model, agy's own default. */
export function checkAgyModel(model: string): void {
  if (model === '') return;
  if (CLAUDE_ALIASES.has(model.toLowerCase())) throw new Error(`agy model "${model}" is a Claude alias: name an agy model id (agy models)`);
  if (!AGY_MODEL.test(model)) throw new Error(`agy model "${model}" is not an id: letters, digits, . _ - only (agy models lists them)`);
}

// Claude-only secrets and markers a non-Claude seat must not inherit (the owner's standing rule): CLAUDE_CODE_*, ANTHROPIC_*, CLAUDECODE.
const isClaudeOnly = (k: string) => /^(?:CLAUDE_CODE_|ANTHROPIC_)/i.test(k) || ['CLAUDECODE', 'GITHUB_PERSONAL_ACCESS_TOKEN'].includes(k.toUpperCase());

// Stops, from agy's own strings (agy.exe 1.5.17) and the changelog: a spent quota stops the turn at once; a per-minute
// 429 is retried by agy for up to 4 minutes, so it is a rate limit, not a stop.
// Only the last lines are read (the agent's own output sits above them), and only banner wording: a bare "429" or
// "rate limit" in code or prose is not a stop. Line-start anchors for the status-code forms.
const TAIL_LINES = 6;
const QUOTA = /exhausted your quota on this model|^\W*(?:AI:\s*)?out of credits\b|prepaid balance is insufficient|spend(?:ing)? cap (?:reached|exceeded|hit)/im;
const RATE = /rate limit active for [^\s;.,]+|^\W*(?:error:?\s*)?(?:429\b|RESOURCE_EXHAUSTED\b)/im;
const RETRY = /retry in (\d+)\s*s/i;

const trimSlash = (s: string) => s.replace(/[\/\\]+$/, '');
const ok = (r: { status: number | null; error?: unknown }) => r.status === 0 && !r.error;

/** `run` is the herdr runner; a test passes a fake. */
export function createAgyAdapter(run: Runner): AgentAdapter {
  return {
    kind: 'agy',
    // No session hook can hand a relay anything (agy has no inbox socket), so the relay is started with the pane.
    relayStart: 'pane-prestart',

    // `herdr agent start <name> --kind agy --pane <pane> -- <args>`. --mode auto = OS sandbox plus a reviewer for what
    // leaves it (never --dangerously-skip-permissions: the owner's classifier denied it). --settings is this session only.
    buildLaunch(l: LaunchInput) {
      checkAgyModel(l.model);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(l.env ?? {})) if (!isClaudeOnly(k)) env[k] = v;
      env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'; // a pinned version: herdr's screen rules are tuned per version
      return {
        kind: 'agy',
        args: ['--mode', 'auto', '--settings', `${trimSlash(l.board)}/kit/agy/settings.json`, ...(l.model ? ['--model', l.model] : [])],
        env,
      };
    },

    // Bracketed paste plus Enter, the text as given (opts.raw changes nothing here). agy queues it while busy
    // (queuedMessages "queue"). herdr refuses a blocked agent (agent_blocked) before sending a byte: that throws, so the
    // relay keeps the message. A leading "-" is safe: herdr takes it as the text (run against a missing agent, which
    // answered agent_not_found, not a usage error). A leading "/" opening slash autocomplete was fixed in agy 1.1.9
    // (report E); not re-checked on a live 1.5.17.
    async deliver(seat, text) {
      if (!seat.herdrName) throw new Error('no herdr agent name for this seat');
      const r = run(seat.herdr ?? null, ['agent', 'prompt', seat.herdrName, text], 30_000);
      if (!ok(r)) throw new Error(`herdr agent prompt failed: ${String(r.error?.message ?? r.stderr ?? r.stdout ?? '').trim().slice(0, 200)}`);
    },

    // `herdr agent get`: exit 0 running, agent_not_found gone, anything else unknown (counts as alive: never kill a healthy relay).
    async isAlive(seat) {
      if (!seat.herdrName) return true;
      return classifyAgentGet(run(seat.herdr ?? null, ['agent', 'get', seat.herdrName], 15_000)) !== 'absent';
    },

    // herdr's screen scraping is the only status (the statusLine JSON is a local script on the seat's machine; see the note).
    async readStatus(_seat, herdrAgent) {
      const s = herdrAgent?.agent_status ?? '';
      const state: AgentState = STATES.has(s) ? (s as AgentState) : 'unknown';
      return { state, safeToClose: state === 'idle' || state === 'done', detail: state === 'idle' ? 'idle: background subagents may still run' : undefined };
    },

    // `/exit` is documented (agy builtin cli.md: "Ctrl+D Ctrl+D (or /exit or /quit)") but UNVERIFIED through herdr on a live
    // agy: 'sent' means the text was submitted, not that agy exited. The supervisor must confirm closure through isAlive.
    async close(seat: SeatHandle, r) {
      if (!seat.herdrName) return 'failed';
      return ok(r(seat.herdr ?? null, ['agent', 'prompt', seat.herdrName, '/exit'], 30_000)) ? 'sent' : 'failed';
    },

    detectQuotaStop(_seat, _herdrAgent, paneTail?: string): QuotaSignal | null {
      if (!paneTail) return null;
      paneTail = paneTail.split(/\r?\n/).filter((l) => l.trim()).slice(-TAIL_LINES).join('\n');
      const q = QUOTA.exec(paneTail);
      if (q) return { kind: 'quota', raw: q[0] };
      const m = RATE.exec(paneTail);
      if (!m) return null;
      const retry = RETRY.exec(paneTail);
      return { kind: 'rate_limit', raw: m[0], ...(retry ? { retryAfterSec: Number(retry[1]) } : {}) };
    },

    // Per seat, never the global ~/.gemini/config/hooks.json (that applies to every agy session on the machine, the owner's
    // hand-started ones included). The target is the seat's workspace file, relative to the seat's cwd; the installer keeps
    // it out of git (.git/info/exclude). Hooks in the per-session --settings file are not loaded (report E 4.3: "Hooks in
    // settings.json are not loaded"), so that route is out. The matcher is a catch-all: the shim sees every tool and
    // denies the ones it cannot judge. Workspace hooks load only after trust (report E; not verified live).
    guardInstallSpec(boardDir) {
      return {
        targetPath: '.agents/hooks.json',
        shimFile: `${trimSlash(boardDir)}/kit/guard/shim-agy.mjs`,
        matchers: { win32: '.*', darwin: '.*', linux: '.*' },
        notes: 'per-seat workspace file under the seat cwd, excluded from git; group cb-guard, event PreToolUse, type command, forward slashes and no quotes (Windows runs hooks through cmd /c); a hook MUST print {"decision":"allow"} to allow, {} counts as deny; the shim denies a pane with no CB_ROLE or CB_AGENT',
      };
    },

    // agy never reads CLAUDE.md. AGENTS.md and GEMINI.md load from the launch folder up to the repo root; iHop's AGENTS.md
    // is a bootstrap that points at CLAUDE.md.
    instructionMapping() {
      return {
        nativeFiles: ['AGENTS.md', 'GEMINI.md', '.agents/rules/*.md', '~/.gemini/AGENTS.md', '~/.gemini/config/rules/*.md'],
        extraArgs: [],
        env: {},
        note: 'agy does not read CLAUDE.md: a repo needs an AGENTS.md (or an always_on rule) that points at it',
      };
    },

    // trustedWorkspaces holds native Windows paths (this PC's settings.json: ["C:\\Users\\Fast_"]); never written here.
    trustSpec() {
      return { dialogHint: 'Do you trust the contents of this project?', preseedPath: '~/.gemini/antigravity-cli/settings.json', extraArgs: [] };
    },

    disableAskSpec(): DisableAskSpec {
      return { toolName: 'ask_question', mechanism: 'hook', target: 'kit/guard/shim-agy.mjs' };
    },
  };
}

// realRun is read when a call is made, never at import: squad-up.ts imports the registry that imports this file.
export const agyAdapter = createAgyAdapter((m, a, t) => realRun(m, a, t));
