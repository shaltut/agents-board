# Agent-Neutral Core (Phase 1) Design

Card #4002 · 2026-11-26 · Phase 1 of 5 · Status: proposed (awaiting Ahmed's approval before build).

Builds on `2026-11-22-squad-design.md`, `2026-11-23-squad-kit-design.md`, `2026-11-23-supervisor-design.md`, `2026-11-23-repos-in-project-design.md` and `2026-11-24-lead-by-role-and-ado-prs-design.md`. Code verified at `46de6b7`. Phase 0 research references below cite `phase 0 report A/B/C/D/E (card #4002)` and `phase 0 summary (card #4002)`.

## Why

Every squad seat today is hard-wired to Claude Code in four places:
1. **Launch:** `cli/squad-up.ts:190` hard-codes `--kind claude` and Claude-only flags (`--permission-mode bypassPermissions --settings kit/permissions/<role>.json`); `cb.squad_set` (`db/schema.sql:4636-4640`) accepts only `count`/`model`/`machine` and Claude model aliases (`opus|sonnet|haiku|fable`).
2. **Delivery and liveness:** `cli/relay.ts:16-19` exits unless `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` exist, is started by Claude's `SessionStart` hook or `cb relay` (`cli/cb.ts:573`), and is the only *periodic* writer of `cb.sessions.last_seen` (`cb.iam` sets it once on bind at `db/schema.sql:1513`; `cb.inbox` refreshes it every 30 s at `:1537`). A non-Claude seat gets no board pushes and reads "down" after 90 s (`db/schema.sql:1690,5064`).
3. **Close and status:** `cli/supervise.ts:176` closes seats by prompting `/exit`, and `cli/supervise-plan.ts:17,83` treats herdr's `idle`/`done` as universally safe to close.
4. **Safety fences:** role deny lists live in Claude settings JSON (`kit/permissions/<role>.json`, 73–84 rules), `kit/hooks/block-dangerous.mjs` is wired only in `~/.claude/settings.json` and fails open on unreadable input (`kit/hooks/block-dangerous.mjs:264,274`), and `hooks/deny-ask.mjs` matches only `AskUserQuestion`.

Phase 1 splits the board core from Claude Code so Codex (Phase 2), OpenCode v2 (Phase 3), routing/failover policy (Phase 4) and an Antigravity trial (Phase 5) plug in without another core rewrite.

## Owner decisions already made

- Every project may use every agent Ahmed assigns. The squad file is the policy; the board keeps no separate per-project agent or provider allow list.
- Build phases: **1** agent-neutral core with Claude only (this spec); **2** Codex; **3** OpenCode v2; **4** policy (quota failover, cross-agent review, cost tiers, best agent per task); **5** Antigravity (`agy`) trial.
- Design before build: nothing gets coded until Ahmed approves this design.

## Goals, non-goals, anti-goals, constraints

- **Success test:** today's Claude squads on the PC (`shaltoot`) and Mac (`macbook`) run unchanged on the new core — same herdr launch flags, same messaging-socket delivery, same `cb` bridge speed, same safety fences, same supervisor close/restore timing.
- **Goals:** per-seat relay outside the CLI with liveness tied to the seat; one `AgentAdapter` contract covering all nine lifecycle needs with `claude` as Phase 1's only adapter; `agent`, per-agent model validation, per-seat overrides and ranked `fallback` in `cb.squad_set`; one role-aware, PowerShell-safe, fail-closed guard core with a Claude shim; staged zero-downtime rollout.
- **Non-goals:** Codex, OpenCode or `agy` adapter code; Phase 4 failover/routing policy; edits to any client repo (`iHop`, `QHS`, etc.); changing `cli/recipes.ts` or `runner.json`.
- **Anti-goals:** an agent clearing another agent's startup dialog or safety stop; a seat reporting `live = true` after its agent died; silent allow when a guard hook cannot parse input, misses its sibling module, or receives an unknown `CB_ROLE`; silently launching Claude when a squad asks for an unimplemented agent (in any forward or rollback state).
- **Constraints:** board rules live in idempotent `db/schema.sql` (`add column if not exists`, `drop function if exists ... cascade`, must pass `test/schema-fresh.test.ts` on an empty DB); Node 24 runs `.ts`/`.mjs` directly with zero new npm dependencies (`package.json:6-21`); `CLAUDE.md` test/release rules apply; every `case` in `cli/cb.ts` has a `cli/help.ts` entry (`test/help.test.ts:24-32`).

## Approaches

### 1. Seat relay outside the CLI and delivering to Claude

**Hard question from code:** Claude's inbox socket and bearer token (`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`) exist only in Claude's child process environment (`cli/relay.ts:16-19`). An outside process cannot discover them unless Claude exports them, and the relay must run on the **seat's own machine** (PC or Mac) because Claude's socket, the fast `cb` bridge (`cli/bridge.ts:20-25`, saving ~650 ms per call), OpenCode's loopback HTTP port (phase 0 report D, card #4002), and Codex's local queue SQLite (phase 0 report C, card #4002) are all machine-local.

| Option | How it works | Trade-off |
|---|---|---|
| **A. External per-seat relay keyed on `(machine, pane)` + temp Claude endpoint file (picked)** | One `cli/relay.ts` per seat, keyed on `sha1(machine:pane)` instead of `sha1(SOCKET)` (`cli/relay.ts:21`, `cli/cb.ts:67-68`). Owns Postgres `LISTEN`, heartbeat (`cb.inbox`), `cb` bridge, and calls `adapter.deliver()` / `adapter.isAlive()`. Claude's `SessionStart` hook writes a temp file `cb-seat-<key>.claude.json` (`{socket, token, pid}`, `0o600` on POSIX) and ensures the relay is up. | Same 2 Postgres connections/seat as today. Works unchanged with existing `~/.claude/settings.json` hook. Same per-user temp-dir boundary as `cli/bridge.ts:91`. One relay engine for all 4 CLIs. |
| **B. Keep in-session Claude relay for delivery; move only heartbeat outside** | Existing `cli/relay.ts` stays Claude-only; supervisor or a separate daemon writes `last_seen` for every seat. | Splits liveness from reachability: a dead Claude relay still reads `live = true`, so `cb tell` (`cli/cb.ts:539`) claims instant delivery and `cb.digest` (`db/schema.sql:4162`) hides uncollected answers. Supervisor's 60 s tick (`cli/supervise.ts:287`) races the 90 s liveness window (`db/schema.sql:1690`). Still requires building a second delivery relay in Phase 2. |
| **C. Drop Claude's socket; type into every pane via `herdr agent prompt` from one daemon** | One per-machine daemon reads `cb.inbox` for all seats and types via `herdr agent prompt`. | Fails the Phase 1 success test: loses Claude's silent out-of-band mid-turn delivery (`cli/relay.ts:4`), prints raw `[Claude Board]` blocks into Ahmed's panes, fails while dialogs are open (`agent_blocked`), and turns one crash or serial `sql` pool into a machine-wide outage. |

**Decision:** Pick **Option A** because it keeps Claude's exact socket delivery, connection budget, and `cb` bridge latency while making relay identity, heartbeat, bridge and delivery agent-neutral; **if wrong:** if Claude ever rotates its socket without firing `SessionStart`, the old socket disappears and the 2 s watchdog exits the relay (`cli/relay.ts:260-264`), so `last_seen` ages out in 90 s and the seat reads down (same failure mode as today); switching Claude delivery to `herdr agent prompt` is a half-day change inside `cli/agents/claude.ts`.

### 2. Squad file shape for `agent`, per-seat overrides and `fallback`

| Option | Shape | Trade-off |
|---|---|---|
| **A. Role-level `agent` + `fallback`, optional `seats` override map (picked)** | Keep `roles.<role>.{count, model, machine}` (`db/schema.sql:4636`); add optional `agent` (default `'claude'`), `fallback: [{agent, model}]` (0–5 items, Phase 4), and `seats: {<key>: {agent?, model?, fallback?}}`. | Existing `ihop` and `qhs` squads stay valid unchanged. Expresses mixed-agent seats inside one role (e.g. `reviewer` seat 1 Claude, seat 2 Codex) without inventing fake roles or losing per-repo `count` maps (`#3703`). |
| **B. Flat `seats: [...]` array replacing `roles`** | Every seat listed explicitly with name, role, repo, agent, model, machine. | Breaks every existing squad file, `cb squad show` (`cli/cb.ts:746-750`), and compact per-repo counts; 14+ objects to edit by hand for `ihop`. |
| **C. Role-level `agent` only (no `seats`)** | Add only `agent` and `fallback` on `roles.<role>`. | Smallest diff, but cannot run 1 Claude reviewer + 1 Codex reviewer or assign one area owner to Codex. |

**Decision:** Pick **Option A** because it preserves every live squad file and supports mixed-agent second-opinion seats in Phase 2/4; **if wrong:** `seats` is optional and isolated to one resolver helper (`seatSpec`), so simplifying or migrating it later touches only `cb.squad_set` and `cli/squad-up.ts`.

### 3. Unified guard layout and deployment to PC and Mac

| Option | How it deploys | Trade-off |
|---|---|---|
| **A. `kit/guard/` in repo, deployed atomically to `~/.claude-board/guard/` (picked)** | Pure `kit/guard/core.mjs` + thin per-CLI shims (`shim-claude.mjs` in Phase 1). `kit/guard/install.mjs` copies to `~/.claude-board/guard.new/`, runs 6 self-checks, swaps into `~/.claude-board/guard/` on PC and Mac (with Ahmed's OK). Retire the single-file copy of `kit/hooks/block-dangerous.mjs` everywhere; both `shim-claude.mjs` and the checkout wrapper load `core.mjs` via dynamic `await import(...)` inside `try/catch` so a missing sibling fails closed. | Matches `~/.claude-board/runner/` and `supervisor/` (`docs/ops/maintain.md:206,264`). `git pull`/`tar` never mutates Ahmed's live hooks silently; dynamic import + self-check ensure a broken or missing module never fails open (`docs/ops/maintain.md:96-97`); Codex's `hooks.json` path stays stable across `core.mjs` updates (phase 0 report C, card #4002). |
| **B. Point every CLI straight at `<board>/kit/guard/shim-*.mjs`** | No copy step; same as `hooks/deny-ask.mjs`. | Violates Ahmed's explicit-yes gate (`docs/ops/maintain.md:64,77`); a partial Mac tar extract or bad checkout commit breaks live guards across all sessions. |
| **C. Bundle one standalone file per CLI** | Build step emits single-file scripts into `~/.claude/hooks/`, `~/.codex/hooks/`, etc. | Adds a bundler/build step this repo deliberately avoids (`package.json:9-16`) or duplicates core logic across files. |

**Decision:** Pick **Option A** because atomic copy + dynamic fail-closed import + self-test removes the multi-file import footgun while preserving Ahmed's approval gate; **if wrong:** pointing `~/.claude/settings.json` back at the untouched pre-Phase-1 standalone `~/.claude/hooks/block-dangerous.mjs` rolls back in one edit.

## Design

### 1. Seat relay outside the CLI, with its own heartbeat

**Keying and bridge (`cli/relay.ts`, `cli/bridge.ts`, `cli/cb.ts`):**
- Add `seatKey(machine: string, pane: string): string` = `sha1(\`${machine.trim().toLowerCase()}:${pane.trim()}\`).slice(0, 12)` in `cli/bridge.ts`.
- Relay files in `tmpdir()` become `cb-relay-<seatKey>.pid`, `cb-relay-<seatKey>.log`, `cb-relay-<seatKey>.bridge` (and `.bridge.sock` / `\\.\pipe\cb-relay-bridge-<seatKey>`).
- **Test isolation under `seatKey`:** today's socket key (`cli/relay.ts:21`) makes test collisions impossible, whereas `seatKey` maps every test sharing `(CB_MACHINE='testbox', HERDR_PANE_ID='p7'|'p8'|'p9')` onto one temp-file set. Phase 1 updates all relay, bridge and hook tests to pass per-process, per-test unique pane IDs (including `process.pid`) and explicit `CB_MACHINE: 'testbox'` (never falling back to host `hostname()` at `server/db.ts:33`), and adds a concurrency test proving two simultaneous relays on one machine share zero lock, bridge or endpoint files.
- `cli/cb.ts:67-70` computes `seatKey(machine(), pane)` whenever `HERDR_PANE_ID` is set (and `!process.env.PGAPPNAME`), independent of `CLAUDE_CODE_MESSAGING_SOCKET`. For zero-downtime rollout while old relays finish restarting, `openBridge` and `relayOn()` (`cli/cb.ts:224-232`) check `seatKey(machine(), pane)` first and fall back once to legacy `sha1(CLAUDE_CODE_MESSAGING_SOCKET).slice(0, 12)`.
- `cb relay [--agent <kind>] [--restart]` (`cli/cb.ts:570-575`) requires only `HERDR_PANE_ID`. It resolves agent from `--agent`, `$CB_AGENT`, `cb.sessions.agent` (if bound), else `'claude'`. For `claude`, it still requires either `CLAUDE_CODE_MESSAGING_SOCKET` in env or a live endpoint file (otherwise errors clearly). `cb start` (`cli/cb.ts:246`) preserves `Relay unavailable` when a `claude` pane has neither a live relay nor a Claude socket/endpoint (`test/help.test.ts:129-130`).

**Claude socket hand-off (`hooks/claude-endpoint.mjs` + `cli/relay.ts`):**
- Endpoint file: `join(tmpdir(), \`cb-seat-${key}.claude.json\`)`, written atomically (`.tmp.<pid>` + `renameSync`, `0o600` on POSIX): `{ socket, token, pid, updatedAt }` (`pid` is informational for logs/debugging only).
- `cli/relay.ts` launcher (without `--child`): if `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` are in env, writes the endpoint file before spawning `--child --pane <pane> --agent <agent>` detached. Existing `~/.claude/settings.json` `SessionStart` (`node .../cli/relay.ts`, phase 0 report B, card #4002) works on PC and Mac with **zero config edit**. `hooks/claude-endpoint.mjs` is also shipped as the explicit lightweight hook entrypoint for future installs.
- Backward compatibility for existing `--child` callers (`test/relay.test.ts:72`, `test/bridge.test.ts:65`, `test/asks.test.ts:263`, `test/followup.test.ts:318`, `test/github.test.ts:670`, `test/sendback.test.ts:352`): when `--child` is spawned directly with `CLAUDE_CODE_MESSAGING_SOCKET` + `_TOKEN` in env and no newer endpoint file exists, it seeds the endpoint file at startup.

**Liveness-gated heartbeat and exit:**
- `cli/relay.ts` calls `await adapter.isAlive(seat)` **before** calling `cb.inbox(M, PANE, after)` (`cli/relay.ts:204`) and in its 2 s watchdog (`cli/relay.ts:257-273`). On the first `false` (launcher/seeder writes the endpoint file before `--child` enters `check()`), the relay stops calling `cb.inbox`, removes its endpoint file (only if `socket` matches), releases lock + bridge, and exits cleanly — `last_seen` stops updating and ages out in 90 s.
  - For `claude`: `isAlive` reads `cb-seat-<key>.claude.json` (reloading if mtime changed) and returns `existsSync(ep.socket)` — matching today's socket-existence guarantee (`cli/relay.ts:260`); it does not poll `ep.pid`.
  - For Phases 2–5 non-Claude adapters: `isAlive` plugs in each CLI's local liveness signal (OpenCode `/global/health`, Codex/agy pane agent check on a 30 s cadence) so a dead agent never stays green.
- `deliver()` has a hard timeout (5 s for Claude socket, `cli/relay.ts:85`; 15 s max for other adapters) so slow delivery never stalls the 30 s `cb.inbox` heartbeat past 90 s (`db/schema.sql:1690,5064`). If `deliver()` throws, `ask_delivered`, `broadcast_seen`, `answer_delivered` and `after` do **not** advance (`cli/relay.ts:216-228`), so messages retry without loss.
- `CODE` in `cli/relay.ts:47` adds `agents/index.ts` and `agents/claude.ts` so adapter changes trigger clean relay auto-restart (`cli/relay.ts:267-271`) and bump `cb-relay/<ver>`.

### 2. Agent adapter interface (`cli/agents/`)

Files: `cli/agents/types.ts` (interface + shared types), `cli/agents/claude.ts` (Phase 1 implementation), `cli/agents/index.ts` (registry: `getAdapter(kind)`, `AGENT_KINDS`, `isAgentKind`, `defaultModelFor(agent, role)`). Unregistered kinds (`codex`, `opencode`, `agy` in Phase 1) throw `agent "<kind>" is not installed yet (phase 1 supports claude only)` — never falling back to Claude.

```ts
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'agy';
export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type SeatHandle = { machine: string; pane: string; actor?: string; herdr?: string | null; herdrName?: string; agent: AgentKind };
export type LaunchSpec = { kind: string; args: string[]; env: Record<string, string> };
export type AgentStatus = { state: AgentState; safeToClose: boolean; detail?: string };
export type QuotaSignal = { kind: 'quota' | 'rate_limit'; retryAfterSec?: number; raw: string };
export type GuardInstallSpec = { targetPath: string; shimFile: string; matchers: Record<'win32' | 'darwin' | 'linux', string>; notes: string };
export type InstructionMapping = { nativeFiles: string[]; extraArgs: string[]; env: Record<string, string>; note: string };
export type TrustSpec = { dialogHint: string; preseedPath?: string; extraArgs: string[] };
export type DisableAskSpec = { toolName: string; mechanism: 'hook' | 'permission'; target: string };
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
}
```

**Integration points changed in Phase 1:**
- `cli/squad-up.ts:100-104,190,205`: `launchFor` carries `agent`, `board`, and sets `env.CB_ROLE = w.role` and `env.CB_AGENT = agent` (alongside `CB_PROTECTED_BRANCHES`); `startOne` resolves `getAdapter(l.agent)` before creating any pane, builds `herdr agent start` from `adapter.buildLaunch(l)` (byte-identical Claude argv), and uses `adapter.trustSpec(...).dialogHint` for `agent_not_ready`.
- `cli/supervise.ts:87,171,176,255`: `tick()` precomputes `safeToClose` per squad session via `await adapter.readStatus(...)` and passes it into pure `planTick` (`cli/supervise-plan.ts:83`, falling back to `READY.has(status)` when omitted); `closeOne` re-checks `safeToClose` and calls `await adapter.close(seat, run)` (`/exit` for Claude); supervisor version hash includes `agents/index.ts` and `agents/claude.ts`.
- `cli/relay.ts`: calls `adapter.isAlive` and `adapter.deliver`.

**How every CLI maps to the 9 adapter operations** (details from phase 0 reports A–E, card #4002):

| Operation | Claude (Phase 1) | Codex (Phase 2) | OpenCode v2 (Phase 3) | Antigravity `agy` (Phase 5) |
|---|---|---|---|---|
| **1. Launch argv** | `--kind claude -- --model <m> --permission-mode bypassPermissions --settings <board>/kit/permissions/<role>.json` (`cli/squad-up.ts:190`) | `--kind codex -- --no-daemon -p <role> -m <m> -a never -s workspace-write` (or `read-only`) + `-c check_for_update_on_startup=false` (report C; `--no-daemon` avoids shared-env `HERDR_PANE_ID` leak) | `--kind opencode -- <cwd> --port <p> --agent <role> -m <provider/model> --auto`; `OPENCODE_CONFIG_DIR` + `OPENCODE_SERVER_PASSWORD` in pane env (report D; v2 flags verified on upgrade) | `--kind agy -- --agent <role> --model <m> --dangerously-skip-permissions` (or `--mode auto`); `AGY_CLI_DISABLE_AUTO_UPDATE=true`, `agy` on PATH (reports B, E) |
| **2. Deliver** | Read `cb-seat-<key>.claude.json`, write `{type:'auth'}` + `{type:'user'}` to Claude socket (`cli/relay.ts:79-89`) | Primary: `herdr agent prompt` (paste boundary + Enter steers busy turn); evaluate `codex queue --thread <uuid>` in Phase 2 live test (report C) | HTTP `POST /api/session/{id}/prompt` (v2; v1 `POST /session/{id}/prompt_async`), queued mid-turn, Basic/pairing auth (report D) | `herdr agent prompt <herdrName> "<text>"` (bracketed paste + Enter; `queuedMessages: "queue"` holds while busy; no external TUI API, report E) |
| **3. Status** | `herdr` `agent_status`; `safeToClose = idle \| done` (`cli/supervise-plan.ts:17`) | `herdr agent_status` (keep default `tui.terminal_title`; OSC 7501 not read by herdr 0.9.5, report C) | Server SSE `/event` + `GET /session/status` + `/permission` + `/question`, backed by herdr v13 plugin (long `retry` ≠ working, report D) | `herdr` scraping + `statusLine` JSON bridge (`agent_state`, `tool_confirmation_pending`, `task_count`); `safeToClose` requires `fullyIdle` / `task_count === 0` (reports A, E) |
| **4. Close** | `herdr agent prompt <name> /exit` (`cli/supervise.ts:176`), wait `absent`, `pane close` | `herdr agent prompt <name> /exit` (live-check in Phase 2; fallback Ctrl+D / `pane close`, reports A, B) | HTTP abort/interrupt + `/exit` or `/tui/execute-command`, wait `absent`, `pane close` (reports B, D) | Confirm `fullyIdle`, send `/exit` (live-check in Phase 5; fallback `pane close`, reports A, E) |
| **5. Quota stop** | Passive matcher in Phase 1 (regex on Claude rate/usage limit lines; consumed in Phase 4) | Match pane tail for `"You've hit your usage limit"` / `"Automatically switched to"` (herdr has no rule, report C) | `session.status` `retry` with `next - now > 10 min`, or `session.error` `APIError`/`FreeUsageLimitError` (report D) | `statusLine` `quota.remaining_fraction === 0` / `"AI: Out of credits"` or pane text `"exhausted your quota"` (report E) |
| **6. Guard** | `~/.claude/settings.json` `PreToolUse` (`Bash\|PowerShell` Win, `Bash` Mac) → `shim-claude.mjs` + `kit/permissions/<role>.json` | `~/.codex/hooks.json` `PreToolUse` (`^Bash$` + `apply_patch` for read-only) → `shim-codex.mjs` + `[features] hooks = true` (report C) | Plugin in `OPENCODE_CONFIG_DIR/plugins/` (`tool.execute.before` throws `Error(reason)`) + v2 `permissions` deny (report D) | `~/.gemini/config/hooks.json` `PreToolUse` (`run_command`, `write_file`, `edit_file`) → `shim-agy.mjs` returning `{"decision":"deny",...}` (report E) |
| **7. Instructions** | Native `CLAUDE.md` + `~/.claude/CLAUDE.md` | `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'`; global `~/.codex/AGENTS.md` (root `AGENTS.md` wins where present, reports B, C) | Config `"instructions": ["CLAUDE.md"]` + squad `AGENTS.md` in `OPENCODE_CONFIG_DIR` (report D) | Reads `AGENTS.md`/`GEMINI.md`/`.agents/rules/*.md`, not `CLAUDE.md`; use repo `AGENTS.md` bootstrap or `always_on` rule (report E) |
| **8. Trust** | `skipDangerousModePermissionPrompt` in user settings; new folders park as `agent_not_ready` (`cli/squad-up.ts:199-205`) | `-c check_for_update_on_startup=false`; pre-seed `[projects.'<path>'] trust_level = "trusted"` in `~/.codex/config.toml`; trust hooks once or managed hooks (report C) | No folder-trust dialog; `autoupdate: false`, `--auto`, `OPENCODE_SERVER_PASSWORD` (report D) | Pre-seed `trustedWorkspaces: [...]` in `~/.gemini/antigravity-cli/settings.json`; `AGY_CLI_DISABLE_AUTO_UPDATE=true` (report E) |
| **9. Disable ask** | `hooks/deny-ask.mjs` on `PreToolUse` `AskUserQuestion` (`hooks/deny-ask.mjs:18-20`; `CB_ALLOW_ASK=1` override) | `PreToolUse` matcher `request_user_input` → `permissionDecision: "deny"` (live-verify matcher in Phase 2, reports B, C) | Deny `question` / `form.*` tool in config + plugin fallback (report D) | `PreToolUse` matcher `ask_question` → `{"decision":"deny","reason":"..."}` (report E) |

### 3. Squad file and schema (`db/schema.sql`)

Follows `CLAUDE.md:25-29` and `db/schema.sql:209,3482-3493`: additive columns, `drop function if exists ... cascade`, `language sql` dependencies ordered top-down (verified by `test/schema-fresh.test.ts`).

**Table changes:**
- Near `db/schema.sql:209` (before `cb.iam` and `cb.inbox`):
  ```sql
  alter table cb.sessions add column if not exists agent text not null default 'claude';
  alter table cb.sessions drop constraint if exists sessions_agent_check;
  alter table cb.sessions add constraint sessions_agent_check check (agent in ('claude','codex','opencode','agy'));
  ```
- Also ensure `alter table cb.projects add column if not exists squad jsonb;` runs next to `pipeline` (`db/schema.sql:3472`, idempotently kept at `:4467`) so helpers above `cb.digest` can read `cb.projects.squad` cleanly on a fresh DB.
- Update `sessions_bind_changed` trigger (`db/schema.sql:650-652`) to also fire on `old.agent is distinct from new.agent`.

**Function changes:**
- `cb.iam(machine, pane, actor, project default null, role default null, area default null, model default null, repo default null, agent text default null)` (`db/schema.sql:1490-1524`): validates `agent` ∈ `('claude','codex','opencode','agy')`; preserves existing `agent` when the same actor rebinds with `agent => null`, else defaults to `'claude'`. **Rollback-safe CLI rule:** `cli/cb.ts:579-580` adds `--agent` (`OPTIONS.agent`) falling back to `process.env.CB_AGENT`, and **omits** `agent` from `callFn('iam', ...)` unless non-empty and `!== 'claude'` (same conditional spread as `cli/cb.ts:593-594`) so a rolled-back 8-arg `cb.iam` (`server/rpc.ts:24,38`) never breaks Claude `cb iam`.
- `cb.inbox` (`db/schema.sql:1541-1543`), `cb.sessions_overview` (`:1688-1692`), `cb.supervise_state` (`:5062-5065`) and `cb.resume` (`:4403`) include `'agent', s.agent`.
- **New helper** `cb._check_model(agent text, model text, label text) returns void` (before `cb.squad_set`):
  - `claude`: exact enum `('opus','sonnet','haiku','fable')` (keeps `test/squad-kit.test.ts:125` error `% model must be opus, sonnet, haiku or fable`).
  - `codex`: `^[a-z0-9][a-z0-9._-]{0,63}$` and **not** in `('opus','sonnet','haiku','fable')` (catches copy-paste error when changing `agent` without updating `model`; phase 0 report C, card #4002).
  - `opencode`: `^[a-z0-9][a-z0-9._-]{0,31}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$` (requires `provider/model`, phase 0 report D, card #4002).
  - `agy`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and not in `('opus','sonnet','haiku','fable')` (phase 0 report E, card #4002).
- `cb._role_model(role text, agent text default 'claude')` (`db/schema.sql:4110-4112`): returns `'sonnet'`/`'opus'` for `claude`; returns `null` for other agents.
- **New helper** `cb._expected_model(project text, actor text, role text, area text, repo text, agent text) returns text` (`language plpgsql stable`, placed right after `cb._role_model`), replacing `cb._role_model(s.role)` in **`cb.digest` group 10** (`db/schema.sql:4197-4204`, `select 10, ...`; skips check when result is `null`):
  - Derives `seat_key` mirroring `wantList` (`cli/squad-up.ts:67-84`, pinned by a parity test): `'1'` for `lead`; `area` for `owner`; for numbered roles extracts `(regexp_match(actor, '[ABRQI]([0-9]+)@'))[1]`, prefixed with `coalesce(nullif(repo, ''), home_repo) || ':'` when `squad->'repos'` is non-null and `role in ('builder','reviewer')` (reading `home_repo` directly from `squad->'repos'` to avoid forward-reference dependencies).
  - Returns `squad->'roles'->role->'seats'->seat_key->>'model'`, else `squad->'roles'->role->>'model'`, else `cb._role_model(role, agent)`. Eliminates false `"restart it with --model sonnet"` digest spam (phase 0 report A, card #4002) while keeping `test/squad-timers.test.ts:172` green.
- `cb.squad_set` (`db/schema.sql:4636-4680`) role keys expand from `('count','model','machine')` to `('count','model','machine','agent','fallback','seats')`:
  - **Decision (primary-agent gate in Phase 1):** `cb.squad_set` accepts `'claude'` (default) for primary role and seat `agent` and **refuses** `codex`/`opencode`/`agy` as primary agents in Phase 1 (`agent "<k>" cannot be assigned as a primary seat yet (phase 1 supports claude only; non-Claude agents are allowed in fallback)`), while `fallback` entries accept and validate all four agents via `cb._check_model`. Why: (a) rolling back CLI (`cli/squad-up.ts:8,190`) can never silently launch Claude for a saved non-Claude primary seat (preserving the anti-goal in every rollback state), and (b) `cb supervise` never enters a 10-minute retry storm (`cli/supervise-plan.ts:18`) spamming `failed` events and digest group 12 (`db/schema.sql:4241-4243`). **If wrong:** Phase 2 unlocks `codex` as primary with a 1-line allow-list edit in `cb.squad_set`; if Ahmed wants primary non-Claude seats saveable in Phase 1, flip that check and add a supervisor skip for unimplemented agents.
  - **Decision (omit default `'claude'`):** omit `'agent'` in stored role/seat JSON when `'claude'` (matching `repos`/`protected`, `db/schema.sql:4722-4724`) and treat absent `agent` as `'claude'` in every reader because live squads (`ihop`, `qhs`) and snapshot tests (`test/squad-kit.test.ts:112`, `test/repos-squad.test.ts:64`) stay untouched without a backfill; **if wrong:** storing `'agent': 'claude'` explicitly later is a 1-line edit in `cb.squad_set`.
  - `fallback`: optional array, length 0–5, items `{"agent", "model"}` (no extra keys), validated with `cb._check_model`, no duplicate `(agent, model)` pairs, none equal to primary `(agent, model)`. Stored when non-empty.
  - `seats`: optional object mapping valid seat key (`"1"`..`"<count>"`, `"<repo>:<1..count[repo]>"`, `"<area>"` for `owner`, `"1"` for `lead`) to non-empty `{"agent"?, "model"?, "fallback"?}`, validated by the same rules.
  - `cb squad show` (`cli/cb.ts:746-750`) prints Claude roles unchanged (`builder  2 × sonnet on macbook`) and adds `(<agent>)`, `fallback`, or per-seat overrides only when present.

### 4. One guard core keyed by role (`kit/guard/`)

**Module layout:**
- `kit/guard/core.mjs` — pure ES module (zero I/O, zero deps). Exports `ROLES`, `READ_ONLY_ROLES` (`['reviewer','qa','investigator']`), `stripMessages`, `check`, `protectedPush`, `checkRole`, `evaluate(req: { tool: 'shell' | 'edit' | 'ask' | 'unknown'; command?: unknown; role?: string | null; protectedBranches?: string[]; allowAsk?: boolean })`.
- `kit/guard/shim-claude.mjs` — thin Claude `PreToolUse` stdin/stdout wrapper. **Zero static local imports:** loads `./core.mjs` via dynamic `await import('./core.mjs')` inside a top-level `try/catch`; if `core.mjs` is missing or throws on load, prints `{"decision":"block","reason":"Blocked: guard failed to load core (...)"}` and exits 0 (never failing open).
- `kit/guard/install.mjs` — atomic installer for PC and Mac (`--target <dir>`, default `~/.claude-board/guard`, `--check` hash drift check).
- `kit/hooks/block-dangerous.mjs` — checkout-only compatibility entrypoint (for `test/dangerous.test.ts:4,378,531`), also loading `../guard/core.mjs` / `../guard/shim-claude.mjs` via top-level dynamic `await import(...)` inside `try/catch` so even if mistakenly copied alone without `../guard/`, CLI execution prints a block JSON (exit 0) instead of failing open. Top comment warns: `DO NOT copy alone; deploy with node kit/guard/install.mjs`.

**Rules in `kit/guard/core.mjs` and `kit/guard/shim-claude.mjs`:**
1. **Fail-closed input contract (`parseClaudeInput` + `evaluate`):**
   - Payload must be valid JSON decoding to a plain object with a plain-object `tool_input`. Empty stdin, invalid JSON, `null`, arrays, missing/non-object `tool_input`, or runtime errors → block (`guard could not read hook input (<detail>)`).
   - **`tool_name` omitted (`undefined`) with `typeof tool_input.command === 'string'` → parsed as `tool: 'shell'`** (preserves today's hook contract in `test/dangerous.test.ts:381,384,389,499-522,527-531` and `docs/ops/maintain.md:85-92`).
   - **`tool_name` present:** `'Bash' | 'PowerShell'` → `'shell'` (requires string `tool_input.command`); `'Edit' | 'Write' | 'NotebookEdit'` → `'edit'`; `'AskUserQuestion'` → `'ask'`; any other value (including `""` or non-string) → fail closed (`unrecognized tool`).
   - **`CB_ROLE` precedence and validation:** the guard trusts `CB_ROLE` from the pane environment (zero DB queries; hooks must finish in <100 ms, same model as `CB_PROTECTED_BRANCHES`, `docs/ops/maintain.md:320-332`). Non-empty `CB_ROLE` not in `ROLES` → fail closed (`unknown CB_ROLE "<val>"`). Unset/empty `CB_ROLE` (hand-started sessions) → base dangerous + PowerShell + `CB_PROTECTED_BRANCHES` rules only.
2. **Dangerous commands + PowerShell coverage (always active, all sessions):**
   - Keeps every existing pattern and `#3809` `killByName` (`kit/hooks/block-dangerous.mjs:39-195`).
   - Adds PowerShell destructive patterns: `Remove-Item`/`ri`/`rd`/`rmdir`/`del`/`erase`/`rm` with `-Recurse`/`-r`/`/s` targeting root, drive root or home (`/`, `/*`, `\`, `\*`, `[A-Za-z]:[/\\]?`, `[A-Za-z]:[/\\]\*`, `~`, `$HOME`, `$env:USERPROFILE` — **not** bare `*`, preserving `rm -rf *` and `Remove-Item -Recurse -Force dist` in build dirs, matching `kit/hooks/block-dangerous.mjs:42`); `Stop-Computer`/`Restart-Computer`; `Format-Volume`/`Clear-Disk`/`Initialize-Disk`/`Remove-Partition`; `iwr`/`irm`/`Invoke-WebRequest`/`Invoke-RestMethod`/`curl`/`wget` piped to `iex`/`Invoke-Expression`; `cmd /c del`/`rd`/`rmdir` with `/s` in any flag order against drive root or `\*`.
   - Fixes real `protectedPush` gaps (`kit/hooks/block-dangerous.mjs:210-211,221,230,244-245`): uses case-insensitive `cmdName(w[i]) === 'git'` (fixing `GIT.EXE` and Windows backslash paths `C:\Program Files\Git\cmd\git.exe`; `& "git"` and backtick refspecs already block today), joins PowerShell `` `\r?\n `` continuations before backtick substitution so multiline pushes get the clear protected-branch reason instead of a misleading `$` message, and scans `{ ... }` PowerShell script blocks.
3. **Role rules (`CB_ROLE` set — enforces shell role rules outside Claude's `kit/permissions/*.json` and provides `edit`/`ask` rules for Phases 2/3/5):**
   - **All 7 roles:** always include `main`/`master` in protected destinations; block force push (`-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `+refspec`), `--mirror`, `--all`, bare `HEAD`/`@` destination (`HEAD:feat/x` allowed), and unnamed-branch pushes (`words.length < 2` after options — replaces 72 fragile glob strings in `kit/permissions/builder.json:5-76`).
   - **All roles except `lead`:** block `gh pr merge` and ADO merge/bypass (`az repos pr update|create` with `completed`/`complete`/`--auto-complete`/`--bypass-policy`, `test/squad-kit-permissions.test.ts:76-103`).
   - **`reviewer`, `qa`, `investigator`:** block `git commit` (with `-C`/`-c` options, sparing `git cat-file commit`), all `git push`, and `tool === 'edit'` (Claude `Edit`/`Write`/`NotebookEdit`, Codex `apply_patch`, OpenCode `edit`, `agy` `write_file`/`edit_file`).
   - **`tool === 'ask'`:** block unless `allowAsk` (`CB_ALLOW_ASK=1`), with the `cb ask` pointer from `hooks/deny-ask.mjs:6-16`.
4. **Phase 1 Claude scope honesty:** Claude's `PreToolUse` matcher stays `Bash|PowerShell` (Win) / `Bash` (Mac) for the guard and `AskUserQuestion` stays on `hooks/deny-ask.mjs`, so Claude's Phase 1 edit-tool deny still comes from `kit/permissions/{reviewer,qa,investigator}.json` (alongside `crossSessionInbound: "accept"` and Claude `PowerShell` tool deny, `test/squad-kit-permissions.test.ts:29-33,152-154`). `tool: 'edit'` and `tool: 'ask'` in `core.mjs` are unit-tested directly in `test/guard.test.ts` and wired to shims in Phases 2/3/5.
5. **Pane env wiring:** `launchFor` (`cli/squad-up.ts:101`) sets `env.CB_ROLE = w.role` and `env.CB_AGENT = agent` (plus `CB_PROTECTED_BRANCHES`) on every pane created by `cb squad up` and `cb supervise`.

**Deployment to PC and Mac:**
- `kit/guard/` ships to PC (`git pull`) and Mac (`tar` already includes `kit`, `docs/ops/maintain.md:52`). Retire the old single-file copy of `kit/hooks/block-dangerous.mjs` in `docs/ops/maintain.md:63-66,79-100`.
- With Ahmed's explicit OK, run `node kit/guard/install.mjs` on PC and Mac. It stages `core.mjs` + `shim-claude.mjs` into `~/.claude-board/guard.new/`, runs 6 live subprocess probes with `CB_ROLE`/`CB_AGENT`/`CB_PROTECTED_BRANCHES`/`CB_ALLOW_ASK` cleared (safe omitted-`tool_name` `ls` → `{}`; `git reset --hard` → block; `Remove-Item -Recurse -Force C:\` → block; `CB_ROLE=builder` + `git push origin main` and `gh pr merge 1` → block; malformed stdin `'not json'` → block), and swaps `guard.new` → `~/.claude-board/guard` only if all 6 pass.
- Point `~/.claude/settings.json` PreToolUse command to `node <abs-home>/.claude-board/guard/shim-claude.mjs` (`Bash|PowerShell` Win, `Bash` Mac; absolute `node` path on Mac per `docs/ops/maintain.md:97`). Leave pre-Phase-1 standalone `~/.claude/hooks/block-dangerous.mjs` untouched as the instant rollback target.

## Staged rollout and rollback

Ship Phase 1 in **three separately releasable, separately reversible stages**; the live board stays up throughout:

### Stage A — Schema + adapter contract + squad/supervisor wiring (no behaviour change for Claude squads; every relay restarts once)
1. **Deploy:** first capture `cb squad up ihop --dry-run`, `cb squad up qhs --dry-run`, `cb digest ihop --all` and `cb digest qhs --all` for the success checks; then merge Stage A to `main` → vps2 `git fetch && git merge --ff-only origin/main && cd deploy && dc up -d --build board` (`docs/ops/maintain.md:32-36`) → PC `git -C F:\Work\claude-board pull --ff-only` → Mac checksum-verified `tar` (`docs/ops/maintain.md:52-55`) → stop `cb supervise`, run `cb supervise --dry-run`, start `cb supervise`. (Phase 1 does not change `cli/recipes.ts` or `runner.json`, so `cb runner` needs no restart; document in `docs/ops/maintain.md` that any future `cli/recipes.ts`/`runner.json` change requires restarting **both** `cb runner` and `cb supervise`, `cli/supervise.ts:10,194`.)
2. **Relay restart:** Stage A restarts every relay once: `seatKey` in `cli/bridge.ts` is part of the relay's code list (`cli/relay.ts:47`) and the watchdog relaunches on a code change. Same on PC `git pull`, on the Mac tar, and again on rollback. A few seconds of task-change notices during the restart are not replayed (as for any relay update).
3. **Success check:** `/healthz` OK; every relay reconnects on the new `cb-relay/<ver>` (`select application_name, count(*) from pg_stat_activity where application_name like 'cb-relay%' group by 1`); `cb supervise --dry-run` shows zero surprise actions on `ihop`/`qhs`; `cb squad up --dry-run` lines for `ihop` and `qhs` are identical to a capture taken before the deploy, and the argv pin test ("startOne: a Claude seat starts with exactly today's herdr argv") is green in the gate's full suite; `cb iam` runs cleanly.
   - Digest group 10 changes on deploy by design: compare the model lines (`<actor> is a <role> on <model>; the role runs ...`) in `cb digest ihop --all` and `cb digest qhs --all` before and after (the capped digest can drop them); every difference must be explained by that squad's role models (the old check compared against fixed defaults, the new one against the squad's own models).
   - `--env CB_ROLE/CB_AGENT` is now on every pane-making herdr call (herdr 0.9.5 lists `--env` for `pane split`, `tab create` and `workspace create` on PC and Mac, checked 2026-11-26 from `--help`): watch the first real seat start or restore on the PC and on the Mac succeed after deploy; if herdr refuses, roll back the PC/Mac code.
4. **Rollback (strict order: PC/Mac FIRST, vps2 LAST):** columns stay forward-only, **functions revert** when vps2 re-runs `db/schema.sql` (`db/setup.ts:25`, `db/schema.sql:258`). Roll back PC (`git checkout <prev-sha>`) + Mac (`tar`) + restart `cb supervise` **first**, then vps2 (`git checkout <prev-sha> && cd deploy && dc up -d --build board`, remembering `git checkout vps` before next deploy, `docs/ops/maintain.md:71-73`). Before vps2: find squads saved with the new keys, `select slug from cb.projects where squad::text ~ '"(seats|fallback)"'`; strip those keys and re-save them (or accept that the old board refuses to re-save them and the old launcher ignores seat models). `cb iam` omits `agent` for Claude and `cb.squad_set` rejects non-Claude primary seats in Phase 1, so `cb iam` does not break during or after rollback.

### Stage B — Seat relay outside the CLI (`seatKey` + endpoint file + bridge fallback)
1. **Deploy:** merge Stage B → PC `git pull --ff-only` + Mac verified `tar` (zero VPS/schema change, zero supervisor restart). Relays auto-restart in ~5 s (`cli/relay.ts:267-271`), seeding `cb-seat-<seatKey>.claude.json` from inherited env; `cb.ts` falls back to legacy `sha1(SOCKET)` during handover.
2. **Success check:** `select application_name, count(*) from pg_stat_activity where application_name like 'cb-relay%' group by 1` (`docs/ops/maintain.md:61`) shows all relays on the new version; `cb` calls ride the bridge (no direct `cb` connections); tell/answer/type_to deliver; exiting a test Claude session stops its relay and removes its endpoint file.
3. **Rollback (< 2 min, PC/Mac only):** `git checkout <stage-A-sha>` on PC + `tar` to Mac; relays auto-restart back to Stage A within ~5 s (zero VPS change).

### Stage C — Unified guard core + `~/.claude/settings.json` switch + ops docs
1. **Deploy (requires Ahmed's explicit OK for `~/.claude`):** merge Stage C → PC `git pull --ff-only` + Mac verified `tar` → run `node kit/guard/install.mjs` on PC and Mac → switch `~/.claude/settings.json` PreToolUse command to `shim-claude.mjs` (leaving pre-Phase-1 standalone `~/.claude/hooks/block-dangerous.mjs` untouched). Note: already-running sessions may keep their session-start hook snapshot until restarted; new/restarted sessions get both the new guard shim and `CB_ROLE`/`CB_AGENT`.
2. **Success check:** `node kit/guard/install.mjs --check` exits 0 on PC and Mac; fresh Claude session + throwaway `CB_ROLE=builder`/`reviewer` check proves dangerous, PowerShell, role, and malformed-stdin blocks while feature push and `cb` pass.
3. **Rollback (< 1 min):** revert one line in `~/.claude/settings.json` back to `node ~/.claude/hooks/block-dangerous.mjs` (zero VPS/relay impact).

## Report vs code notes (verified in this worktree)

- Phase 0 report A (card #4002) omitted `test/github.test.ts:670` and `test/sendback.test.ts:352` from tests spawning `cli/relay.ts` with `CLAUDE_CODE_MESSAGING_SOCKET`; all 7 relay/bridge/help test files are updated for `seatKey` isolation in Stage B.
- Phase 0 report B (card #4002) listed 4 live PC risks; phase 0 summary (card #4002) confirms all 4 were fixed on 2026-11-26 (only the plaintext GitHub token in `~/.claude/settings.json` remains open).
- `kit/hooks/block-dangerous.mjs:210-211,221,230,244-245` (found in code): `protectedPush` already blocks `& "git"` and backtick-obfuscated refspecs (turning `` ` `` into `$`, giving a misleading reason on PowerShell `` `\r?\n `` continuations); the real unblocked gaps are case-sensitive `GIT.EXE` and Windows backslash paths (`C:\...\git.exe`), whereas `killByName` (`:76,116`) already handles both. Phase 1 fixes both plus clean multiline reasons.
- `test/dangerous.test.ts:385-387,523` (exact 4 assertions) pin today's fail-open behavior on `{tool_input:{}}`, `'not json'` and `''`; Phase 1 flips those 4 to fail-closed while keeping `:381,384,389,499-522,527-531` (omitted `tool_name` + string `command`) unchanged.

## Risks

- **Claude messaging token on disk (`cb-seat-<key>.claude.json`):** the endpoint file holds `CLAUDE_CODE_MESSAGING_TOKEN`, which can inject prompts into a `bypassPermissions` session. Honest threat model: on Windows Node ignores `mode: 0o600`, so the per-user `%TEMP%` ACL is the real boundary (same as `cli/bridge.ts:91`). Any process running as the same OS user can already read the Claude process environment, so the file does not widen same-user privilege, though it puts the token on disk until cleaned up. Mitigations: `clearClaudeEndpoint` removes the file when the relay exits, the token is never logged or printed, and POSIX (Mac) sets `0o600`.
- **Pane reuse or nested `claude` in one pane:** a second `claude` started inside an existing seat pane (or a new session after a crash) shares `(machine, pane)` and overwrites `cb-seat-<key>.claude.json`; the seat's single relay follows the newer file and exits when that socket disappears. Mitigation: atomic write + mtime reload + `expectedSocket`-checked cleanup; avoid nested `claude` inside managed squad panes.
- **Fail-closed guard breaking a benign Claude tool shape:** if a future Claude update changes `PreToolUse` payload fields, `shim-claude.mjs` blocks instead of allowing. Mitigation: error prints the exact missing key/type, and rollback to `~/.claude/hooks/block-dangerous.mjs` is one line.
- **False-positive PowerShell blocks in Ahmed's ad-hoc sessions:** `Remove-Item -Recurse -Force dist` and `rm -rf *` must pass while root/drive/home targets block. Mitigation: target-anchored patterns excluding bare `*` (mirroring `kit/hooks/block-dangerous.mjs:42`) plus explicit allow tests in `test/guard.test.ts`.
- **Two-machine drift on Mac tar deploy:** updating `kit/guard/` without running `install.mjs` leaves `~/.claude-board/guard/` behind. Mitigation: `install.mjs --check` verifies SHA-256 hashes and `docs/ops/maintain.md` lists it in Upgrade.

## Questions for Ahmed

1. Should `architect` and `owner` stay allowed to use `Edit`/`Write` (matching today's `kit/permissions/{architect,owner}.json`, so they can write draft design files before `cb page set -f`), or move into `READ_ONLY_ROLES` alongside `reviewer`, `qa` and `investigator`? **Recommended:** keep them allowed in Phase 1; effect: zero surprise change for architects/owners writing local drafts.
2. Should Phase 1 `cb.squad_set` refuse non-Claude **primary** agents (`codex`/`opencode`/`agy`) while still validating and storing all four in `fallback` (safe against both CLI rollback silently launching Claude and 10-minute supervisor retry/digest spam), or allow saving non-Claude primary seats now with a supervisor-skip rule? **Recommended:** refuse non-Claude primary agents in `cb.squad_set` until Phase 2 while validating all four in `fallback`; effect: anti-goal holds in every rollback state and Phase 2 enables `codex` with a 1-line SQL allow-list flip.
3. May Stage C update `~/.claude/settings.json` on PC and Mac to invoke `node <abs-home>/.claude-board/guard/shim-claude.mjs` (retiring the single-file copy of `kit/hooks/block-dangerous.mjs` and keeping the untouched pre-Phase-1 `~/.claude/hooks/block-dangerous.mjs` as the 1-line rollback)? **Recommended:** yes, after the 6-probe self-check on both machines; effect: all future CLI shims share one installed guard folder and rollback stays one line.
4. For Phase 1, should `cb.sessions.agent` also appear as a badge on the web Sessions page (`web/src/views/Sessions.tsx`) now, or wait until Phase 2 when a second agent actually runs? **Recommended:** wait until Phase 2 (no Vite rebuild on PC); effect: smaller Phase 1 release with zero UI churn while every seat is still Claude.
