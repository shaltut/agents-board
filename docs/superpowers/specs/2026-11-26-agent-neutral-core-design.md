# Agent-Neutral Core (Phase 1) Design

Card #4002 · 2026-11-26 · Phase 1 of 5 · Status: proposed (awaiting Ahmed's approval before build).

Builds on `2026-11-22-squad-design.md`, `2026-11-23-squad-kit-design.md`, `2026-11-23-supervisor-design.md`, `2026-11-23-repos-in-project-design.md` and `2026-11-24-lead-by-role-and-ado-prs-design.md`. Code verified at `46de6b7`.

## Why

Every squad seat today is hard-wired to Claude Code in four places:
1. **Launch:** `cli/squad-up.ts:190` hard-codes `--kind claude` and Claude-only flags (`--permission-mode bypassPermissions --settings kit/permissions/<role>.json`); `cb.squad_set` (`db/schema.sql:4636-4640`) accepts only `count`/`model`/`machine` and Claude model aliases (`opus|sonnet|haiku|fable`).
2. **Delivery and liveness:** `cli/relay.ts:16-19` exits unless `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` exist, is started only by Claude's `SessionStart` hook, and is the only writer of `cb.sessions.last_seen` (`db/schema.sql:1513,1537`). A non-Claude seat gets no board pushes and reads "down" after 90 s (`db/schema.sql:1690,5064`).
3. **Close and status:** `cli/supervise.ts:176` closes seats by prompting `/exit`, and `cli/supervise-plan.ts:17,83` treats herdr's `idle`/`done` as universally safe to close.
4. **Safety fences:** the role deny lists live in Claude settings JSON (`kit/permissions/<role>.json`, 73–84 rules), `kit/hooks/block-dangerous.mjs` is wired only in `~/.claude/settings.json` and fails open on unreadable input (`kit/hooks/block-dangerous.mjs:264,274`), and `hooks/deny-ask.mjs` matches only `AskUserQuestion`.

Phase 1 splits the board core from Claude Code so Codex (Phase 2), OpenCode v2 (Phase 3), routing/failover policy (Phase 4) and an Antigravity trial (Phase 5) plug in without another core rewrite.

## Owner decisions already made

- Every project may use every agent Ahmed assigns. The squad file is the policy; the board keeps no separate per-project agent or provider allow list.
- Build phases: **1** agent-neutral core with Claude only (this spec); **2** Codex; **3** OpenCode v2; **4** policy (quota failover, cross-agent review, cost tiers, best agent per task); **5** Antigravity (`agy`) trial.
- Design before build: nothing gets coded until Ahmed approves this design.

## Goals, non-goals, anti-goals, constraints

- **Success test:** today's Claude squads on the PC (`shaltoot`) and Mac (`macbook`) run unchanged on the new core — same herdr launch flags, same messaging-socket delivery, same `cb` bridge speed, same safety fences, same supervisor close/restore timing.
- **Goals:** per-seat relay outside the CLI with liveness tied to the seat; one `AgentAdapter` contract covering all nine lifecycle needs with `claude` as Phase 1's only adapter; `agent`, per-agent model validation, per-seat overrides and ranked `fallback` in `cb.squad_set`; one role-aware, PowerShell-safe, fail-closed guard core with a Claude shim; zero-downtime rollout.
- **Non-goals:** Codex, OpenCode or `agy` adapter code; Phase 4 failover/routing policy; edits to any client repo (`iHop`, `QHS`, etc.); changing `cli/recipes.ts` or `runner.json`.
- **Anti-goals:** an agent clearing another agent's startup dialog or safety stop; a seat reporting `live = true` after its agent died; silent allow when a guard hook cannot parse input or receives an unknown `CB_ROLE`; silently launching Claude when a squad asks for an unimplemented agent.
- **Constraints:** board rules live in idempotent `db/schema.sql` (`add column if not exists`, `drop function if exists ... cascade`, must pass `test/schema-fresh.test.ts` on an empty DB); Node 24 runs `.ts`/`.mjs` directly with zero new npm dependencies (`package.json:6-21`); `CLAUDE.md` test/release rules apply; every `case` in `cli/cb.ts` has a `cli/help.ts` entry (`test/help.test.ts:24-32`).

## Approaches

### 1. Seat relay outside the CLI and delivering to Claude

**Hard question from code:** Claude's inbox socket and bearer token (`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`) exist only in Claude's child process environment (`cli/relay.ts:16-19`). An outside process cannot discover them unless Claude exports them, and the relay must run on the **seat's own machine** (PC or Mac) because Claude's socket, the fast `cb` bridge (`cli/bridge.ts:20-25`, saving ~650 ms per call), OpenCode's loopback HTTP port (`D-opencode.md §2.2`), and Codex's local queue SQLite (`C-codex.md §2`) are all machine-local.

| Option | How it works | Trade-off |
|---|---|---|
| **A. External per-seat relay keyed on `(machine, pane)` + `0600` Claude endpoint file (picked)** | One `cli/relay.ts` per seat, keyed on `sha1(machine:pane)` instead of `sha1(SOCKET)` (`cli/relay.ts:21`, `cli/cb.ts:67-68`). Owns Postgres `LISTEN`, heartbeat (`cb.inbox`), `cb` bridge, and calls `adapter.deliver()` / `adapter.isAlive()`. Claude's `SessionStart` hook writes a `0600` temp file `cb-seat-<key>.claude.json` (`{socket, token, pid}`) and ensures the relay is up. | Same 2 Postgres connections/seat as today. Works unchanged with existing `~/.claude/settings.json` hook. Same local-user `0600` temp-file boundary as `cli/bridge.ts:91`. One relay engine for all 4 CLIs. |
| **B. Keep in-session Claude relay for delivery; move only heartbeat outside** | Existing `cli/relay.ts` stays Claude-only; supervisor or a separate daemon writes `last_seen` for every seat. | Splits liveness from reachability: a dead Claude relay still reads `live = true`, so `cb tell` (`cli/cb.ts:539`) claims instant delivery and `cb.digest` (`db/schema.sql:4162`) hides uncollected answers. Supervisor's 60 s tick (`cli/supervise.ts:287`) races the 90 s liveness window (`db/schema.sql:1690`). Still requires building a second delivery relay in Phase 2. |
| **C. Drop Claude's socket; type into every pane via `herdr agent prompt` from one daemon** | One per-machine daemon reads `cb.inbox` for all seats and types via `herdr agent prompt`. | Fails the Phase 1 success test: loses Claude's silent out-of-band mid-turn delivery (`cli/relay.ts:4`), prints raw `[Claude Board]` blocks into Ahmed's panes, fails while dialogs are open (`agent_blocked`), and turns one crash or serial `sql` pool into a machine-wide outage. |

**Decision:** Pick **Option A** because it keeps Claude's exact socket delivery, connection budget, and `cb` bridge latency while making relay identity, heartbeat, bridge and delivery agent-neutral; **if wrong:** if Claude ever rotates its socket without firing `SessionStart`, delivery stalls safely (marks stay uncommitted, `cli/relay.ts:216-225`) until the next `SessionStart` or relay exit; fallback to `herdr agent prompt` is a half-day change inside `cli/agents/claude.ts`.

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
| **A. `kit/guard/` in repo, deployed atomically to `~/.claude-board/guard/` (picked)** | Pure `kit/guard/core.mjs` + thin per-CLI shims (`shim-claude.mjs` in Phase 1). `kit/guard/install.mjs` copies to `~/.claude-board/guard.new/`, runs 6 self-checks, swaps into `~/.claude-board/guard/` on PC and Mac (with Ahmed's OK). `kit/hooks/block-dangerous.mjs` stays as a compatibility wrapper. | Matches `~/.claude-board/runner/` and `supervisor/` (`docs/ops/maintain.md:206,264`). `git pull`/`tar` never mutates Ahmed's live hooks silently; self-check prevents broken imports failing open (`docs/ops/maintain.md:96-97`); Codex's `hooks.json` command path stays stable across `core.mjs` updates (`C-codex.md §3`). |
| **B. Point every CLI straight at `<board>/kit/guard/shim-*.mjs`** | No copy step; same as `hooks/deny-ask.mjs`. | Violates Ahmed's explicit-yes gate (`docs/ops/maintain.md:64,77`); a partial Mac tar extract or bad checkout commit breaks live guards across all sessions. |
| **C. Bundle one standalone file per CLI** | Build step emits single-file scripts into `~/.claude/hooks/`, `~/.codex/hooks/`, etc. | Adds a bundler/build step this repo deliberately avoids (`package.json:9-16`) or duplicates core logic across files. |

**Decision:** Pick **Option A** because atomic copy + self-test removes the multi-file import footgun while preserving Ahmed's approval gate; **if wrong:** pointing `~/.claude/settings.json` back at `~/.claude/hooks/block-dangerous.mjs` rolls back in one edit.

## Design

### 1. Seat relay outside the CLI, with its own heartbeat

**Keying and bridge (`cli/relay.ts`, `cli/bridge.ts`, `cli/cb.ts`):**
- Add `seatKey(machine: string, pane: string): string` = `sha1(\`${machine.trim().toLowerCase()}:${pane.trim()}\`).slice(0, 12)` in `cli/bridge.ts`.
- Relay files in `tmpdir()` become `cb-relay-<seatKey>.pid`, `cb-relay-<seatKey>.log`, `cb-relay-<seatKey>.bridge` (and `.bridge.sock` / `\\.\pipe\cb-relay-bridge-<seatKey>`).
- `cli/cb.ts:67-70` computes `seatKey(machine(), pane)` whenever `HERDR_PANE_ID` is set (and `!process.env.PGAPPNAME`), independent of `CLAUDE_CODE_MESSAGING_SOCKET`. For zero-downtime rollout while old relays finish restarting, `openBridge` and `relayOn()` (`cli/cb.ts:224-232`) check `seatKey(machine(), pane)` first and fall back once to legacy `sha1(CLAUDE_CODE_MESSAGING_SOCKET).slice(0, 12)`.
- `cb relay [--agent <kind>] [--restart]` (`cli/cb.ts:570-575`) requires only `HERDR_PANE_ID`. It resolves agent from `--agent`, `$CB_AGENT`, `cb.sessions.agent` (if bound), else `'claude'`. For `claude`, it still requires either `CLAUDE_CODE_MESSAGING_SOCKET` in env or a live endpoint file (otherwise errors clearly). `cb start` (`cli/cb.ts:246`) preserves `Relay unavailable` when a `claude` pane has neither a live relay nor a Claude socket/endpoint (`test/help.test.ts:129-130`).

**Claude socket hand-off (`hooks/claude-endpoint.mjs` + `cli/relay.ts`):**
- Endpoint file: `join(tmpdir(), \`cb-seat-${key}.claude.json\`)`, written atomically (`.tmp.<pid>` + `renameSync`, mode `0o600`): `{ socket, token, pid, updatedAt }`.
- `cli/relay.ts` launcher (without `--child`): if `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` are in env, writes the endpoint file before spawning `--child --pane <pane> --agent <agent>` detached (without passing socket/token env requirements into the generic loop). Existing `~/.claude/settings.json` `SessionStart` (`node .../cli/relay.ts`, `B-prompts-kit-config-lockin.md §7`) works on PC and Mac with **zero config edit**. `hooks/claude-endpoint.mjs` is also shipped as the explicit lightweight hook entrypoint for future installs.
- Backward compatibility for existing tests (`test/relay.test.ts:72`, `test/bridge.test.ts:65`, `test/asks.test.ts:263`, `test/followup.test.ts:318`, `test/github.test.ts:670`, `test/sendback.test.ts:352`): when `--child` is spawned directly with `CLAUDE_CODE_MESSAGING_SOCKET` + `_TOKEN` in env and no newer endpoint file exists, it seeds the endpoint file at startup.

**Liveness-gated heartbeat and exit:**
- `cli/relay.ts` calls `adapter.isAlive(seat)` **before** calling `cb.inbox(M, PANE, after)` (`cli/relay.ts:204`) and in its 2 s watchdog (`cli/relay.ts:257-273`).
  - For `claude`: `isAlive` reads the endpoint file and checks `existsSync(ep.socket)` (re-reading if mtime changed so `/clear` or compaction refreshes cleanly). When `existsSync(ep.socket)` turns false after having been seen, the relay stops calling `cb.inbox`, removes its own endpoint file (only if `socket` matches), releases lock + bridge, and exits — `last_seen` stops updating and ages out in 90 s.
  - For future non-Claude seats: `isAlive` checks the agent's local signal (OpenCode `/global/health`, Codex/agy pane agent check on a 30 s cadence) so a dead agent never stays green on the board.
- `deliver()` has a hard timeout (5 s for Claude socket, matching `cli/relay.ts:85`; 15 s max for other adapters) so a slow delivery never blocks the 30 s `cb.inbox` heartbeat past the 90 s liveness window (`db/schema.sql:1690,5064`). If `deliver()` throws, `ask_delivered`, `broadcast_seen`, `answer_delivered` and `after` do **not** advance (`cli/relay.ts:216-228`), so messages retry on the next trigger without loss.
- `CODE` in `cli/relay.ts:47` adds `agents/index.ts` and `agents/claude.ts` so adapter changes trigger clean relay auto-restart (`cli/relay.ts:267-271`) and bump `cb-relay/<ver>`.

### 2. Agent adapter interface (`cli/agents/`)

Files: `cli/agents/types.ts` (interface + shared types), `cli/agents/claude.ts` (Phase 1 implementation), `cli/agents/index.ts` (registry: `getAdapter(kind)`, `AGENT_KINDS`, `defaultModelFor(agent, role)`). Unregistered kinds (`codex`, `opencode`, `agy` in Phase 1) throw `agent "<kind>" is not installed yet (phase 1 supports claude only)` at launch/relay time — never falling back to Claude.

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
- `cli/squad-up.ts:100-104,190,205`: `launchFor` carries `agent`, `board`, and sets `env.CB_ROLE = w.role` and `env.CB_AGENT = agent` (alongside `CB_PROTECTED_BRANCHES`); `startOne` uses `adapter.buildLaunch(l)` for `herdr agent start` (producing byte-identical `--kind claude -- --model <m> --permission-mode bypassPermissions --settings <board>/kit/permissions/<role>.json` for Claude) and `adapter.trustSpec(...).dialogHint` for the `agent_not_ready` message (`cli/squad-up.ts:205`).
- `cli/supervise.ts:87,171,176,255`: `tick()` precomputes `safeToClose` per squad session via `await adapter.readStatus(...)` and passes it into pure `planTick` (`cli/supervise-plan.ts:83`, which falls back to `READY.has(status)` when omitted); `closeOne` re-checks `adapter.readStatus(...).safeToClose` and calls `await adapter.close(seat, run)` (sending `/exit` for Claude); supervisor version hash includes `agents/index.ts` and `agents/claude.ts`.
- `cli/relay.ts`: calls `adapter.isAlive` and `adapter.deliver`.

**How every CLI maps to the 9 adapter operations:**

| Operation | Claude (Phase 1) | Codex (Phase 2) | OpenCode v2 (Phase 3) | Antigravity `agy` (Phase 5) |
|---|---|---|---|---|
| **1. Launch argv** | `--kind claude -- --model <m> --permission-mode bypassPermissions --settings <board>/kit/permissions/<role>.json` (`cli/squad-up.ts:190`) | `--kind codex -- --no-daemon -p <role> -m <m> -a never -s workspace-write` (or `read-only` for read-only roles) + `-c check_for_update_on_startup=false` (`C-codex.md §0,§1,§5`; `--no-daemon` avoids shared-env `HERDR_PANE_ID` leak) | `--kind opencode -- <cwd> --port <p> --agent <role> -m <provider/model> --auto`; `OPENCODE_CONFIG_DIR` + `OPENCODE_SERVER_PASSWORD` in pane env (`D-opencode.md §1.1,§1.6-1.7,§2.2`; v2 pairing/service flags verified on upgrade, `§13`) | `--kind agy -- --agent <role> --model <m> --dangerously-skip-permissions` (or `--mode auto`); `AGY_CLI_DISABLE_AUTO_UPDATE=true`, `agy` on PATH (`E-antigravity.md §2,§4.1,§4.5`, `B §0`) |
| **2. Deliver message** | Read `cb-seat-<key>.claude.json`, write `{type:'auth'}` + `{type:'user'}` to Claude socket (`cli/relay.ts:79-89`) | Primary: `herdr agent prompt` (paste boundary + Enter steers busy turn, `C-codex.md §2`). Evaluate `codex queue --thread <uuid>` in Phase 2 live test 4 (`C-codex.md §2,§12`) | HTTP `POST /api/session/{id}/prompt` (v2, `D-opencode.md §13`; v1 `POST /session/{id}/prompt_async`, `§2.2`), queued mid-turn, Basic/pairing auth | `herdr agent prompt <herdrName> "<text>"` (bracketed paste + Enter; `queuedMessages: "queue"` holds while busy, `E-antigravity.md §4.2`; no external TUI API) |
| **3. Read status** | `herdr agent list/get` `agent_status`; `safeToClose = idle \| done` (`cli/supervise-plan.ts:17`) | `herdr agent_status` (screen/title scraping; keep default `tui.terminal_title`, `C-codex.md §10`; OSC 7501 ≥0.163 not read by herdr 0.9.5) | Server SSE `/event` + `GET /session/status` + `/permission` + `/question`, backed by herdr v13 plugin (`D-opencode.md §10.1-10.2,§13`; long `retry` ≠ working) | `herdr` scraping (tuned to v1.2, `E-antigravity.md §4.10`) + `statusLine` JSON bridge (`agent_state`, `tool_confirmation_pending`, `task_count`); `safeToClose` requires `fullyIdle` / `task_count === 0` (`A §4a`, `E §4.10`) |
| **4. Close session** | `herdr agent prompt <name> /exit` (`cli/supervise.ts:176`), wait `absent`, `pane close` | `herdr agent prompt <name> /exit` (string verified `B §3`; live-check in Phase 2; fallback `herdr agent send-keys` Ctrl+D / `pane close`, `A §6`) | HTTP abort/interrupt (`D-opencode.md §2.2,§13`) + `/exit` (string verified `B §3`) or `/tui/execute-command`, wait `absent`, `pane close` | Confirm `fullyIdle` (`E §4.10`), send `/exit` (live-check in Phase 5; `A §6`), fallback `pane close` |
| **5. Detect quota stop** | Passive matcher in Phase 1 (regex on Claude rate/usage limit lines; consumed in Phase 4) | Match pane tail for `"You've hit your usage limit"` / `"Automatically switched to"` (`C-codex.md §9`; herdr has no rule, pane reads idle) | `session.status` `retry` with `next - now > 10 min`, or `session.error` `APIError`/`FreeUsageLimitError` (`D-opencode.md §9.3,§10.2`) | `statusLine` `quota.remaining_fraction === 0` / `"AI: Out of credits"` or pane text `"exhausted your quota"` / `"prepaid balance is insufficient"` (`E-antigravity.md §4.9-4.10`) |
| **6. Install guard** | `~/.claude/settings.json` `PreToolUse` (`Bash\|PowerShell` Win, `Bash` Mac) → `node ~/.claude-board/guard/shim-claude.mjs` + `kit/permissions/<role>.json` | `~/.codex/hooks.json` `PreToolUse` (`^Bash$` + `apply_patch` for read-only) → `command`/`commandWindows` running `shim-codex.mjs` (exit 2 + stderr or `permissionDecision:"deny"`, `C-codex.md §3,§11`) + `[features] hooks = true` | Plugin in `OPENCODE_CONFIG_DIR/plugins/` (`tool.execute.before` throws `Error(reason)`, `D-opencode.md §3.2`) + v2 `permissions` array `{action:"shell", effect:"deny"}` (`§13`) | `~/.gemini/config/hooks.json` `PreToolUse` (`run_command`, `write_file`, `edit_file`) → `shim-agy.mjs` returning `{"decision":"deny","reason":"..."}` (`E-antigravity.md §4.3`; re-test every version bump) |
| **7. Map instructions** | Native `CLAUDE.md` + `~/.claude/CLAUDE.md` | `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'` (`C-codex.md §4`); global `~/.codex/AGENTS.md`; note root `AGENTS.md` wins where present (`B §6`) | Config `"instructions": ["CLAUDE.md"]` so root `AGENTS.md` does not hide `CLAUDE.md` (`D-opencode.md §4.2,§13`); squad `AGENTS.md` in `OPENCODE_CONFIG_DIR` (`§1.7,§4.2`) | Reads `AGENTS.md`/`GEMINI.md`/`.agents/rules/*.md`, not `CLAUDE.md` (`E-antigravity.md §4.4`); use repo `AGENTS.md` bootstrap or `always_on` rule pointer |
| **8. Pre-seed trust dialogs** | `skipDangerousModePermissionPrompt` in user settings; new folders park as `agent_not_ready` (`cli/squad-up.ts:199-205`) | `-c check_for_update_on_startup=false`; pre-seed `[projects.'<path>'] trust_level = "trusted"` in `~/.codex/config.toml`; trust hooks once, use managed hooks, or `--dangerously-bypass-hook-trust` (`C-codex.md §1,§3`) | No folder-trust dialog; set `autoupdate: false`, `--auto`, `OPENCODE_SERVER_PASSWORD` (`D-opencode.md §1.5,§2.2,§9.2`) | Pre-seed `trustedWorkspaces: [...]` in `~/.gemini/antigravity-cli/settings.json`; `AGY_CLI_DISABLE_AUTO_UPDATE=true` (`E-antigravity.md §2,§4.5`) |
| **9. Turn off ask-user tools** | `hooks/deny-ask.mjs` on `PreToolUse` `AskUserQuestion` (`hooks/deny-ask.mjs:18-20`; `CB_ALLOW_ASK=1` override) | `PreToolUse` matcher `request_user_input` → `permissionDecision: "deny"` (`B §2`, `C-codex.md §3`; live-verify matcher name in Phase 2) | Deny `question` tool in config (`D-opencode.md §5` removes from `visibleTools`; v2 `form.*` / `question` deny, `§13`) + plugin fallback | `PreToolUse` matcher `ask_question` → `{"decision":"deny","reason":"..."}` (`E-antigravity.md §4.3`) |

### 3. Squad file and schema (`db/schema.sql`)

Follows `CLAUDE.md:25-29` and `db/schema.sql:209,3482-3493`: additive columns, `drop function if exists ... cascade`, `language sql` dependencies ordered top-down (verified by `test/schema-fresh.test.ts`).

**Table changes:**
- Near `db/schema.sql:209` (before `cb.iam` and `cb.inbox`):
  ```sql
  alter table cb.sessions add column if not exists agent text not null default 'claude';
  alter table cb.sessions drop constraint if exists sessions_agent_check;
  alter table cb.sessions add constraint sessions_agent_check check (agent in ('claude','codex','opencode','agy'));
  ```
- Update `sessions_bind_changed` trigger (`db/schema.sql:650-652`) to also fire on `old.agent is distinct from new.agent`.

**Function changes:**
- `cb.iam(machine, pane, actor, project default null, role default null, area default null, model default null, repo default null, agent text default null)` (`db/schema.sql:1490-1524`): validates `agent` ∈ `('claude','codex','opencode','agy')`; preserves existing `agent` when the same actor rebinds with `agent => null`, else defaults to `'claude'`. `cli/cb.ts:579-580` adds `--agent` (`OPTIONS.agent`) falling back to `process.env.CB_AGENT ?? null`.
- `cb.inbox` (`db/schema.sql:1541-1543`), `cb.sessions_overview` (`:1688-1692`), `cb.supervise_state` (`:5062-5065`) and `cb.resume` (`:4403`) include `'agent', s.agent`.
- New helper `cb._check_model(agent text, model text, label text) returns void` (before `cb.squad_set`):
  - `claude`: exact enum `('opus','sonnet','haiku','fable')` (keeps `test/squad-kit.test.ts:125` error `% model must be opus, sonnet, haiku or fable`).
  - `codex`: `^[a-z0-9][a-z0-9._-]{0,63}$` and **not** in `('opus','sonnet','haiku','fable')` (catches copy-paste error when changing `agent` without updating `model`; `C-codex.md §9`).
  - `opencode`: `^[a-z0-9][a-z0-9._-]{0,31}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$` (requires `provider/model`, `D-opencode.md §1.3`).
  - `agy`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and not in `('opus','sonnet','haiku','fable')` (`E-antigravity.md §4.1`).
- `cb._role_model(role text, agent text default 'claude')` (`db/schema.sql:4110-4112`): returns `'sonnet'`/`'opus'` for `claude`; returns `null` for other agents (so `cb.squad_set` requires an explicit `model` whenever `agent <> 'claude'`).
- `cb._expected_model(project text, actor text, role text, agent text)` used by `cb.digest` line 10 (`db/schema.sql:4197-4204`): reads the project's `squad` file (seat override first, then role model) and falls back to `cb._role_model(role, agent)` only when no squad/role entry exists. Eliminates false `"restart it with --model sonnet"` digest spam (`A-runtime-lockin.md §9`) while keeping `test/squad-timers.test.ts:172` green.
- `cb.squad_set` (`db/schema.sql:4636-4680`) role object keys expand from `('count','model','machine')` to `('count','model','machine','agent','fallback','seats')`:
  - `agent`: optional string, default `'claude'`, ∈ `('claude','codex','opencode','agy')`. **Decision:** omit `'agent'` in stored role JSON when it equals `'claude'` (matching `repos` and `protected`, `db/schema.sql:4722-4724`) and treat absent `agent` as `'claude'` in every reader (`squad-up.ts`, `supervise-plan.ts`, `cb.digest`, `cb squad show`) because live stored squads (`ihop`, `qhs`) and snapshot tests (`test/squad-kit.test.ts:112`, `test/repos-squad.test.ts:64`) stay untouched without a backfill; **if wrong:** storing `'agent': 'claude'` explicitly later is a one-line change in `cb.squad_set`.
  - `fallback`: optional JSON array, length 0–5, each item `{"agent": "<kind>", "model": "<model>"}` (no extra keys), validated with `cb._check_model`, no duplicate `(agent, model)` pairs, none equal to the primary `(agent, model)`. Stored when present and non-empty.
  - `seats`: optional JSON object mapping a seat key to `{"agent"?, "model"?, "fallback"?}` (at least one key). Valid seat keys: `"1"`..`"<count>"` for flat/project-wide roles, `"<repo>:<1..count[repo]>"` for multi-repo `builder`/`reviewer`, `"<area>"` for `owner`, `"1"` for `lead`. Effective `agent` inherits role `agent`; if `agent` changes and `model` is omitted, defaults via `cb._role_model` (required if non-Claude); validated with `cb._check_model`.
  - `cb squad show` (`cli/cb.ts:746-750`) prints Claude roles unchanged (`builder  2 × sonnet on macbook`) and adds `(<agent>)` only for non-Claude roles or per-seat overrides.

### 4. One guard core keyed by role (`kit/guard/`)

**Module layout:**
- `kit/guard/core.mjs` — pure ES module (zero I/O, zero deps). Exports:
  - `ROLES`, `READ_ONLY_ROLES` (`['reviewer','qa','investigator']`), `stripMessages`, `check`, `protectedPush`, `checkRole`, `evaluate`.
  - `evaluate(req: { tool: 'shell' | 'edit' | 'ask' | 'unknown'; command?: unknown; role?: string | null; protectedBranches?: string[]; allowAsk?: boolean }): { allow: true } | { allow: false; code: string; reason: string }`.
- `kit/guard/shim-claude.mjs` — thin (~35 lines) Claude `PreToolUse` stdin/stdout wrapper calling `evaluate()`.
- `kit/guard/install.mjs` — atomic installer for PC and Mac (`--target <dir>`, default `~/.claude-board/guard`).
- `kit/hooks/block-dangerous.mjs` — thin compatibility wrapper re-exporting `stripMessages`, `check`, `protectedPush` from `../guard/core.mjs` and delegating CLI execution to `../guard/shim-claude.mjs`.

**Rules in `kit/guard/core.mjs`:**
1. **Fail closed on unreadable input (`evaluate` + `shim-claude.mjs`):**
   - Empty stdin, invalid JSON, non-object payload, missing `tool_input`, non-string `tool_input.command` on a shell tool (e.g. missing, `null`, number, array), unknown `tool_name`, or unexpected runtime error → `{ allow: false, code: 'unreadable', reason: 'guard could not read hook input (<detail>)' }`.
   - Non-empty `CB_ROLE` not in `ROLES` → `{ allow: false, code: 'unknown_role', reason: 'unknown CB_ROLE "<val>"' }`.
   - Unset or empty `CB_ROLE` → base dangerous-command + kill-by-name + `CB_PROTECTED_BRANCHES` checks only (hand-started sessions keep full git/edit access).
2. **Dangerous commands + PowerShell coverage (always active, all sessions):**
   - Keeps every existing pattern and `#3809` `killByName` (`kit/hooks/block-dangerous.mjs:39-195`).
   - Adds PowerShell destructive patterns: `Remove-Item`/`ri`/`rd`/`rmdir`/`del`/`erase`/`rm` with `-Recurse`/`-r`/`/s` targeting root, drive root, home or `*` (`/`, `/*`, `\`, `C:\`, `C:/`, `~`, `$HOME`, `$env:USERPROFILE`, `*`); `Stop-Computer`/`Restart-Computer`; `Format-Volume`/`Clear-Disk`/`Initialize-Disk`/`Remove-Partition`; `Invoke-WebRequest`/`iwr`/`Invoke-RestMethod`/`irm`/`curl`/`wget` piped to `Invoke-Expression`/`iex`; `cmd /c del`/`rd` in any flag order.
   - Fixes `protectedPush` (`kit/hooks/block-dangerous.mjs:221,230`) for PowerShell/Windows: uses `cmdName(w[i]) === 'git'` (handles `C:\Program Files\Git\cmd\git.exe`, `GIT.EXE`, `!git`, `& "git"`), joins PowerShell backtick continuations `` `\r?\n `` before handling remaining backticks (blocking backtick-obfuscated refspecs), and scans `{ ... }` PowerShell script blocks.
3. **Role rules (active whenever `CB_ROLE` is set — replacing the Claude-only dependency on `kit/permissions/*.json`):**
   - **All 7 roles:** always include `main` and `master` in protected destinations; block any force push (`-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `+refspec`); block `--mirror` and `--all`; block `HEAD` or `@` as bare destination (`HEAD:feat/x` stays allowed); block unnamed-branch pushes (`words.length < 2` after stripping git/push options — replaces 70 fragile glob strings in `kit/permissions/builder.json:5-76`).
   - **All roles except `lead`:** block `gh pr merge` and Azure DevOps merge/bypass (`az repos pr update|create` with `complete`/`--auto-complete`/`--bypass-policy`, matching `test/squad-kit-permissions.test.ts:76-103`).
   - **`reviewer`, `qa`, `investigator`:** block `tool === 'edit'` (Claude `Edit`/`Write`/`NotebookEdit`, Codex `apply_patch`, OpenCode `edit`, `agy` `write_file`/`edit_file`), block `git commit` (with any `-C`/`-c` options before `commit`, sparing `git cat-file commit`), and block all `git push`.
   - **Ask tool (`tool === 'ask'`):** block unless `allowAsk` (`CB_ALLOW_ASK=1`), with the `cb ask` pointer from `hooks/deny-ask.mjs:6-16`.
4. **Claude's `kit/permissions/<role>.json` stays in Phase 1** as a second layer: it still supplies `crossSessionInbound: "accept"` (needed by Claude's inbox, `test/squad-kit-permissions.test.ts:29-33`) and denies Claude's `PowerShell` tool for squad seats (`:152-154`).
5. **Pane env wiring:** `launchFor` (`cli/squad-up.ts:101`) sets `env.CB_ROLE = w.role` and `env.CB_AGENT = agent` (plus `CB_PROTECTED_BRANCHES` when present) on every pane created by `cb squad up` and `cb supervise`.

**Deployment to PC and Mac:**
- `kit/guard/` ships to the PC via `git pull` and to the Mac via the existing `tar` command (`docs/ops/maintain.md:52`, which already includes `kit`).
- With Ahmed's explicit OK, run `node kit/guard/install.mjs` on the PC and on the Mac. It stages `core.mjs` + `shim-claude.mjs` into `~/.claude-board/guard.new/`, runs 6 live subprocess probes against `guard.new/shim-claude.mjs` (safe `ls` → `{}`; `git reset --hard` → block; `Remove-Item -Recurse -Force C:\` → block; `CB_ROLE=builder` + `git push origin main` and `gh pr merge 1` → block; malformed stdin `'not json'` → block), and swaps `guard.new` → `~/.claude-board/guard` only if all 6 pass.
- Point `~/.claude/settings.json` PreToolUse hook command to `node <abs-home>/.claude-board/guard/shim-claude.mjs` (matcher `Bash|PowerShell` on Windows, `Bash` on Mac; absolute `node` path on Mac per `docs/ops/maintain.md:97`). Keep `~/.claude/hooks/block-dangerous.mjs` untouched as rollback.

## Rollout order and rollback

Ship in four steps; the live board stays up throughout:

1. **Schema first (vps2):** merge to `main`, then on vps2 `git fetch && git merge --ff-only origin/main && cd deploy && dc up -d --build board` (`docs/ops/maintain.md:32-36`). Every SQL change is additive (`sessions.agent` defaults `'claude'`, `cb.iam` `agent` defaults `null`, `squad_set` accepts existing squads unchanged), so older PC/Mac CLIs and relays keep running during the window.
2. **Code on PC and Mac (`F:\Work\claude-board` and `~/Work/claude-board`):**
   - PC: `git -C F:\Work\claude-board pull --ff-only`.
   - Mac: checksum-verified `tar` of `bin cli db prompts server hooks kit` (`docs/ops/maintain.md:52-55`).
   - **Relays:** auto-restart within ~5 s (`cli/relay.ts:267-271`), seeding `cb-seat-<seatKey>.claude.json` from inherited env; `cb.ts` falls back to legacy `sha1(SOCKET)` during handover. Verify with `select application_name, count(*) from pg_stat_activity where application_name like 'cb-relay%' group by 1` (`docs/ops/maintain.md:61`).
   - **Supervisor:** stop `cb supervise` in herdr tab `supervisor`, run `cb supervise --dry-run` (must show zero surprise starts/closes on `ihop` and `qhs`), then start `cb supervise`.
   - **PC job runner:** Phase 1 does not change `cli/recipes.ts` or `runner.json`, so `cb runner` needs no restart here. **Standing rule (document in `docs/ops/maintain.md`):** after any change to `cli/recipes.ts` or the `runner.json` shape, restart **both** `cb runner` and `cb supervise` (`cli/supervise.ts:10,194` imports `loadConfig` from `cli/recipes.ts`).
3. **Guard deploy (PC then Mac, with Ahmed's yes):** run `node kit/guard/install.mjs` on each machine, update `~/.claude/settings.json` to `shim-claude.mjs`, and verify in a fresh Claude session + one throwaway `CB_ROLE=builder` / `CB_ROLE=reviewer` check.
4. **Already-running sessions:** stay protected by `--settings kit/permissions/<role>.json` plus the upgraded base/PowerShell/fail-closed guard; they receive `CB_ROLE` and `CB_AGENT` naturally on their next start/restart (hand-started leads on next manual restart).

**Rollback:**
- **Guard (< 1 min):** revert `~/.claude/settings.json` PreToolUse command to `node ~/.claude/hooks/block-dangerous.mjs` (kept intact).
- **PC/Mac CLI & supervisor (< 2 min):** stop `cb supervise`, `git checkout <prev-sha>` on PC (and tar to Mac), restart `cb supervise`; relays auto-restart back to the previous `cb-relay/<ver>`.
- **vps2 (< 2 min):** `git checkout <prev-sha> && cd deploy && dc up -d --build board` (`docs/ops/maintain.md:71-73`; remember `git checkout vps` before next forward deploy). Schema stays forward-only; older code ignores `sessions.agent` and extra JSON keys.

## Report vs code notes (verified in this worktree)

- `A-runtime-lockin.md:227` omitted `test/github.test.ts:670` and `test/sendback.test.ts:352` from tests spawning `cli/relay.ts` with `CLAUDE_CODE_MESSAGING_SOCKET`; both must stay green.
- `B-prompts-kit-config-lockin.md §10` listed 4 live PC risks (missing freellm guard, OpenCode global `CLAUDE.md` leak, Codex warp plugin, missing PC `PowerShell` matcher); `squads-beyond-claude.html:87` confirms all 4 were fixed on 2026-11-26 (only the plaintext GitHub token in `~/.claude/settings.json` remains open).
- `kit/hooks/block-dangerous.mjs:221,230` (found in code, not in reports): `protectedPush` matches only `/` before `git` (misses `C:\...\git.exe` and `GIT.EXE`) and joins only `\\\r?\n` (misses PowerShell `` `\r?\n ``), whereas `killByName` (`:76,116`) already handles both. Phase 1 fixes both.
- `test/dangerous.test.ts:385-387,523` explicitly pin today's fail-open behavior on empty/invalid JSON and missing `tool_input.command`; Phase 1 intentionally flips those assertions to fail-closed.

## Risks

- **Fail-closed guard breaking a benign Claude tool shape:** if Claude sends a `PreToolUse` payload whose field name changes in a future CLI update, `shim-claude.mjs` blocks instead of allowing. Mitigation: error message prints the exact missing key/type so Ahmed sees it immediately, and rollback to `~/.claude/hooks/block-dangerous.mjs` is one line.
- **Stale Claude endpoint file after crash or pane reuse:** a new Claude session reusing a herdr pane before the old relay exits could collide on `seatKey`. Mitigation: launcher overwrites `cb-seat-<key>.claude.json` atomically before checking the lock, and `--child` reloads on file mtime change and exits when `existsSync(ep.socket)` turns false.
- **False-positive PowerShell blocks in Ahmed's ad-hoc sessions:** `Remove-Item -Recurse` on a project build dir (e.g. `Remove-Item -Recurse -Force dist`) must pass while root/drive/home/`*` targets block. Mitigation: target-anchored regexes (mirroring `rm -rf /` at `kit/hooks/block-dangerous.mjs:42`) plus explicit allow-list tests in `test/guard.test.ts`.
- **Two-machine drift on Mac tar deploy:** if `kit/guard/` is updated in `~/Work/claude-board` without running `install.mjs`, the live `~/.claude-board/guard/` lags behind. Mitigation: `install.mjs --check` compares hashes against checkout and `docs/ops/maintain.md` lists it in the Upgrade checklist.

## Questions for Ahmed

1. Should `architect` and `owner` stay allowed to use `Edit`/`Write` (matching today's `kit/permissions/{architect,owner}.json`, where they can write draft design files before `cb page set -f`), or move into `READ_ONLY_ROLES` alongside `reviewer`, `qa` and `investigator`? **Recommended:** keep them allowed in Phase 1; effect: zero surprise change for architects/owners writing local draft files before `cb page set -f`.
2. Should `cb.squad_set` allow saving `codex`/`opencode`/`agy` entries (including in `fallback`) in Phase 1 while `cb squad up` and `cb supervise` refuse to launch any non-Claude seat until its phase ships, or reject non-Claude `agent` values in `cb.squad_set` until Phase 2? **Recommended:** accept and validate all four in `cb.squad_set` now, block at launch; effect: Phases 2–5 need zero schema changes to `cb.squad_set`.
3. May the Phase 1 release update `~/.claude/settings.json` on the PC and Mac to invoke `node ~/.claude-board/guard/shim-claude.mjs` (keeping `~/.claude/hooks/block-dangerous.mjs` untouched as rollback), or should Phase 1 keep pointing `~/.claude/settings.json` at `~/.claude/hooks/block-dangerous.mjs` as a wrapper? **Recommended:** switch `~/.claude/settings.json` to `~/.claude-board/guard/shim-claude.mjs` on both machines after the 6-probe self-check; effect: all future CLI shims share one installed guard folder and rollback stays a one-line revert.
4. For Phase 1, should `cb.sessions.agent` also appear as a small badge on the web Sessions page (`web/src/views/Sessions.tsx`) now, or wait until Phase 2 when a second agent actually runs? **Recommended:** wait until Phase 2 (keep Phase 1 backend/CLI/kit only, avoiding a Vite build on the PC); effect: smaller, faster Phase 1 release with zero UI churn while every seat is still Claude.
