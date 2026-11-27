# Supervisor (squad piece 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cb supervise` on the PC keeps each supervised project's squad sessions in line with the board's queues: starts, closes and restores sessions through herdr, and restarts the PC runner.

**Architecture:** The board computes the facts (`cb.supervise_state`) and fences claims for closing sessions in SQL; a pure planner (`planTick`) turns facts into actions; a thin daemon (`cli/supervise.ts`) holds an advisory lock, ticks every 60 s and acts through herdr, reusing `cli/squad-up.ts`'s launch code.

**Tech Stack:** Node 24 + TypeScript (run by node's type stripping), `postgres` client, plpgsql in `db/schema.sql`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-23-supervisor-design.md` (approved Q2380; restore decided Q2381).

## Global Constraints

- Board rules live in SQL `cb.*` functions in `db/schema.sql`, idempotent: `add column if not exists`, `drop function if exists … cascade` before every changed `create function`.
- The supervisor connects with `application_name` `cb-supervisor/<version>`; supervisor-only functions refuse any other name with `only the supervisor can do this` (like `cb._is_runner`).
- Tick every 60 s. Close after 20 minutes with no event. Mac hard cap 8 live sessions (all projects, herdr label `macbook`). At most 3 starts (restores included) per tick across all projects. A name that failed to start is not retried for 10 minutes. Restore at most once per 30 minutes per name. A closing mark lapses after 5 minutes. Close waits at most 60 s for the agent to go. Runner restart when no runner beat for 3 minutes.
- A project is supervised only when `cb._pipeline(project)`, it has a squad, and the squad has `"supervise": true`.
- Never start, close or restore the lead (`orch@*`) or any name `wantList` does not generate for the project.
- Never answer a startup dialog: report it to the lead once per name.
- Board text (events, tells) names sessions, roles and counts only: no card titles, no client text.
- Exact texts: `another supervisor is running`; `only the supervisor can do this`; `supervise must be true or false`.
- Tests touch only `claude_board_test*` databases. Run from `C:/work/sup`:
  `CB_TEST_DB=claude_board_test_sup NODE_OPTIONS=--max-old-space-size=4096 node --test --test-concurrency=1 --test-force-exit test/<file>.test.ts`; take `cb lock take db2` before, `cb lock release db2` after (even on failure).
- Commits: conventional, ending `(#3601)`, never bypass hooks, never push.

## Review Focus

1. A session that claims a card in the seconds a close runs: it must not be exited holding the card (Task 1 fence test + Task 3 re-check test).
2. herdr unreachable or the Mac asleep: no starts on that machine, nothing counted as "down", so no restore storm (Task 3 test: `agent list` fails → no start, no restore).
3. A supervisor restart must not forget its limits: the 30-minute restore limit comes from board events, not memory (Task 2 test via `last_restore`).
4. Sessions started by hand with a role count as capacity and are never closed (Task 2 test).
5. A runner that is alive but not beating (port held): reported at most hourly, never a second runner started (Task 3 test).

---

### Task 1: Board side (SQL)

**Files:**
- Modify: `db/schema.sql` (sessions columns near line 3337; `cb._claimable` ~3643; `cb.squad_set` ~3998; `cb.sessions_overview` ~1567; `cb.digest` ~3732; new functions at the end)
- Modify: `cli/squad-up.ts:7` (`Squad` gains `supervise?: boolean`)
- Test: `test/supervise-state.test.ts` (new)

**Interfaces:**
- Produces:
  - `alter table cb.sessions add column if not exists closing_at timestamptz`
  - `cb._is_supervisor() returns boolean` (`application_name like 'cb-supervisor%'`); `cb._closing(a text) returns boolean` (a session row of `a` with `closing_at > now() - interval '5 minutes'`)
  - `cb._claimable(t, a)` returns false when `cb._closing(a)` (so `task_claim`, `task_queue`, the relay's `next_work` all refuse it)
  - `cb.supervise_state(project text) returns jsonb` (readable by anyone):
    `{ project, squad, supervised: bool, waiting: { builder, reviewer, qa, investigator, architect: int, owner: {<area>: int} }, sessions: [{ actor, role, area, machine, pane, live, holds, questions, jobs, last_event, closing, last_restore }] }`
    - `sessions` = every actor with a `cb.sessions` row bound to the project, plus every actor holding an open card in it; `live` = `last_seen > now() - 90 s`; `holds` = open cards (status not done/cancelled) assigned to it, any project; `questions` = its open questions; `jobs` = its queued/running `cb.jobs`; `last_event` = its latest `cb.events.at`; `last_restore` = latest supervisor event with `data->>'what' = 'restore'` for it; `down_again_logged` = a `down_again` event for it after `last_restore`.
    - `waiting` follows the spec's table; architect counts a design card only when no squad area owner covers any of its labels (squad has no `owner` role, or no label is in `squad.areas`) or `stage_since < now() - 15 min`; owner counts per squad area.
  - `cb.supervise_mark(actor text, closing boolean) returns boolean` (supervisor only): `closing=true` sets `closing_at = now()` on the actor's session rows, then, in a later statement of the same function, returns false and clears it if the actor holds an open card; `closing=false` clears it. Returns true when the mark stands.
  - `cb.supervise_log(project text, what text, session text, note text default null) returns bigint` (supervisor only): one event, actor `supervisor`, kind `supervisor`, summary `<what> <session>` (+ ` (<note>)`), data `{what, session}`; `what` ∈ `start, close, restore, blocked, failed, runner, down_again`.
  - `squad_set` accepts top-level `supervise` (JSON boolean) or refuses `supervise must be true or false`; the unknown-key message names `supervise` too.
  - `sessions_overview` leaves out actors `supervisor` and `runner`.
  - `digest` group 12: when supervisor events exist for the project since `since`: `supervisor: started N, closed N, restored N (cb sessions <project>)`; plus one line per `down_again` / `blocked` event: `<session> <what words>: <note>`.

- [ ] **Step 1: Write the failing tests** in `test/supervise-state.test.ts` (one `freshDb()` per file; seed a pipeline project `sv` with a squad as in `test/squad-up.test.ts`/`squad-kit.test.ts`; act as the supervisor with a second connection `application_name: 'cb-supervisor/test'`):
  - `waiting counts per role`: unassigned `build`/`review`/`qa`/research cards → 1 each; a card held for a down session and an unstaged card → not counted.
  - `owner first, architect after 15 minutes`: design card tagged `claims` (squad area with an owner role) → `owner.claims = 1`, `architect = 0`; set its `stage_since` 16 min back → `architect = 1`; a design card with no squad area tag → `architect = 1` at once.
  - `sessions carry busy facts`: holds, questions, jobs, `last_event`, `live`, `closing`.
  - `a closing session cannot claim`: mark `sv-B1@macbook` → `cb.task_claim` as it returns nothing; `next_work` in `cb.inbox` for it is empty; after `closing_at` is set 6 min back it claims.
  - `a mark loses to a held card`: the session holds an in-progress card → `supervise_mark(…, true)` = false and `closing_at` is null.
  - `supervisor-only`: `supervise_mark` and `supervise_log` from a `cb-web` connection raise `only the supervisor can do this`.
  - `squad_set supervise`: `true`/`false` saved; `"yes"` refused with `supervise must be true or false`.
  - `digest line`: two `start` and one `close` logged → the digest has `supervisor: started 2, closed 1, restored 0 (cb sessions sv)`; a `down_again` event shows its own line.
  - `sessions_overview hides supervisor`: after a `supervise_log`, no row with actor `supervisor`.
- [ ] **Step 2: Run them; expect failures** (functions missing).
- [ ] **Step 3: Implement** the Produces list in `db/schema.sql`; `Squad.supervise?: boolean` in `cli/squad-up.ts`.
- [ ] **Step 4: Run** `test/supervise-state.test.ts`, then the neighbours that touch the changed functions: `squad-stages`, `squad-kit`, `squad-up`, `tick-squad`, `relay`, `tasks` (relay's `type_to` failure is pre-existing). Expected: all pass.
- [ ] **Step 5: Commit** `feat(supervisor): board facts, closing fence and supervisor events (#3601)`.

### Task 2: The planner (pure)

**Files:**
- Modify: `cli/squad-up.ts` (export `launchFor(project: string, squad: Squad, w: { name: string; role: string; area?: string }, first?: 'next' | 'resume'): Launch`, used by `planSquad`; behaviour of `squad up` unchanged)
- Create: `cli/supervise-plan.ts`
- Test: `test/supervise-plan.test.ts`

**Interfaces:**
- Consumes: `wantList`, `Launch`, `Squad` (squad-up.ts); the `supervise_state` shape (Task 1).
- Produces:
  ```ts
  export type State = /* supervise_state's JSON, typed */;
  export type TickInput = { state: State; herdrLive: Set<string>; herdrDown: Set<string> /* machine keys whose herdr could not be read */;
    macLive: number /* every live session on the Mac, all projects */; startsLeft: number; failedAt: Map<string, number>; now: number };
  export type TickPlan = { restore: Launch[]; start: Launch[]; close: string[]; notes: { what: 'down_again'; session: string }[] };
  export function planTick(i: TickInput): TickPlan;
  ```
  `launchFor(..., 'resume')` ends its prompt with `then cb resume` instead of `then cb next`.

Rules `planTick` implements (spec sections 3-4): nothing when `!state.supervised`; restores first, then starts by role in `wantList` order; idle = live, holds 0, questions 0, jobs 0, not closing; per role `start = min(waiting − idle of role, count − live of role, Mac room)`; owner per area; architect from `waiting.architect`; lead never; the lowest wanted name that is not live (board or herdr) and holds nothing; a name with `failedAt` < 10 min ago is skipped; nothing on a machine in `herdrDown`; close = squad names only, idle, `now − last_event ≥ 20 min`, role waiting 0; restore = squad name, not live, not in herdr, holds > 0, machine reachable, and `last_restore` older than 30 min; if `last_restore` is within 30 min the name goes to `notes` as `down_again` instead, unless `down_again_logged` is true.

- [ ] **Step 1: Write the failing tests** (`test/supervise-plan.test.ts`, no DB, a `state()` builder):
  - `not supervised → empty plan`.
  - `starts up to the count`: builder count 2, waiting 5 → 2 starts `sv-B1@macbook`, `sv-B2@macbook`, prompts end `then cb next`, model and settings as `squad up`.
  - `idle sessions cancel waiting work`: one idle live builder, waiting 1 → 0 starts.
  - `hand-started session counts and is never closed`: `foo@macbook` role builder idle 30 min → counted as idle, not in `close`.
  - `Mac cap counts other projects`: `macLive` 7 → 1 start at most.
  - `3 starts per tick`: `startsLeft` 3, waiting across roles 6 → 3.
  - `a recently failed name is skipped`, the next number is used.
  - `close rules`: idle 21 min, role waiting 0 → closed; 19 min → kept; holds a card / open question / queued job → kept; role waiting > 0 → kept; `orch@macbook` never.
  - `owners per area` and `architect only from waiting.architect`.
  - `restore`: down `sv-B1@macbook` holding 1 card, no herdr agent → `restore` with prompt ending `then cb resume`; with `last_restore` 10 min ago → no restore, one `down_again` note; with herdr down → nothing; a down name holding cards is not reused for a new start.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement** `launchFor` (refactor `planSquad` onto it) and `planTick`.
- [ ] **Step 4: Run** `supervise-plan` and `squad-up` tests: all pass.
- [ ] **Step 5: Commit** `feat(supervisor): plan a tick from the board's facts (#3601)`.

### Task 3: The daemon, `cb supervise`, docs

**Files:**
- Modify: `cli/squad-up.ts` (export `startOne(l: Launch, run: Runner, tabs: Record<string, { pane: string; panes: number }>): { line: string; pane?: string; blocked?: boolean; ok: boolean }`, extracted from `squadUp`'s loop; `squadUp` uses it, output unchanged)
- Create: `cli/supervise.ts` (exports `tick(deps): Promise<string[]>`; the loop runs only when the file is the entry point)
- Modify: `cli/cb.ts` (case `supervise`, like `runner`: spawns `node cli/supervise.ts` with `--dry-run` / `--once` passed through), `cli/help.ts` (`supervise` in the orchestrate topic: `cb supervise [--dry-run|--once]`), `docs/ops/maintain.md` (a "Supervisor" section: start it in herdr tab `supervisor` on the PC, `supervise: true` per project, what it never does), `prompts/roles/lead.md` (one line: the supervisor starts and closes sessions; `blocked` and `down_again` lines are yours)
- Test: `test/supervise.test.ts`

**Interfaces:**
- Consumes: `planTick` (Task 2); `supervise_state`, `supervise_mark`, `supervise_log`, `jobs_list` (Task 1 / existing); `startOne`, `classifyAgentGet`, `herdrName`, `Runner` (squad-up.ts).
- Produces: `tick({ sql, run: Runner, dryRun, now, memory: { failedAt: Map<string, number>; blockedTold: Set<string>; runnerToldAt: number }, runnerConfig: string | null, probe: (host: string, port: number) => Promise<boolean> }): Promise<string[]>` returning the lines it printed.

Behaviour:
- Start-up: connect with `application_name` `cb-supervisor/<sha256 of supervise.ts + supervise-plan.ts + squad-up.ts, 7 chars>`, `max: 2`; `select pg_try_advisory_lock(hashtext('cb-supervisor'))`; false → print `another supervisor is running`, exit 1. Log lines go to stdout and `~/.claude-board/supervisor/supervisor.log` (`CB_SUPERVISOR_HOME` overrides; files older than 7 days pruned at start, one file per day `YYYY-MM-DD.log`).
- Each tick: projects = `cb.projects` with a squad whose `supervise` is true; per machine key used by any squad, read `herdr [--machine m] agent list` once (failure → machine in `herdrDown`); count Mac live sessions (board `live` on herdr label `macbook` ∪ herdr agents there); per project `planTick`, sharing `startsLeft = 3`; act in order restore → start → close; then the runner check.
- Start/restore: `startOne`; ok → `supervise_log(start|restore)`; blocked → `supervise_log(blocked, note: pane)` and `cb.tell` to the squad lead `orch@<lead machine>` once per name per supervisor run (skip if the squad has no lead); failure → `failedAt.set(name, now)` and `supervise_log(failed, note: first 80 chars of the error)`.
- Close: `supervise_mark(name, true)` → false: skip; re-read `supervise_state` and confirm the session still holds nothing (else `supervise_mark(name, false)` and skip); `herdr agent get <herdrName>` for its pane; `herdr agent prompt <name> /exit`; poll `agent get` every 5 s up to 60 s until `absent`, then `pane close <pane>` and `supervise_log(close)`; still there after 60 s → clear the mark, print `could not close <name>`, no event.
- `down_again` notes → `supervise_log(down_again, note: 'restore it by hand')`, once per restore.
- Runner: when `runnerConfig` (default `~/.claude-board/runner.json`, `CB_RUNNER_CONFIG` overrides) exists and `jobs_list(null).runners` has no `last_seen` within 3 minutes: `probe(log.host, log.port)` true → print and `supervise_log(runner, note: 'not beating but its port is held')` at most hourly (`runnerToldAt`); false → `herdr tab create --cwd <board checkout> --label runner --no-focus`, then `herdr pane run <pane> "cb runner"`, `supervise_log(runner, note: 'started')`. Runner events carry project `null`.
- `--dry-run`: one tick, prints the plan (`would start …`, `would close …`, `would restore …`, `would start the runner`), calls no herdr action and writes nothing; `--once`: one real tick, then exit.

- [ ] **Step 1: Write the failing tests** (`test/supervise.test.ts`, test DB + a fake `Runner` recording herdr calls, as `test/squad-up.test.ts` does; supervisor connection with `application_name: 'cb-supervisor/test'`):
  - `a waiting build card starts a builder`: one tick → herdr `tab create` + `agent start sv-b1-macbook … --model sonnet --permission-mode bypassPermissions --settings …/kit/permissions/builder.json` + `agent prompt`; a `start` event exists.
  - `dry run acts on nothing`: no herdr call except `agent list`/`agent get`; no event.
  - `herdr unreachable → no start, no restore` (fake `agent list` fails for `macbook`).
  - `close sequence`: an idle 21-min squad session → `agent prompt <name> /exit`, `pane close`, a `close` event, `closing_at` cleared or lapsed; `a claim between mark and re-check stops the close` (fake inserts a held card when `supervise_mark` runs → no `/exit`, mark cleared).
  - `blocked start tells the lead once`: fake `agent start` fails with `agent_not_ready`; on the second tick the fake `agent get` reports the name live → one `cb.tell` to `orch@macbook` and one `blocked` event in total, no second `agent start`.
  - `runner`: config file present, no runner beat, probe false → `tab create … --label runner` + `pane run <pane> cb runner`; probe true → one event, and a second tick within the hour adds none.
  - `a second supervisor exits`: spawn `node cli/supervise.ts --once` while the test holds the advisory lock → exit 1, stderr/stdout `another supervisor is running`.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement** `startOne` extraction, `cli/supervise.ts`, the `cb supervise` case, help, docs, lead prompt line.
- [ ] **Step 4: Run** `supervise`, `squad-up`, `help`, `squad-kit`, `cli` tests: all pass. `help.test.ts` checks every documented command, so add `supervise` where it lists commands.
- [ ] **Step 5: Commit** `feat(supervisor): cb supervise starts, closes and restores squad sessions (#3601)`.

### Task 4: Release and live check (controller, not a subagent)

- [ ] Full suite under `cb lock take db`; compare failures with base `69d4209` (known: pings ×3, relay `type_to`, ring/voice need web).
- [ ] Final whole-branch review (Opus), one fix wave, scoped re-review.
- [ ] `cb ask claude-board -t 3601` for merge and deploy; then fast-forward main, deploy vps2 (schema applies on start), pull the PC, copy to the Mac.
- [ ] Live check on `kitlive` (pipeline on, squad with `supervise: true`, builder count 2 on `macbook`): two build cards → two builders start and take them; a session holding a card is never closed; an idle builder is closed after 20 min; a holding builder's pane closed by hand → restored within a minute with `cb resume`; runner tab closed → restarted within 4 minutes. Then `supervise: false` on kitlive and close what the check started.
