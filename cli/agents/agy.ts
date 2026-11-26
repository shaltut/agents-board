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

// Claude-only secrets a non-Claude seat must not inherit (the owner's standing rule), and every CLAUDE_CODE_* variable.
const isClaudeOnly = (k: string) => /^CLAUDE_CODE_/i.test(k) || k.toUpperCase() === 'GITHUB_PERSONAL_ACCESS_TOKEN';

// Stops, from agy's own strings (agy.exe 1.5.17) and the changelog: a spent quota stops the turn at once; a per-minute
// 429 is retried by agy for up to 4 minutes, so it is a rate limit, not a stop.
const QUOTA = /exhausted your quota on this model|out of credits|prepaid balance is insufficient|spend(?:ing)? cap/i;
const RATE = /rate limit active for|rate[ _-]?limit|RESOURCE_EXHAUSTED|\b429\b/i;
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

    // Bracketed paste plus Enter; agy queues it while a turn runs (queuedMessages "queue", the default). herdr refuses a
    // blocked agent (agent_blocked) before sending a byte: that throws, so the relay keeps the message and retries.
    async deliver(seat, text) {
      if (!seat.herdrName) throw new Error('no herdr agent name for this seat');
      // clap reads a leading "-" as a flag, and a leading "/" opens agy's slash autocomplete: a space first, same text.
      const body = /^[-/]/.test(text) ? ` ${text}` : text;
      const r = run(seat.herdr ?? null, ['agent', 'prompt', seat.herdrName, body], 30_000);
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

    // `/exit` is documented (agy's CLI reference: "Ctrl+D Ctrl+D (or /exit or /quit)").
    async close(seat: SeatHandle, r) {
      if (!seat.herdrName) return 'failed';
      return ok(r(seat.herdr ?? null, ['agent', 'prompt', seat.herdrName, '/exit'], 30_000)) ? 'sent' : 'failed';
    },

    detectQuotaStop(_seat, _herdrAgent, paneTail): QuotaSignal | null {
      if (!paneTail) return null;
      const q = QUOTA.exec(paneTail);
      if (q) return { kind: 'quota', raw: q[0] };
      const m = RATE.exec(paneTail);
      if (!m) return null;
      const retry = RETRY.exec(paneTail);
      return { kind: 'rate_limit', raw: m[0], ...(retry ? { retryAfterSec: Number(retry[1]) } : {}) };
    },

    // The global hooks file: workspace .agents/hooks.json loads only after trust and per repo. The shim fails closed.
    guardInstallSpec(boardDir) {
      const matcher = 'run_command|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|ask_question';
      return {
        targetPath: '~/.gemini/config/hooks.json',
        shimFile: `${trimSlash(boardDir)}/kit/guard/shim-agy.mjs`,
        matchers: { win32: matcher, darwin: matcher, linux: matcher },
        notes: 'group cb-guard, event PreToolUse, type command, forward slashes and no quotes (Windows runs hooks through cmd /c); a hook MUST print {"decision":"allow"} to allow, {} counts as deny',
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
