# Several repos inside one project (squad piece 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A board project holds several repos: squad sessions, cards (one build part per repo) and runner jobs know which repo they work in, and a one-repo project works exactly as today.

**Architecture:** SQL owns the rules: the squad file gains `repos`, sessions and cards record their repo(s), a new `cb.task_parts` table carries a multi-repo card through build, review and merge one part per repo while the card's own stage is the least advanced part's. The supervisor and `cb squad up` plan per role and repo from the same squad file; the PC runner keys recipes, jobs and slot clones by project and repo. Everything without `repos` normalises to one repo named `main`.

**Tech Stack:** Node 24 + TypeScript (node type stripping, no tsc for cli), `postgres` client, plpgsql in `db/schema.sql`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-23-repos-in-project-design.md` (approved Q2393). Its "Edge cases" section binds every task.

## Global Constraints

- SQL in `db/schema.sql`, idempotent: `add column if not exists`, `drop function if exists … cascade` before every `create function` whose signature or body changes (follow the drop blocks near lines 246-255 and 3321-3337).
- A project's repos: `cb._repos_of(p)` = the squad's `repos` keys, else `{main}`. Home: the repo with `"home": true` (a single repo is home by default), else `main`. Multi-repo = more than one repo.
- A squad file, runner.json, session or card without repos behaves byte-for-byte as before this piece (names, prompts, folders, slot dirs, messages).
- Session names: home repo `<project>-B1@<m>` as today; other repos `<project>-<repo>-B1@<m>` (same for R, and any repo-bound letter). Owners stay `<project>-O-<area>@<m>`.
- A card never defaults to a repo in a multi-repo project. Repos lock from approval on (`cb fail <id> --to design` is the way back).
- Board text names repos, sessions, card ids and PR numbers only: no titles beyond what existing lines already show.
- Tests only on `claude_board_test*`. From `C:/w/repos`: `cb lock take db2` first, `cb lock release db2` after (even on failure), then
  `CB_TEST_DB=claude_board_test_repos NODE_OPTIONS=--max-old-space-size=4096 node --test --test-concurrency=1 --test-force-exit test/<file>.test.ts`.
  Run only the files the task names plus the existing files it touches. Never run the full suite (the controller does, once).
- Never touch the live board, the live runner, `~/.claude-board/runner.json`, or herdr agents. Never dispatch subagents.
- Commits: conventional, ending `(#3703)`, last two lines `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01VedgXTSz9j8Fqn7VTmyGUB`. Never bypass hooks, never push.
- `cli/help.ts` changes with the code that makes it false (`test/help.test.ts` pins it); every new flag is documented in the task that adds it.

## Review Focus

1. **Today's projects unchanged.** The ihop squad draft (no `repos`) saves, plans and launches exactly as before; a flat runner.json keeps slot dir `C:/r/ihop-1`. Pinned in Task 1 (squad_set output equal), Task 4 (wantList/launchFor equal), Task 5 (slot dir).
2. **A session bound before this deploy** (`sessions.repo` null) in a project that later gets `repos`: it is the home repo; it never claims another repo's card or part. Pinned in Task 2.
3. **A card closed or cancelled from the dashboard while parts are open:** its parts stop counting as holds, stalls and digest lines, or the supervisor would restore sessions forever. Pinned in Task 3.
4. **Two builders of different repos claiming the same two-part card:** neither ever gets the other's part (the second may get "nothing to claim" for one call while the card row is locked: accepted). Pinned in Task 2.
5. **A project merge (`cb.project_alias`) after the runner tables gain `repo`:** recipes and queued jobs move with their repo, and a moved queued job is still claimed. Pinned in Task 5.

---

### Task 1: Squad repos, session repo, card repos

**Files:**
- Modify: `db/schema.sql` (`cb.squad_set` ~4028, `cb.iam` ~1404, `cb.task_add` ~642, `cb.task_update` ~685, `cb.stage_set` ~3482, `cb.stage_pass` design branch ~3553, sessions/tasks columns ~3349)
- Modify: `cli/cb.ts` (OPTIONS: add `repo: { type: 'string' }`; `iam`, `add`, `bug`, `edit`, `stage`, `squad show`), `cli/help.ts` (iam, add, edit, stage, squad)
- Test: create `test/repos-squad.test.ts`

**Interfaces:**
- Produces (SQL): `cb.sessions.repo text`; `cb.tasks.repos text[]` (null = not named); `cb._repos_of(p text) returns text[]` (home first, then by name); `cb._home_repo(p text) returns text`; `cb._multi_repo(p text) returns boolean`; `cb._repo(a text) returns text` (the actor's latest session's repo, else its project's home repo, else `main`); `cb._check_repos(p text, r text[]) returns text[]` (validated, de-duplicated in given order).
- Produces (signatures): `cb.iam(..., model text default null, repo text default null)`; `cb.task_add(..., why text default null, repos jsonb default null)`; `cb.task_update` accepts field `repos` (JSON list of names); `cb.stage_set(id, stage, why, actor, repos jsonb default null)` (a JSON list, like task_add).
- Produces (saved squad with repos): `{machines: {k: {herdr, board}}, repos: {name: {home: bool, paths: {machine: path}}}, areas: [{name, repo}], roles: {builder: {count: {repo: n}, model, machine}, ...}, supervise?}`. Without `repos`: exactly today's saved shape.

- [ ] **Step 1: Write the failing tests** in `test/repos-squad.test.ts` (setup like `test/squad-stages.test.ts`: `freshDb`, `ensure_project`, `project_pipeline(...,'ahmed')`, sessions inserted directly). Use a QHS-like squad `QHS` = machines shaltoot (herdr null) + macbook (herdr `macbook`), repos `api` (home) and `dashboard` with absolute paths on both, areas `[{name:'api',repo:'api'},{name:'dashboard',repo:'dashboard'}]`, roles builder `{count:{api:2,dashboard:1}}`, reviewer `{count:{api:1,dashboard:1}}`, owner, qa `1`, lead `1`.
  - `squad_set without repos returns exactly today's shape` — the ihop draft (`machines.*.repo`, string areas, builder count 3) saves `deepEqual` to the object today's code returns (copy it from a run on the base commit into the test literal).
  - `squad_set with repos` — `QHS` saves; returned `repos.api.home === true`, `repos.dashboard.home === false`.
  - refusals, each `assert.rejects(..., /<text>/)`: a machine with `repo` while `repos` is set → `/machine shaltoot repo: with repos, each repo lists its own paths/`; two homes → `/exactly one repo is home/`; a repo path not absolute → `/repo api path on macbook must be an absolute path/`; a repo with no path on a machine a role of that repo runs on → `/repo dashboard has no path on macbook/`; area naming an unknown repo → `/area dashboard names repo web, which is not in repos/`; area as a plain string with repos → `/with repos, each area is \{"name", "repo"\}/`; builder count a number with repos → `/builder count must be a count per repo/`; builder count for repo `bot` with no reviewer count for `bot` → `/repo bot has builders but no reviewers/`; Mac sum over 8 → `/macbook would run 9 sessions; the cap is 8/`; repo name not a slug → `/repo Web must be a slug/`.
  - `iam --repo` — `cb.iam('mac','p1','qhs-dashboard-B1@mac','qhs', role=>'builder', repo=>'dashboard')` stores `repo`; `repo=>'web'` rejects `/repo web is not a repo of qhs: api, dashboard/`; in a project without repos `repo=>'main'` is accepted, anything else refused the same way.
  - `_repo defaults to the home repo` — a session with null repo in qhs reads `api`; in a project with no squad reads `main`.
  - `card repos` — `task_add(..., repos => '["dashboard","api"]')` stores `{dashboard,api}`; an unknown name rejects `/repo web is not a repo of qhs/`; `task_update(id, '{"repos":["api"]}')` changes it at design; at approval, build, review, merge or qa rejects `/#\d+ is at .*: repos lock once the design is passed; send it back with cb fail \d+ --to design/`.
  - `design pass needs repos in a multi-repo project` — a qhs card tagged `ui` (no area) at design, page set, owner passes → rejects `/name the repos first: cb edit \d+ --repo <repo,repo>/`; tagged `api,dashboard` with repos null → pass succeeds and the card's repos become `{api,dashboard}` (area order of the squad); a one-repo project's design pass leaves repos null.
  - `stage build needs a repo in a multi-repo project` — `cb.stage_set(id,'build','small','orch@pc')` on a repos-null qhs bug rejects `/give the repos: cb stage \d+ build --repo <repo> --why/`; with `repos => '["dashboard"]'` it moves to build with repos `{dashboard}`.
  - CLI (spawn `cb` as `test/squad-stages.test.ts` does for `cb pass`): `cb squad show qhs` prints `builder  api 2, dashboard 1 × sonnet on macbook` and `repos: api (home), dashboard`; `cb edit <id> --repo api,dashboard` sends `repos`; `cb add qhs "x" --repo api` stores it.
- [ ] **Step 2: Run** the file: every new test FAILS (unknown key `repos`, missing columns/params).
- [ ] **Step 3: Implement.** In `squad_set`: allow key `repos`; when present, machines take only `herdr` and `board`; validate repos (slug `^[a-z][a-z0-9-]{0,31}$`, only keys `home`/`paths`, path rule identical to today's machine `repo` rule), areas as objects, per-repo counts for builder and reviewer (1-8 each, keys known repos), Mac sum of all counts; every repo-bound role's machine has a path in each repo it counts; every project-wide role's machine has a home path. Save `home` on every repo. In `cb.iam` store `repo` (null allowed). `task_update` refuses `repos` when the card's stage is approval, build, review, merge or qa and the pipeline is on. `stage_pass` design branch: if repos null, take the repos of the card's labels that are squad areas (in squad area order); multi-repo and still none → refuse. `stage_set` build: in a multi-repo project require repos (given or already on the card) and store them. `cb add/bug --stage build --repo` passes repos through `task_add` to `stage_set`.
- [ ] **Step 4: Run** `test/repos-squad.test.ts`, `test/squad-stages.test.ts`, `test/squad-kit.test.ts`, `test/help.test.ts`, `test/cli.test.ts`: all pass.
- [ ] **Step 5: Commit** `feat(squad): a project's squad lists its repos; sessions and cards name theirs (#3703)`

### Task 2: Build parts: claim, pass, fail per repo

**Files:**
- Modify: `db/schema.sql` (new table and functions after the squad section; `cb._claimable` ~3661, `cb.task_claim` ~766, `cb.stage_pass` ~3534, `cb.stage_fail` ~3586, `cb._approval_answered` ~3627, `cb.stage_set` build branch)
- Modify: `cli/cb.ts` (`pass`, `fail` send `repo`), `cli/help.ts` (pass, fail)
- Test: create `test/repos-parts.test.ts`

**Interfaces:**
- Consumes: Task 1's `cb._repo`, `cb._multi_repo`, `cb.tasks.repos`.
- Produces: `cb.task_parts(task_id bigint references cb.tasks(id) on delete cascade, repo text not null, stage text not null check (stage in ('build','review','merge','merged')), status text not null default 'next' check (status in ('next','in_progress')), assignee text, crew jsonb not null default '{}', pr text, commit text, since timestamptz not null default now(), nudged_at timestamptz, primary key (task_id, repo))`. A card has parts iff `cardinality(repos) > 1` once it has entered build.
- Produces: `cb._parts_open(tid bigint) returns void` (on entering build: one part per repo at stage build; an existing part keeps pr and crew and goes to its `crew.build` with status next; a part whose repo left the list is deleted with a card note `part <repo> dropped: close its PR <pr>` carrying data `{"digest": true}`); `cb._parts_sync(tid bigint) returns void` (card stage := least advanced part, order build < review < merge < merged; all merged → card to qa unassigned; the card stays status `next` while it has parts at build or review: the parts carry their own status); `cb.stage_pass(id, summary, links, actor, repo text default null)`; `cb.stage_fail(id, why, to_stage, actor, repo text default null)`.
- Produces: `cb._repo_fits(t cb.tasks, a text) returns boolean` (the repo half of `_claimable` for build and review, defined in Step 3).
- Rule: a part is claimable only at the card's stage (build or review); merge and qa stay card-level roles (lead, qa).

- [ ] **Step 1: Write the failing tests** in `test/repos-parts.test.ts` (qhs squad from Task 1's test, pipeline on, sessions `qhs-B1@mac` builder repo api, `qhs-dashboard-B1@mac` builder repo dashboard, `qhs-R1@mac` reviewer api, `qhs-dashboard-R1@mac` reviewer dashboard, `orch@pc` lead, `qhs-Q1@mac` qa, an owner; a helper takes a card with repos `{api,dashboard}` through design and Approve):
  - `a two-repo card enters build with two parts` — rows `(api, build, next)` and `(dashboard, build, next)`; card stage build, assignee null. A one-repo card (`{dashboard}`) has no part rows.
  - `each builder claims its own repo's part` — `task_claim('qhs','qhs-B1@mac')` returns the card and sets part api `in_progress` held by `qhs-B1@mac`; `qhs-dashboard-B1@mac` claims the same card and gets part dashboard; a third api builder gets nothing. A null-repo builder session counts as api (home) and never gets the dashboard part.
  - `a one-repo card goes only to builders of its repo` — card `{dashboard}` at build: api builder gets nothing, dashboard builder claims it.
  - `the card leaves build when every part has its PR` — api passes `--pr https://github.com/o/api/pull/12`: card still at build, links `pr` and `pr:api` = that URL; dashboard passes `https://github.com/o/dash/pull/7`: card at review, links `pr:dashboard`, bare `pr` still api's (first in repos). A bare `#12` PR in a multi-repo project rejects `/give the full pull request URL: https:\/\/github.com\/<owner>\/<repo>\/pull\/<n>/`. Passing a part you do not hold rejects `/you hold no part of #\d+: claim it first \(cb next\)/`.
  - `review is per part` — the api reviewer claims and gets the api part only; its builder may not review it (`/you built it/`); api GO → part merge, card still review; dashboard reviewer NO-GO (`stage_fail` without `--to`) → only the dashboard part back to build held by `qhs-dashboard-B1@mac` status next; card stage build; api part keeps stage merge.
  - `merge is the lead's, per repo` — card at merge: `stage_pass(id, 'merged', '{"commit":"abc1234"}', 'orch@pc')` without repo rejects `/give the repo: --repo <repo> \(parts: api, dashboard\)/`; with repo api → part merged, card still merge; dashboard → card at qa, links `commit:api`, `commit:dashboard`, bare `commit` = api's.
  - `a QA fail names the repo` — card at qa held by qa: `stage_fail` without repo rejects `/name the repo that fails: cb fail \d+ --repo <repo> "<why>" \(parts: api, dashboard\)/`; with repo dashboard → dashboard part at build held by its builder, api stays merged, card stage build. After a new PR, review GO and merge, the card returns to qa and `pr:dashboard` is the new URL.
  - `--to design resets the card; re-approval reopens every part with its builder and PR` — reviewer fails `--to design`: card at design held by its designer, part assignees cleared; designer edits repos to `{api}` and passes; on Approve the api part is at build held by `qhs-B1@mac` with its PR kept, the dashboard row is gone and a card event says `part dashboard dropped: close its PR https://github.com/o/dash/pull/7`.
  - `one-repo cards work exactly as today` — repeat the core of `a card walks every stage` from `test/squad-stages.test.ts` in a project without repos: no part rows, same links.
- [ ] **Step 2: Run** the file: tests FAIL (no table, no parameters).
- [ ] **Step 3: Implement.** `_claimable` build/review branches add `cb._repo_fits(t, a)`: parts → a part at `t.stage`, status next, `assignee is null or = a`, repo `= cb._repo(a)`, and at review `a` is neither the part's `crew.build` nor the card's `crew.design`; no parts in a multi-repo project → `t.repos[1] = cb._repo(a)` (null repos → false); else true. `task_claim`: when the locked card has parts, set the actor's repo part `in_progress`/assignee and call `_parts_sync` instead of claiming the card. `stage_pass`/`stage_fail` at build/review/merge/qa with parts act on the part (found by assignee, or by `repo` for merge and qa), write the card's links (`pr:<repo>`, `commit:<repo>`, bare ones for `repos[1]`) through `_stage_move`'s data or a direct update with `cb.stage_ok` on, then `_parts_sync`. `--to design` clears part assignees and status. `_approval_answered` and `stage_set` build: cards with more than one repo move to build unassigned, then `_parts_open`.
- [ ] **Step 4: Run** `test/repos-parts.test.ts`, `test/repos-squad.test.ts`, `test/squad-stages.test.ts`, `test/help.test.ts`: all pass.
- [ ] **Step 5: Commit** `feat(squad): a card that touches several repos is built, reviewed and merged one part per repo (#3703)`

### Task 3: Parts in holds, stalls, resume and the digest

**Files:**
- Modify: `db/schema.sql` (`cb.resume` ~3965, `cb._takes_it` ~3932, `cb._finish_line` ~3919, `cb.stage_stalls_due` ~3687, `cb.digest` ~3751 groups 4 and 9 plus a new group 13, `cb.supervise_state` holds ~4350, `cb.supervise_mark` ~4376)
- Modify: `cli/cb.ts` (`cardBlock` prints the actor's part and the parts line)
- Test: create `test/repos-parts-views.test.ts`

**Interfaces:**
- Consumes: Task 2's `cb.task_parts`, `_parts_sync`.
- Produces: `cb._parts_words(tid bigint) returns text`, e.g. `build: api done (PR #12), dashboard building (qhs-dashboard-B1@mac)`: card stage, then per part in repos order `<repo> <words>` with words `merged` · `done (PR #n)` (part ahead of the card) · `building` / `in review` / `waits for the lead to merge` (held: `(<assignee>)`; unheld at build or review: `waits for a builder` / `waits for a reviewer`). `cb.resume` card objects gain `part` (`{repo, stage, pr}` of the actor's part, or null) and `parts` (the `_parts_words` line, or null). A part hold = part assignee set, stage not merged, card not done or cancelled.

- [ ] **Step 1: Write the failing tests** in `test/repos-parts-views.test.ts` (reuse Task 2's setup helper by copying it):
  - `resume lists a card by its part` — after `qhs-dashboard-B1@mac` claims its part, `cb.resume('qhs-dashboard-B1@mac')` has the card with `part.repo = 'dashboard'` and `parts` = `build: api waits for a builder, dashboard building (qhs-dashboard-B1@mac)`; `_finish_line` at merge for a parts card = `merge each repo's PR in the design's order, then cb pass <id> "<what merged>" --repo <repo> --commit <sha>`; `next_step(...).takes_it` at build = the parts line.
  - `part holders count as holding` — `supervise_state('qhs')` gives `holds = 1` for the part holder; `supervise_mark(holder, true)` returns false (run with `application_name` `cb-supervisor/test` as `test/supervise-state.test.ts` does).
  - `a closed card's parts hold nothing` — the dashboard closes the card (`task_move ... done` as Ahmed with `cb-web`, as the existing close tests do): holds 0, `resume` has no card, `stage_stalls_due` sends nothing for it.
  - `a quiet part holder is nudged, then freed` — backdate the part's `since` and the holder's events by 31 minutes: `stage_stalls_due()` sends one message to the holder (data `nudge`, `stall`, `repo: dashboard`) and sets `nudged_at`; backdate 91 minutes and `nudged_at` 61: the part is unheld, status next, a card note `freed from qhs-dashboard-B1@mac: no update for 1h 31m and the nudge went unanswered (part dashboard)` exists with data `stall`, and digest group 2 shows it.
  - `the digest shows parts` — at merge with api merged: the merge line is `#<id> reviewed: merge dashboard (PR #7), then cb pass <id> "<what merged>" --repo dashboard --commit <sha>`; a staged qhs card at build with null repos gives `#<id> has no repo: cb edit <id> --repo <repo,repo>` (group 13); a down session holding a part appears in group 9.
- [ ] **Step 2: Run** the file: tests FAIL.
- [ ] **Step 3: Implement** the words function, the resume/holds/mark unions, a second loop in `stage_stalls_due` over held parts (same 30/90/60-minute rules, `nudged_at` on the part instead of `cb.stage_nudges`, quiet since = greatest of part `since`, the holder's latest event, its session's `started_at`, the card's latest non-nudge event), digest groups 4, 9 and 13, and `cardBlock` lines `your part: <repo>` and the parts line.
- [ ] **Step 4: Run** `test/repos-parts-views.test.ts`, `test/repos-parts.test.ts`, `test/squad-stages.test.ts`, `test/squad-timers.test.ts`, `test/supervise-state.test.ts`: all pass.
- [ ] **Step 5: Commit** `feat(squad): parts show in resume and the digest, and count as holds (#3703)`

### Task 4: Squad launch and supervisor per repo

**Files:**
- Modify: `cli/squad-up.ts` (types, `wantList`, `launchFor`), `cli/supervise-plan.ts` (groups per role, area and repo), `cli/supervise.ts` (only if the `State` shape change needs it), `db/schema.sql` (`cb.supervise_state` waiting and sessions)
- Test: modify `test/squad-up.test.ts`, `test/supervise-plan.test.ts`, `test/supervise-state.test.ts`

**Interfaces:**
- Consumes: Task 1's saved squad shape and `cb._repo`; Task 2's parts.
- Produces (TS, `cli/squad-up.ts`): `Squad` gains `repos?: Record<string, { home: boolean; paths: Record<string, string> }>`, `areas: (string | { name: string; repo: string })[]`, role `count?: number | Record<string, number>`; `export function reposOf(squad: Squad): Record<string, { home: boolean; paths: Record<string, string> }>` (no `repos` → `{ main: { home: true, paths: <machine → machines[m].repo> } }`); `export const homeRepo = (squad: Squad) => string`; want items `{ name, role, area?, repo }`; `Launch` gains `repo: string`.
- Produces (SQL `supervise_state`): `waiting.builder` and `waiting.reviewer` become `Record<repo, number>` (a part counts under its repo when unheld at the card's stage; a card without parts under `repos[1]`, or the home repo in a one-repo project; a null-repos card in a multi-repo project counts nowhere); every session entry gains `repo` (`cb._repo(actor)`). `State.waiting` type follows.

- [ ] **Step 1: Write the failing tests.**
  - `test/squad-up.test.ts` `repos: one name per repo, folders from the repo paths` — `wantList('qhs', QHS)` gives `qhs-B1@macbook`, `qhs-B2@macbook` (repo api), `qhs-dashboard-B1@macbook`, `qhs-R1@macbook`, `qhs-dashboard-R1@macbook`, `qhs-O-api@shaltoot` (repo api), `qhs-O-dashboard@shaltoot` (repo dashboard), `qhs-Q1@macbook` (repo api); `launchFor` of `qhs-dashboard-B1@macbook` has `cwd` = the dashboard macbook path and prompt `cb iam qhs-dashboard-B1@macbook qhs --role builder --model sonnet --repo dashboard, then cb role builder, then cb next`; the qa and architect prompts end `, then cb next. Repos: api <path>, dashboard <path>` (that machine's paths).
  - `test/squad-up.test.ts` `no repos: names, folders and prompts exactly as before` — the ihop draft's `wantList` and every `launchFor` deepEqual a literal captured from the base commit.
  - `test/supervise-plan.test.ts` `starts per repo` — waiting `{builder: {api: 0, dashboard: 2}}`: starts only `qhs-dashboard-B1` (count 1), never an api builder; an idle api builder session does not cancel dashboard waiting work; close rules apply per repo group. Update the existing tests' `waiting.builder`/`reviewer` numbers to `{ main: n }`.
  - `test/supervise-state.test.ts` `waiting and sessions per repo` — a two-part card at build with the api part held: `waiting.builder` = `{api: 0, dashboard: 1}`; a one-repo dashboard card adds 1 to dashboard; sessions carry `repo`; a project without repos gives `{main: n}`.
- [ ] **Step 2: Run** the three files: new tests FAIL.
- [ ] **Step 3: Implement.** `wantList` loops repos for builder and reviewer (count map; a number with no `repos` = `main`), owners from areas (string area → home repo), project-wide roles at the home repo, name rule from Global Constraints. `launchFor` takes `cwd` from `reposOf(squad)[w.repo].paths[machine]`, adds ` --repo <repo>` to the iam part of the prompt only when `squad.repos` is set, and appends the repos line for architect and qa only when `squad.repos` is set. `planTick` groups by `role/area/repo`, reads `waiting[role][repo]` for builder and reviewer, and counts `mine` by repo for them. `cb squad up`'s output lines are unchanged except names.
- [ ] **Step 4: Run** `test/squad-up.test.ts`, `test/supervise-plan.test.ts`, `test/supervise-state.test.ts`, `test/supervise.test.ts`: all pass.
- [ ] **Step 5: Commit** `feat(supervisor): start and close squad sessions per repo, each in its repo's folder (#3703)`

### Task 5: PC runner per repo

**Files:**
- Modify: `cli/recipes.ts` (`loadConfig`, `published`, types), `cli/runner-job.ts` (~210-310: config lookup, slot dir, state file names), `cli/jobs.ts` (`runCmd`, `recipeLine`, `jobsCmd`), `cli/cb.ts` (`run` passes `repo`), `cli/help.ts` (run, jobs), `db/schema.sql` (`runner_recipes`, `jobs`, `job_add`, `jobs_list`, `runner_hello`, `job_claim`, `_job_tell`, `project_alias` ~446), `docs/ops/runner.example.json`
- Test: modify `test/runner.test.ts`, `test/jobs.test.ts`, `test/jobs-cli.test.ts`, the `project_alias` test file (grep `project_alias` under `test/`)

**Interfaces:**
- Consumes: Task 1's `cb._repo`.
- Produces (TS): `Repo = { git; lockfile; install; installTimeout; recipes }`; `Project = { base: string; repos: Record<string, Repo> }`. A flat project in runner.json loads as `repos.main`; a project with `repos` takes only keys `base` and `repos`, each repo the fields a flat project has minus `base`. `published()` rows gain `repo`.
- Produces (SQL): `cb.runner_recipes.repo text not null default 'main'`, primary key `(runner, project, repo, recipe)`; `cb.jobs.repo text not null default 'main'`; `cb.job_add(project, recipe, sha, params, task_id, actor, repo text default null)` (null → `cb._repo(actor)` when the actor has a session in the project, else the project's home repo).
- Slot dirs: repo `main` → `<base>/<project>-<slot>` (today's); any other → `<base>/<project>-<repo>-<slot>`; the lock and gitconfig state files follow the same stem.

- [ ] **Step 1: Write the failing tests.**
  - `test/runner.test.ts` `loadConfig: a project's repos` — a project with `repos: {api: {...}, dashboard: {...}}` loads both; a repos project with `git` at its top rejects `/projects.qhs: unknown key "git"/`; a flat project loads as `repos.main` with the same fields; `published()` gives `repo` on every row.
  - `test/runner.test.ts` `slot clones per repo` — a job for repo dashboard clones into `qhs-dashboard-1`; a flat project's job still uses `<project>-1`.
  - `test/jobs.test.ts` `jobs per repo` — `runner_hello` with recipes for `(qhs, api, test)` and `(qhs, dashboard, test)`; `job_add('qhs','test',sha, ... actor 'qhs-dashboard-B1@mac')` queues repo dashboard (session repo); explicit `repo => 'api'` queues api; `repo => 'bot'` rejects `/the runner has no repo bot for qhs: it has api, dashboard/`; `job_claim` gives the dashboard job only to a runner that published dashboard's `test`; the tell reads `job #<n> test (dashboard) at <sha7>: passed`; a repo `main` job's tell is unchanged.
  - `test/jobs-cli.test.ts` `cb jobs lists recipes per repo` — `recipes (api): test` and `recipes (dashboard): test` lines; a project with only `main` prints today's `recipes: ...` line; `cb run test --sha <sha> --repo dashboard` sends repo.
  - project_alias test: alias a project with a queued dashboard job and recipe into another: the recipe row keeps repo dashboard, the job is claimed.
- [ ] **Step 2: Run** the files: new tests FAIL.
- [ ] **Step 3: Implement.** Runner-job resolves `cfg.projects[j.project]?.repos[j.repo ?? 'main']` (unknown → the existing "not on this PC" error path with the repo named). `project_alias` moves recipes keyed by `(runner, repo, recipe)`. `runner.example.json` gains a commented second project in the repos shape (keep its first project as is).
- [ ] **Step 4: Run** `test/runner.test.ts`, `test/runner-finish.test.ts`, `test/jobs.test.ts`, `test/jobs-cli.test.ts`, the project_alias file, `test/help.test.ts`: all pass.
- [ ] **Step 5: Commit** `feat(runner): recipes, jobs and slot clones per repo of a project (#3703)`

### Task 6: Prompts and docs

**Files:**
- Modify: `prompts/roles/builder.md`, `reviewer.md`, `qa.md`, `lead.md`, `owner.md`, `architect.md`; `docs/ops/maintain.md` (squad file section); `cli/help.ts` `squad` entry
- Test: `test/squad-kit.test.ts` (role texts load), `test/help.test.ts`

- [ ] **Step 1: Write the failing test** in `test/squad-kit.test.ts` `role texts name the repo rules`: builder text contains `cb next gives you cards of your repo` and `for a card with parts, cb pass passes your part`; reviewer contains `you review your repo's part`; qa contains `cb fail <id> --repo <repo>`; lead contains `--repo <repo> --commit <sha>` and `cb stage <id> build --repo`; owner and architect contain `cb edit <id> --repo`.
- [ ] **Step 2: Run** it: FAILS.
- [ ] **Step 3: Write** those lines into the role files (one or two plain sentences each, the role's own voice), the `repos` key with the QHS example and the naming rule into `maintain.md`, and `repos` into the `squad` help entry.
- [ ] **Step 4: Run** `test/squad-kit.test.ts`, `test/help.test.ts`: pass.
- [ ] **Step 5: Commit** `docs(squad): role texts and the manual cover repos (#3703)`

### Release (controller, not a subagent)

Final whole-branch review and its fix wave; the full suite once under `cb lock take db`; a live check on a throwaway two-repo project (two local git repos, one card through both parts, `cb run --repo` on the PC runner) with Ahmed's go for the schema apply; `cb ask` for merge and deploy.
