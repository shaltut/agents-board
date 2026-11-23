# PC Job Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A squad session runs `cb run <recipe> --sha <sha>`; a runner on the PC runs that named check at that commit and the result comes back as a board message.

**Architecture:** Board rules in `cb.*` SQL (`cb.jobs`, `cb.runners`, `cb.runner_recipes` and their functions). A daemon `cli/runner.ts` on the PC claims jobs, runs recipe steps from a PC-only `runner.json` in per-slot clones, writes full logs locally and serves them to Tailscale peers. Pure parts (recipe checks, argv building, summaries, masking) live in their own files with unit tests.

**Tech Stack:** Node 24 (TypeScript run directly, no build), postgres.js, node:test, node:http, git, Postgres.

**Spec:** `docs/superpowers/specs/2026-11-23-pc-job-runner-design.md` (approved Q2375). Read it before your task.

## Global Constraints

- Board rules live in `cb.*` SQL functions in `db/schema.sql`, idempotent: `create table if not exists`, `add column if not exists`, `drop function if exists cb.<fn> cascade` before each `create function`. New SQL goes at the end of the file.
- The CLI stays thin; `cli/cb.ts` is already 926 lines, so command logic goes in a new file and `cb.ts` only dispatches.
- Job functions are **not** added to the RPC allowlist (`server/rpc.ts`): the web does not queue jobs. The CLI calls them with `sql\`select cb.job_add(...)\``.
- Commands run with **no shell**: `spawn(argv[0], argv.slice(1), { shell: false, windowsHide: true })`.
- A parameter value: matches `^[A-Za-z0-9@._/-]{1,200}$`, never starts with `-` or `/`, has no `..` path segment; at most 20 values per parameter. Checked in SQL at queue time and again by the runner.
- A job's environment is built from nothing: these names copied from the runner's own env when set: `PATH PATHEXT SYSTEMROOT SYSTEMDRIVE WINDIR COMSPEC TEMP TMP HOME USERPROFILE APPDATA LOCALAPPDATA PROGRAMDATA PROGRAMFILES PROGRAMFILES(X86) NUMBER_OF_PROCESSORS VOLTA_HOME`, then runner.json `passEnv` names, then `NO_COLOR=1`, `FORCE_COLOR=0`, `CI=1`, then the recipe's `env`. Nothing else (no `CB_*`, no `DATABASE_URL`).
- Job states: `queued`, `running`, `passed`, `failed`, `error`, `cancelled`. Summary at most 1,000 characters.
- Error summaries use these exact texts: `error: push it first`, `error: not on a branch of origin`, `error: timed out after <N> min`, `error: Docker is not running`, `error: runner restarted`, `error: could not start <cmd>`, `error: bad parameter <name>: <value>`, `error: could not fetch from origin`, `error: bad job row`, `no tests ran: <summary>`, `summary withheld: see cb job log <id>`.
- The runner trusts nothing in a job row: it re-checks the sha, finds the project and recipe in its own config and re-checks every parameter. Git fetches only `refs/heads/*`; never fetch by sha or any other ref.
- Board text carries no identifiers or patient data; the runner masks summaries (Task 3) before writing them.
- Paths: config `$CB_RUNNER_CONFIG` else `~/.claude-board/runner.json`; runner home `$CB_RUNNER_HOME` else `~/.claude-board/runner` (logs in `<home>/logs/<id>.log`, kept 7 days; per-slot install state in `<home>/state/`).
- The runner's DB connection uses application name `cb-runner/<version>`; runner-only SQL functions refuse any other name (`cb._is_runner()`), the same deterrent level as `cb-web`.
- Tests: `CB_TEST_DB=claude_board_test_runner NODE_OPTIONS=--max-old-space-size=4096 node --test --test-concurrency=1 --test-force-exit test/<file>.test.ts`. Only `claude_board_test*` databases. Never run tests on a VPS.
- Keep every new source file under 400 lines.

## Review Focus

1. A recipe command that cannot start (missing program, a `.cmd` file on Windows) ends the job `error: could not start <cmd>` and the runner keeps serving the next job. (Task 4 test)
2. Megabytes of output, including one line with no newline, keep the summary within 1,000 characters; the runner reads at most the last 1 MB of a log for the summary and the full log stays on disk. (Task 3 and Task 4 tests)
3. Output holding a token, an email or a 10-digit number reaches the board masked, and the board accepts it. (Task 3 test against the real `cb._sensitive`)
4. A runner killed mid-job and started again marks that job `error: runner restarted`, tells the requester, and still runs the queued jobs. (Task 4 test)
5. Flag- or path-shaped values (`-r`, `../x`, `C:/x`, `/etc`, `a b`, 21 values, an unknown parameter) are refused at `cb run` time with a reason that names the parameter. (Task 1 SQL test, Task 5 CLI test)

---

### Task 1: Jobs on the board (schema)

**Files:**
- Modify: `db/schema.sql` (append at the end)
- Test: `test/jobs.test.ts` (create)

**Interfaces:**
- Produces tables:
  - `cb.runners(name text primary key, log_url text, started_at timestamptz, last_seen timestamptz)`
  - `cb.runner_recipes(runner text references cb.runners(name) on delete cascade, project text, recipe text, params jsonb not null default '{}', db boolean not null default false, primary key (runner, project, recipe))`; `params` is `{"<name>": {"min": int, "max": int}}`
  - `cb.jobs(id bigserial primary key, project text not null references cb.projects(slug) on update cascade, recipe text not null, params jsonb not null default '{}', sha text not null, requester text not null, task_id bigint references cb.tasks(id) on delete set null, state text not null default 'queued' check (state in ('queued','running','passed','failed','error','cancelled')), exit_code int, summary text, runner text, created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz)`, partial index on `(state, id) where state in ('queued','running')`. `params` is `{"<name>": ["v", ...]}`.
- Produces functions (all `#variable_conflict use_variable`):
  - `cb._is_runner() returns boolean`: `current_setting('application_name') like 'cb-runner%'`.
  - `cb.job_add(project text, recipe text, sha text, params jsonb default '{}', task_id bigint default null, actor text default null) returns jsonb` → `{"id": N, "ahead": K}`; `pg_notify('cb_jobs', id::text)`.
  - `cb.job_get(id bigint) returns jsonb` (the row, or null).
  - `cb.jobs_list(project text default null) returns jsonb` → `{"jobs": [queued and running rows, oldest first], "runners": [{"name", "last_seen", "recipes": [{"project","recipe","params","db"}]}]}`.
  - `cb.job_cancel(id bigint, actor text default null) returns void`; `pg_notify('cb_jobs', id::text)`.
  - `cb.runner_hello(runner text, log_url text, recipes jsonb) returns int` (runner only): upserts `cb.runners`, replaces that runner's `cb.runner_recipes` rows from `recipes` (`[{"project","recipe","params","db"}]`), ends that runner's `running` jobs as `error` with summary `error: runner restarted` and tells each requester; returns how many it ended.
  - `cb.runner_beat(runner text) returns void` (runner only).
  - `cb.job_claim(runner text, allow_db boolean) returns jsonb` (runner only): the oldest `queued` job whose `(project, recipe)` this runner published, skipping `db` recipes unless `allow_db`; `for update skip locked`; sets `running`, `runner`, `started_at`; returns the row plus `"db"`, or null.
  - `cb.job_finish(id bigint, runner text, state text, exit_code int, summary text) returns boolean` (runner only): only from `running` and only by that runner, else returns false; `state` in `passed`,`failed`,`error`; refuses `length(summary) > 1000` and any `cb._sensitive(summary)` hit (raise, message contains `looks like`); sets `finished_at`; sends the requester one message through `cb.tell(requester, msg, 'runner')`, best effort: a tell that raises (requester unknown) is caught and the job still ends. `runner_hello` tells the same way.

- [ ] **Step 1: Write the failing tests** in `test/jobs.test.ts`. Setup (pattern of `test/squad-timers.test.ts`): `freshDb()`, `cb.ensure_project('demo')`, a session row `('mac','p2','B1@mac','demo','builder')`, a lead `('pc','p4','orch@pc','demo','lead')`; a runner connection `postgres(TEST_URL, { connection: { application_name: 'cb-runner/test' } })` that calls `cb.runner_hello('pc', 'http://127.0.0.1:1', '[{"project":"demo","recipe":"test","params":{"files":{"min":1,"max":20}},"db":false},{"project":"demo","recipe":"itest","params":{"files":{"min":1,"max":20}},"db":true}]')`. Tests:
  - `queues a job for a bound session and counts the ones ahead`: two `job_add` as `B1@mac` → second returns `ahead: 1`; sha `ABCDEF1` is stored lower-case.
  - `refuses unknown recipes, unknown or missing params and bad values, naming the param`: unknown recipe → `/no recipe ghost/`; `{"other":["a"]}` → `/unknown parameter other/`; `{}` for `test` → `/files needs at least 1/`; each of `-r`, `../x`, `a/../b`, `C:/x`, `/etc`, `a b`, `x\y` → `/bad value for files/`; 21 values → `/at most 20/`; sha `xyz` → `/sha/`.
  - `only a bound session of the project, or the dashboard, may queue`: actor `stranger@mac` (no session) → `/bound session/`; a `B1@mac` session with `last_seen` 2 days old → refused; a session of another project → refused; a `cb-web` connection as `ahmed` → accepted.
  - `claim is exclusive and skips DB jobs when told to`: one queued `test` job; two runner connections call `job_claim` concurrently → exactly one gets it; a queued `itest` job with `allow_db=false` → null, with `true` → claimed.
  - `a session connection cannot claim or finish`: `job_claim` on the plain test connection → `/only the runner/`.
  - `finish sends the requester one message and ends the job once`: claim, `job_finish(id,'pc','failed',1,'1 passed, 1 failed. Failing: breaks')` → true; event `kind='message'`, `actor='runner'`, `data->>'to'='B1@mac'`, summary contains `job #<id>`, `test`, the 7-char sha, `failed (exit 1)`, the summary, `cb job log <id>`; a second finish → false.
  - `finish refuses a summary the board would flag or one over 1000 chars`: summary with `user@example.org` → `/looks like/`; 1001 chars → `/1000/`; the job stays `running`.
  - `cancel: requester, lead or dashboard; queued or running only`: `stranger@mac` → `/only the requester/`; `orch@pc` (lead) → ok, state `cancelled`, `finished_at` set; cancelling again → `/already ended/`; `job_finish` after cancel → false.
  - `runner restart ends its running jobs and tells the requesters; queued jobs stay`: one running, one queued; `runner_hello` again → returns 1; the running one is `error` with `error: runner restarted`; requester has a message; the queued one is still `queued`.
  - `the end survives a requester the board no longer knows`: delete the requester's session row (and its events), then `job_finish` → true, state `passed`; same for `runner_hello` ending a running job.
  - `jobs_list shows queued and running jobs and the runner's last beat`.

- [ ] **Step 2: Run it to make sure it fails**
  Run: `CB_TEST_DB=claude_board_test_runner NODE_OPTIONS=--max-old-space-size=4096 node --test --test-concurrency=1 --test-force-exit test/jobs.test.ts`
  Expected: FAIL (`function cb.runner_hello ... does not exist`).

- [ ] **Step 3: Implement the tables and functions** at the end of `db/schema.sql`. `job_add` reuses `cb.set_actor`, `cb.read_project`, `cb._is_dashboard`; bound session = a `cb.sessions` row with `actor = a`, `project = p`, `last_seen > now() - interval '1 day'`. Value rule from Global Constraints (no `..` segment: `v ~ '(^|/)\.\.(/|$)'`). Message text: `job #<id> <recipe> at <sha7>: <state>[ (exit <n>)]. <summary>` + newline + `Log: cb job log <id>`.

- [ ] **Step 4: Run the tests** (same command). Expected: all pass, 0 skipped.

- [ ] **Step 5: Commit** `feat(runner): jobs, runners and recipes on the board (#3600)`

### Task 2: Recipes: load, check, build (pure)

**Files:**
- Create: `cli/recipes.ts`
- Create: `docs/ops/runner.example.json` (the iHop recipes below; `log.host` and `log.peers` hold placeholder Tailscale addresses `100.64.0.1`, `100.64.0.2`)
- Test: `test/recipes.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (`cli/recipes.ts`):
  - `type Param = { pattern: string; min: number; max: number }` (defaults `min 1`, `max 1`; `max` ≤ 20)
  - `type Recipe = { steps: string[][]; finally: string[][]; cwd: string; env: Record<string,string>; timeout: number /* seconds */; db: boolean; params: Record<string, Param> }`
  - `type Project = { git: string; base: string; lockfile: string; install: string[]; installTimeout: number; recipes: Record<string, Recipe> }`
  - `type RunnerConfig = { name?: string; slots: number; log: { host: string; port: number; peers: string[] }; passEnv: string[]; projects: Record<string, Project> }`
  - `loadConfig(text: string): RunnerConfig` — parses and validates; throws `Error` naming the field (`projects.ihop.recipes.test.steps[0]: ...`). Rules: `slots` 1-4; every slot `{x}` in a step, `finally` or `cwd` names a declared param; an argv element holds at most one slot; `cwd` may use only params with `max` 1; every `pattern` compiles; recipe names and param names match `^[a-z][a-z0-9-]*$`; `timeout` 1-7200.
  - `checkParams(recipe: Recipe, params: Record<string, string[]>): string | null` — null when fine, else `error: bad parameter <name>: <value>` (or `<name>: unknown` / `<name>: needs at least <min>` / `<name>: at most <max>`). Applies the Global Constraints value rule, then the recipe pattern.
  - `expand(argv: string[], params: Record<string, string[]>): string[]` — an element containing `{name}` becomes one element per value, the slot replaced (`"--filter={ws}"` with `ws=[a,b]` → `"--filter=a","--filter=b"`); a param with no values drops the element.
  - `jobCwd(slotDir: string, recipe: Recipe, params): string` — resolves `cwd` inside `slotDir`; throws if the result leaves `slotDir`.
  - `jobEnv(from: NodeJS.ProcessEnv, cfg: RunnerConfig, recipe: Recipe): Record<string,string>` — Global Constraints env rule.
  - `published(cfg: RunnerConfig): { project: string; recipe: string; params: Record<string,{min:number;max:number}>; db: boolean }[]` — what `runner_hello` gets (no argv, no patterns, no env).

- iHop recipes for `runner.example.json` (project `ihop`, `git` `https://github.com/TachyHealth/iHop-Platform.git`, `base` `C:/r`, `lockfile` `pnpm-lock.yaml`, `install` `["pnpm","install","--frozen-lockfile"]`, `installTimeout` 1200). `ws` pattern `^@ihop/[a-z0-9-]+$`. Integration env for `itest`/`kbtest`: `INTEGRATION_TESTS=1`, `DB_SSL_DISABLE=true`, `SSO_CONFIG_ENCRYPTION_KEY=` a 43-char base64 placeholder, `TEST_STACK_PROJECT=cb-runner-it`, `TEST_STACK_PG_PORT=55432`, `TEST_STACK_REDIS_PORT=56379`, `TEST_STACK_S3_PORT=59000`. `NODE_OPTIONS=--max-old-space-size=4096` on `check`, `test`, `itest`, `build`.

  | Recipe | params | cwd | steps | finally | timeout | db |
  |---|---|---|---|---|---|---|
  | install | — | `.` | `pnpm install --frozen-lockfile` | — | 1200 | no |
  | check | ws 1-6 | `.` | `pnpm --filter={ws} check` | — | 1200 | no |
  | test | app `^(claims-api\|preauth)$`; files 1-20 `^tests/(?![A-Za-z0-9._/-]*\.integration\.test\.ts$)[A-Za-z0-9._/-]+\.test\.ts$` | `apps/{app}` | `node --conditions=development --env-file-if-exists=.env.test --import tsx --test --test-force-exit --test-concurrency=1 {files}` | — | 1800 | no |
  | itest | files 1-20 `^tests/[A-Za-z0-9._/-]+\.integration\.test\.ts$` | `apps/claims-api` | `node ../../scripts/test-stack/claims-integration.mjs up --env-out .env.integration`; `node --conditions=development --env-file-if-exists=.env.test --env-file=.env.integration --import tsx --test --test-force-exit --test-concurrency=1 {files}` | `node ../../scripts/test-stack/claims-integration.mjs down` | 2400 | yes |
  | kbtest | files 1-20 `^(server\|client\|tests)/[A-Za-z0-9._/-]+\.db\.test\.ts$` | `apps/knowledge-base` | `node ../../scripts/test-stack/claims-integration.mjs up --env-out .env.integration`; `node --env-file=.env.integration node_modules/vitest/vitest.mjs run {files}` | same `down` | 2400 | yes |
  | vitest | ws 1; files 1-20 `^[A-Za-z0-9._/-]+\.test\.tsx?$` | `.` | `pnpm --filter={ws} exec vitest run {files}` | — | 1800 | no |
  | lint | files 1-20 `^[A-Za-z0-9._/-]+\.(ts\|tsx\|mts\|mjs\|js\|json\|md\|css\|yml\|yaml)$` | `.` | `pnpm exec oxlint {files}`; `pnpm exec prettier --check {files}` | — | 600 | no |
  | build | ws 1-6 | `.` | `pnpm exec turbo build --filter={ws}` | — | 1800 | no |
  | guards | — | `.` | one step each: `node scripts/<x>.mjs` for `image-digest-guard`, `log-discipline-guard`, `telemetry-names-guard`, `metric-registry-guard`, `secrets-scan`, `input-validation-audit`, `suppression-audit`, `llm-client-boundary`, `check-auth-error-envelope` | — | 900 | no |

  `tsx` and `vitest` resolve only from inside the app folder in an iHop checkout (checked 2026-11-23), so `itest` and `kbtest` run from the app folder and reach the stack script by `../../`. The `..` is in the trusted recipe, never in a parameter. The stack script writes `--env-out` relative to its cwd.

- [ ] **Step 1: Write the failing tests** in `test/recipes.test.ts` (no DB):
  - `the iHop example loads and publishes names only`: `loadConfig(readFileSync('docs/ops/runner.example.json'))` succeeds; `published()` has the nine iHop recipes; `JSON.stringify(published(cfg))` contains no `pnpm`, no `node`, no `pattern`, no `TEST_STACK`.
  - `loadConfig names the bad field`: unknown slot `{nope}` → `/steps\[0\].*nope/`; two slots in one element → refused; bad regex → refused; `slots: 9` → refused; a `cwd` using a list param → refused.
  - `checkParams refuses flag- and path-shaped values and the pattern`: with the example `test` recipe, `files: ['-r']`, `['../x']`, `['tests/../x.test.ts']`, `['C:/x']`, `['/etc']`, `['a b']`, `['tests/a.ts']` (pattern), `['tests/a.integration.test.ts']` (integration files go to `itest`) → each returns a string starting `error: bad parameter files:`; 21 values → `files: at most 20`; `app: ['claims-api'], files: ['tests/a.test.ts']` → null; `extra: ['x']` → `extra: unknown`.
  - `expand repeats an element per value and drops empty params`: `expand(['pnpm','--filter={ws}','check'], {ws:['@ihop/a','@ihop/b']})` → `['pnpm','--filter=@ihop/a','--filter=@ihop/b','check']`; `expand(['node','{files}'], {files:[]})` → `['node']`.
  - `jobCwd stays inside the slot`: `apps/{app}` with `app=['claims-api']` → `<slot>/apps/claims-api`; a cwd that resolves outside → throws.
  - `jobEnv starts empty`: given `{ PATH: 'p', CB_DATABASE_URL: 'x', DATABASE_URL: 'y', SECRET: 's', TEMP: 't' }` and a recipe env `{ A: '1' }` → exactly `{ PATH, TEMP, NO_COLOR:'1', FORCE_COLOR:'0', CI:'1', A:'1' }` plus any `passEnv` names present.

- [ ] **Step 2: Run them to make sure they fail**: `node --test --test-force-exit test/recipes.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `cli/recipes.ts` and write `docs/ops/runner.example.json`.**
- [ ] **Step 4: Run them**: all pass.
- [ ] **Step 5: Commit** `feat(runner): recipe file, parameter checks and argv building (#3600)`

### Task 3: Summaries and masking (pure)

**Files:**
- Create: `cli/summary.ts`
- Test: `test/summary.test.ts`; fixtures committed with this plan: `test/fixtures/runner/node-test-fail.txt` (node 24 spec reporter, 1 pass, 1 fail, 1 skip), `test/fixtures/runner/vitest-fail.txt` (vitest 4.1, same three tests in `describe('suite')`)

**Interfaces:**
- Produces:
  - `summarize(output: string): { text: string; ran: number | null }` — `ran` is passed + failed when counts were found, else null. Strips ANSI; node:test (a line ending `pass N` / `fail N` / `skipped N` with any or no prefix: `ℹ`, `#`, or a mangled glyph; last occurrence wins; failing names from `✖ <name> (<n>ms)` lines and TAP `not ok N - <name>`, skipping the `failing tests:` header, de-duplicated) → `<p> passed, <f> failed, <s> skipped. Failing: <n1>; <n2>...`; vitest (` Tests  1 failed | 1 passed | 1 skipped (3)` and ` FAIL  <file> > <suite> > <name>`) → same shape; neither → the last 10 non-empty lines joined by newlines. At most 5 failing names, then `and <k> more`. Never longer than 1,000 characters (cut with `…`). `Failing:` only when there are failures.
  - `mask(text: string): string` — replaces every match of the `cb._sensitive` patterns (copy them from `db/schema.sql`, function `cb._sensitive`: tokens, bearer, JWT, private key header, URL with password, credential assignments and `--password`-style flags, 10-digit IDs except `2147483647`/`2147483648`, emails except the listed system users, phone numbers) with `[masked]`.
  - `logTail(path: string, bytes = 1_048_576): string` — the last `bytes` of a file as text.

- [ ] **Step 1: Write the failing tests:**
  - `node:test output gives counts and the failing name`: `summarize(fixture node-test-fail).text` === `1 passed, 1 failed, 1 skipped. Failing: breaks on purpose`.
  - `a mangled summary glyph still counts`: the fixture with every `ℹ` replaced by `?` gives the same text.
  - `ran is null without counts and 0 when nothing ran`: plain text → null; `ℹ pass 0` / `ℹ fail 0` / `ℹ skipped 4` → 0.
  - `vitest output gives counts and the failing path`: `.text` === `1 passed, 1 failed, 1 skipped. Failing: c.test.ts > suite > breaks on purpose`.
  - `TAP output works too`: a hand-written TAP sample with `not ok 2 - b` and `# pass 1`/`# fail 1` → `1 passed, 1 failed, 0 skipped. Failing: b`.
  - `other output gives the last 10 lines`: 30 numbered lines → lines 21-30.
  - `at most 5 failing names`: 8 `✖ tN (1ms)` lines → names t1..t5 then `and 3 more`.
  - `huge output stays within 1000 characters`: a 5 MB string with no newline → length ≤ 1000.
  - `mask hides what the board would refuse` (uses the test DB): for each of `ghp_` + 30 chars, `Bearer abcdefghijklmnopqrstuvwxyz123`, a JWT, `postgres://u:pw@h/db`, `password=hunter2!x`, `--token abc123`, `ID 1234567890`, `mail a.person@example.org`, `+966 55 123 4567`: `mask(x)` contains `[masked]` and `select cb._sensitive(${mask(x)})` is null; `mask('1 passed, 2 failed')` is unchanged.
  - `logTail reads only the end`: a 3 MB temp file → result length ≤ 1,048,576 and ends with the file's last line.
- [ ] **Step 2: Run** `CB_TEST_DB=claude_board_test_runner node --test --test-concurrency=1 --test-force-exit test/summary.test.ts` → FAIL.
- [ ] **Step 3: Implement `cli/summary.ts`.**
- [ ] **Step 4: Run** → all pass.
- [ ] **Step 5: Commit** `feat(runner): job summaries and masking (#3600)`

### Task 4: The runner daemon

**Files:**
- Create: `cli/runner.ts` (the daemon: startup, LISTEN, slots, claim, cancel, heartbeat, log server, log cleanup)
- Create: `cli/runner-job.ts` (one job: prepare the slot clone, run steps, timeouts, tree kill, finish)
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: Task 1 functions (`runner_hello`, `runner_beat`, `job_claim`, `job_finish`, channel `cb_jobs`); Task 2 `loadConfig`, `checkParams`, `expand`, `jobCwd`, `jobEnv`, `published`; Task 3 `summarize`, `mask`, `logTail`.
- Produces: `node cli/runner.ts` (no arguments) — what `cb runner` (Task 5) starts. Prints one line per job start and end to stdout. Exports nothing other tasks import.

Behaviour (spec "The runner daemon on the PC"):
- Start: read config (`CB_RUNNER_CONFIG`); name = `cfg.name ?? machine()`; bind the log server on `cfg.log.host:cfg.log.port` first — if the port is taken, print `a runner is already running on this machine` and exit 1 (this is the one-per-machine guard); connect with `connect(undefined, { app: 'cb-runner/<version>', max: 4 })`; `runner_hello(name, 'http://<host>:<port>', published(cfg))`; delete logs older than 7 days (again every 24 h); `LISTEN cb_jobs`; every 30 s `runner_beat` + claim + cancel check.
- Claim loop: while a slot is free, `job_claim(name, allow_db = no db job running)`; slot = lowest free number 1..`slots`; slot dir `<project.base>/<project>-<slot>`.
- Per job (`runner-job.ts`), output to `<home>/logs/<id>.log`, in order, first failure ends the job:
  1. Re-check the row: sha `^[0-9a-f]{7,40}$`, project and recipe present in the local config, `params` an object of string arrays → else `error: bad job row`; then `checkParams` → `error: bad parameter …`.
  2. Git runs with the runner's env plus `GIT_TERMINAL_PROMPT=0`, each command capped at 600 s; a clone or fetch that fails or times out → `error: could not fetch from origin`. Clone if missing (`git clone --no-checkout <git> <dir>`); `git fetch --prune origin +refs/heads/*:refs/remotes/origin/*`; `git rev-parse --verify --quiet <sha>^{commit}` fails → `error: push it first`; `git branch -r --contains <full>` empty → `error: not on a branch of origin`; `git checkout --force --detach <full>`; `git clean -ffdx -e node_modules`. Git commands run with the runner's own env (they need its credentials); recipe commands never do.
  3. Lockfile blob (`git rev-parse <full>:<lockfile>`) differs from `<home>/state/<project>-<slot>.lock` → run `install` (job env, `installTimeout`), then write the state file; install failing → `failed` with the summary of its output.
  4. `db` recipe: `docker info` exit ≠ 0 → `error: Docker is not running`.
  5. Steps (`expand`, `jobCwd`, `jobEnv`); spawn error (ENOENT, EINVAL) → `error: could not start <argv[0]>`; a non-zero exit → `failed` with that exit code; the job deadline is `timeout` seconds from the first step → kill the tree, `error: timed out after <N> min` (N rounded up).
  6. `finally` steps always run after steps start (each capped at 300 s), even after a timeout or cancel; their exit does not change the result.
  7. Summary: errors from 1-4 use their exact text; otherwise `mask(summarize(logTail(log)).text)`. All steps exit 0 but `ran === 0` → `failed`, summary `no tests ran: <text>`. `job_finish`; if it raises `looks like`, finish again with `summary withheld: see cb job log <id>`. If finish fails on the connection, retry every 30 s until it succeeds or the job is no longer `running`.
- Tree kill: Windows `taskkill /pid <pid> /T /F`; elsewhere spawn with `detached: true` and `process.kill(-pid, 'SIGKILL')`.
- Cancel: on each `cb_jobs` notice and each beat, `select id from cb.jobs where id = any(<running ids>) and state = 'cancelled'` → kill that job's tree, run its `finally`, do not finish it.
- Log server (`node:http`): only `GET /jobs/<id>/log` with optional `?tail=<n>` (last n lines); the peer address (strip `::ffff:`) must be in `cfg.log.peers`, else 403 `this machine may not read job logs`; missing log → 404; any other path or method → 404.

- [ ] **Step 1: Write the failing tests** in `test/runner.test.ts`. Setup, once for the file (`freshDb()` truncates the recipes a runner published, so never call it after a runner starts): `freshDb()`, project `demo`, session `B1@mac`; in a temp dir, a bare repo `origin.git` and a work repo whose `main` branch holds `ok.mjs` (prints `ok`), `fail.mjs` (exits 3), `slow.mjs` (waits 60 s), `env.mjs` (prints `CB=` + whether `CB_DATABASE_URL`, `DATABASE_URL` or `RUNNER_MARKER` is set), `big.mjs` (writes 3 MB with no newline then exits 1), `lock.txt`; pushed to `origin.git` `main`. A second commit pushed only to `refs/pull/1/head`; a third commit never pushed. A `runner.json` with `git` = the bare repo path, `base` = `<tmp>/r`, `lockfile` `lock.txt`, `install` `["node","-e","console.log('installed')"]`, `slots: 2`, `log: { host: '127.0.0.1', port: <free port>, peers: ['127.0.0.1'] }`, recipes `ok`, `fail`, `slow` (timeout 3), `env`, `big`, `nocmd` (`["no-such-program-xyz"]`), `cleanup` (steps `slow.mjs`, timeout 2, `finally` `node -e "require('fs').writeFileSync('done.txt','1')"`), `pick` (param `files` pattern `^ok\.mjs$`, max 3, steps `node {files}`), `zero` (prints `ℹ pass 0` and `ℹ fail 0`, exits 0). Start the runner as a child: `node cli/runner.ts` with env `CB_RUNNER_CONFIG`, `CB_RUNNER_HOME=<tmp>/home`, `CB_DATABASE_URL=TEST_URL`, `RUNNER_MARKER=1`. Helper `await ended(id)` polls `cb.job_get` until the state is final (60 s cap). Tests:
  - `a passing job ends passed with its log and a message`: `ok` → `passed`, exit 0; `<home>/logs/<id>.log` contains `ok`; requester has a `job #<id>` message.
  - `a failing job ends failed with its exit code`: `fail` → `failed`, exit 3.
  - `the job env is clean`: `env` output has none of the three names.
  - `a sha nobody pushed, or only on a pull-request ref, is refused`: never-pushed → `error: push it first`; PR-ref-only → `error: push it first` too (the heads-only fetch never downloads it); a commit whose only branch `gone` was deleted on origin after a job ran at it (so the slot clone still holds the object) → `error: not on a branch of origin`.
  - `a job over its timeout is killed`: `slow` → `error: timed out after 1 min` within 20 s.
  - `finally runs after a timeout`: `cleanup` → `error: timed out…` and `<tmp>/r/demo-<slot>/done.txt` exists.
  - `a command that cannot start is an error and the runner goes on`: `nocmd` → `error: could not start no-such-program-xyz`; an `ok` queued after it → `passed`.
  - `huge output keeps the summary short`: `big` → `failed`, summary ≤ 1000 chars.
  - `the lockfile install runs once per slot`: two `ok` jobs in a row on the same slot → `installed` in the first log only.
  - `cancel stops a running job`: `slow`, wait for `running`, `job_cancel` as the requester → state stays `cancelled` and the `slow.mjs` process is gone (its pid, printed by `slow.mjs`, no longer exists) within 10 s.
  - `a restarted runner ends its running job and runs the queue`: `slow` running, kill the runner child (`SIGKILL`/taskkill), queue `ok`, start a new runner → the `slow` job is `error: runner restarted`, the requester has that message, `ok` → `passed`.
  - `a second runner refuses to start`: start another child with the same config → exits 1, stderr/stdout contains `already running`.
  - `the log server answers peers only`: `GET http://127.0.0.1:<port>/jobs/<id>/log?tail=1` → 200 with the last line; `/jobs/<id>/x` → 404; a runner config with `peers: []` → 403.
  - `bad parameters end the job before any git work`: `pick` with `files: ['ok.mjs','fail.mjs']` (allowed by SQL, refused by the recipe pattern) → `error: bad parameter files: fail.mjs`.
  - `a row written around job_add is refused`: insert into `cb.jobs` with raw SQL a row with sha `;rm`, another with recipe `ghost`, another with `params` `{"files":"ok.mjs"}` → each `error: bad job row`; the runner then passes an `ok` job.
  - `zero tests is not a pass`: `zero` → `failed`, summary starts `no tests ran`.
  - `an unreachable origin is an error, not a hang`: a second project whose `git` is a missing path → `error: could not fetch from origin`.
- [ ] **Step 2: Run** `CB_TEST_DB=claude_board_test_runner NODE_OPTIONS=--max-old-space-size=4096 node --test --test-concurrency=1 --test-force-exit test/runner.test.ts` → FAIL.
- [ ] **Step 3: Implement `cli/runner-job.ts`, then `cli/runner.ts`.**
- [ ] **Step 4: Run** → all pass; then re-run `test/jobs.test.ts` and `test/recipes.test.ts`.
- [ ] **Step 5: Commit** `feat(runner): the PC runner daemon (#3600)`

### Task 5: `cb run`, `cb jobs`, `cb job`, `cb runner`, help and prompts

**Files:**
- Create: `cli/jobs.ts`
- Modify: `cli/cb.ts` (pre-parse for `run`; `OPTIONS` gains `sha`, `card`, `wait`, `tail`; four thin `case`s), `cli/help.ts` (new group `RUN CHECKS ON THE PC` with `run`, `jobs`, `job`, `runner`), `prompts/roles/_common.md`, `prompts/roles/builder.md`, `prompts/roles/reviewer.md`, `docs/ops/maintain.md` (a "PC job runner" section: write `~/.claude-board/runner.json` from `docs/ops/runner.example.json`, start `cb runner` in a herdr pane on the PC, what each error means)
- Test: `test/jobs-cli.test.ts`

**Interfaces:**
- Consumes: Task 1 functions; `node cli/runner.ts` from Task 4.
- Produces (`cli/jobs.ts`):
  - `splitRunArgs(argv: string[], known: Set<string>): { rest: string[]; params: Record<string, string[]> }` — after `run`, every `--<name>` not in `known` is a parameter; the tokens after it up to the next `--x` flag are its values (`--files a b --wait` → `files: [a, b]`, `--wait` kept in `rest`). A value starting with `-` stays a value here (SQL refuses it with the parameter's name).
  - `runCmd(sql, o: { recipe, sha, card?, project, params, wait, actor }): Promise<{ out: string; json: unknown; code: number }>` — prints `job #<id> queued (<k> ahead)`; with `--wait`, waits for the end (LISTEN `cb_jobs` or a 3 s poll, at most 30 min) and prints the end message's text; `code` 0 for `passed`, 1 otherwise; past 30 min prints `still running: cb job <id>`. No recipe given, or an unknown one, → the error lists the project's recipes with their params (from `jobs_list`).
  - `jobsCmd`, `jobCmd` (`show`, `cancel`, `log`), `logCmd` (fetches `<log_url>/jobs/<id>/log[?tail=N]`; 403 → `this machine may not read job logs: they stay on the PC and the MacBook`; connection refused or no answer within 10 s (`AbortSignal.timeout(10_000)`) → `the runner on <name> is not answering`).
  - `cb runner` → `spawnSync(process.execPath, [<dir>/runner.ts], { stdio: 'inherit' })`, exit with its code.
- Prompt lines: `_common.md` replaces "Nothing heavy on the Mac … ask the lead, who knows where it can run." with `Heavy work (suites, type checks, builds, installs, DB tests) goes through cb run on the PC runner; never run it on the Mac. cb jobs shows the recipes.`; `builder.md` and `reviewer.md` name `cb run check` and `cb run test` where they talk about running tests.

- [ ] **Step 1: Write the failing tests** in `test/jobs-cli.test.ts` (spawn `node cli/cb.ts` like `test/help.test.ts`, `CB_ACTOR=B1@mac`, a session row for `B1@mac` in `demo`, recipes published through a `cb-runner/test` connection):
  - `splitRunArgs`: `['test','--sha','abc1234','--files','a','b','--wait','--app','claims-api']` with known `{sha, wait}` → `rest` `['test','--sha','abc1234','--wait']`, params `{ files:['a','b'], app:['claims-api'] }`.
  - `cb run queues and prints the job`: `cb run test --sha abc1234 --files tests/a.test.ts --project demo` → exit 0, `job #1 queued (0 ahead)`.
  - `cb run refuses flag- and path-shaped values by name`: `--files -r` and `--files ../x` → exit 1, stderr names `files`.
  - `cb run lists the recipes when the recipe is unknown`: `cb run ghost --sha abc1234 --project demo` → stderr lists `test` and `files`.
  - `cb run --wait prints the result`: a runner connection finishes the job `passed` 1 s after queueing → exit 0, output contains `passed`.
  - `cb job cancel and cb jobs`: queue, `cb jobs demo` lists `#<id>`, `cb job cancel <id>` → `cancelled`.
  - `cb job log reads from the runner`: a local `http.createServer` on `127.0.0.1` stands in for the runner (published as `log_url`) serving `/jobs/1/log` → output is the body; returning 403 → the `may not read` text.
  - `help.test.ts` and `squad-kit.test.ts` still pass (they check every `case` has help and every command a role file names exists).
- [ ] **Step 2: Run** `CB_TEST_DB=claude_board_test_runner NODE_OPTIONS=--max-old-space-size=4096 node --test --test-concurrency=1 --test-force-exit test/jobs-cli.test.ts` → FAIL.
- [ ] **Step 3: Implement `cli/jobs.ts`, the `cb.ts` cases, help entries, prompt and doc edits.**
- [ ] **Step 4: Run** `test/jobs-cli.test.ts`, `test/help.test.ts`, `test/squad-kit.test.ts`, `test/cli.test.ts` → all pass.
- [ ] **Step 5: Commit** `feat(runner): cb run, jobs, job and runner commands (#3600)`

### Task 6: Release check (controller, not a subagent)

- [ ] Full suite under `cb lock take db`; final whole-branch review on the most capable model.
- [ ] Write the PC `~/.claude-board/runner.json` from the example with the real Tailscale addresses of the PC and the MacBook; tell Ahmed on the board it is his file to edit.
- [ ] Ask Ahmed on the board (`cb ask`) for the merge-and-deploy go; then push main, deploy vps2 (schema applies on start), pull the PC, copy to the Mac.
- [ ] Start `cb runner` in a new herdr pane on the PC. From a Mac session bound to `ihop`: `cb run check --ws @ihop/claims-api --sha <pushed main sha>`, `cb run test --app claims-api --files <one test> --sha …`, `cb run itest --files <one integration test> --sha …`, and each of the other six recipes once (`kbtest` with `server/routes/async-ingest.db.test.ts`); expect a Windows Firewall prompt on the runner's first bind to the Tailscale address (Ahmed answers it); `cb run test --files ../x` and `--files -r` refused; each result arrives by itself; `cb job log <id> --tail 20` works from the Mac and is refused from vps2.
