# Squad Pipeline (piece 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cards in a pipeline project move design → Ahmed's approval → build → review → merge → QA on dev → done,
routed by board code to sessions by role, with versioned design pages, automatic stall handling and a digest for the
lead instead of per-event copies.

**Architecture:** Everything is SQL in `db/schema.sql`, in one new section at the end ("Squad pipeline (#3598)") plus
small hooks in existing functions (`task_claim`, `inbox`, `tasks_before`, `answer`, `pings_due`, `tasks_unblock`,
`task_add`, `iam`, `sessions_overview`). The CLI gets `cb page`, `cb pass`, `cb fail` and new flags; the server runs two
new timer functions next to `pings_due`; the web shows the stage, the page and a pipeline switch.

**Tech Stack:** Node 24 running `.ts` directly, Postgres (`postgres` package), Hono, React/Vite. Tests: `node --test`
against the test Postgres at 127.0.0.1:5434.

**Spec:** `docs/superpowers/specs/2026-11-22-squad-design.md` (approved, Q2319; calls accepted, Q2320). Card #3598.

## Global Constraints

- Rules live in SQL `cb.*` functions; server and CLI stay thin. Every function the web calls goes in `server/rpc.ts`.
- Schema is idempotent: `alter table ... add column if not exists`; every new function gets a
  `drop function if exists cb.<name> cascade;` line in the new section's drop block. Every body that takes unprefixed
  params uses `#variable_conflict use_variable`.
- Every `case` in `cli/cb.ts` needs an entry in `cli/help.ts` GROUPS (`test/help.test.ts` enforces it).
- Stages, exactly: `design`, `approval`, `build`, `review`, `merge`, `qa`. Roles, exactly: `lead`, `architect`,
  `owner`, `builder`, `reviewer`, `qa`, `investigator`.
- Investigation cards (type `research`) never get a stage: they belong to the investigator role, are never freed by
  the stall rules (they often wait on Ahmed running steps on air-gapped staging/production), and their page is the
  investigation log (spec: Investigations).
- Timings, exactly: nudge after **30 min** quiet; free the card after **90 min** quiet with the nudge unanswered, **only while its session is live**; a
  session that is down keeps its cards (Q2324: Ahmed restores it) and the digest names it; design waits **15 min** for an area owner; lead
  digest every **15 min**, at once when a new P0 appears.
- A project with `pipeline = false` behaves exactly as today: every new rule is gated on `cb._pipeline(project)`.
- Pages follow the card-text rule: `cb._sensitive` refuses tokens, credentials, ID numbers, emails, phone numbers.
- UI text is plain words, never stage codes: "Design", "Waiting for your approval", "Building", "In review",
  "Merging to dev", "Checking on dev against the design".
- Board repo rules (`CLAUDE.md`): work in a worktree branch, never on `main` in `C:\work\claude-board`; never run tests
  against the live board; on the PC take `cb lock take db2` before test runs and give each run
  `NODE_OPTIONS=--max-old-space-size=4096` and a timeout; merge only with Ahmed's go; schema before code on deploy.

**One test command** (replace the file):
`CB_TEST_DB=claude_board_test NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/<file>.test.ts`

## Review Focus

1. **Two sessions claim the same stage card at once:** exactly one gets it (`for update skip locked` must survive the
   new filter). Test in Task 7.
2. **Ahmed changes his approval answer after the card moved on:** the card must not move twice; the change becomes a
   digest line. Test in Task 5.
3. **The pipeline is switched off with staged cards in flight:** cards keep their stage but behave as normal cards
   (claim, done, cancel all work); `cb pass` explains the pipeline is off. Test in Task 6.
4. **A session re-binds (`cb iam` new name) while holding a card:** no session row carries the old name, so the
   card would sit forever; the digest names it with the command to reassign. Test in Task 9.
5. **A long, multi-line design page from Windows:** `cb page set` reads a file (`-f`) or stdin, never a long argument
   (cmd.exe cuts at 8,191 chars). Test in Task 2.

## Spec deviation to confirm with Ahmed

- **The 2-hour approval reminder is not a separate message.** The approval question already sits on Today and goes to
  Telegram once; the board has no way to re-send a question. The digest lists every design waiting for approval with
  its age. `ponytail:` add a Telegram re-send when approvals get lost.

---

### Task 1: Schema foundations and the project switch

**Files:**
- Modify: `db/schema.sql` (new section at the end, after the asks/telegram sections)
- Create: `test/squad-stages.test.ts`

**Interfaces:**
- Produces:
  - `cb.projects.pipeline boolean not null default false`
  - `cb.tasks.stage text` (check: null or one of the six stages), `cb.tasks.crew jsonb not null default '{}'`
    (keys `design`, `build`, `review`: actor names), `cb.tasks.stage_since timestamptz`,
    `cb.tasks.approved_version int`
  - `cb.sessions.role text` (check: null or one of the seven roles), `cb.sessions.area text`, `cb.sessions.model text`
  - `cb.questions.approval_for bigint references cb.tasks(id) on delete set null`
  - `cb.pages (id identity pk, project text not null references cb.projects(slug) on update cascade, task_id bigint
    unique references cb.tasks(id) on delete cascade, area text, body text not null, version int not null,
    updated_by text not null, updated_at timestamptz not null default now(), unique (project, area),
    check ((task_id is null) <> (area is null)))`
  - `cb.page_versions (page_id bigint references cb.pages(id) on delete cascade, version int, body text, updated_by
    text, updated_at timestamptz, primary key (page_id, version))`
  - `cb.stage_nudges (task_id bigint primary key references cb.tasks(id) on delete cascade, nudged_at timestamptz not null)`
  - `cb._pipeline(p text) returns boolean` (stable)
  - `cb._role(a text) returns text`: the role of the actor's most recently seen session; `'lead'` when that is null and
    the name is `orch` or `orch@*`
  - `cb._area(a text) returns text`: the area of the actor's most recently seen session
  - `cb.project_pipeline(project text, enabled boolean, actor text default null) returns boolean`: dashboard only
    (`cb.dashboard_only('Board')`), logs a note event `pipeline on|off for <project>`

- [ ] **Step 1: Write the failing test** `project_pipeline: only the dashboard switches it, and roles read from sessions`

```ts
const sql = await freshDb(); clients.push(sql);
await sql`select cb.ensure_project('demo')`;
const session = postgres(TEST_URL, { onnotice: () => {} }); clients.push(session);
await assert.rejects(() => session`select cb.project_pipeline('demo', true, 'W1@mac')`, /only Ahmed/);
assert.equal((await sql`select cb.project_pipeline('demo', true, 'ahmed') as r`)[0].r, true);
assert.equal((await sql`select cb._pipeline('demo') as r`)[0].r, true);
await sql`insert into cb.sessions (machine, pane, actor, project, role, area) values ('mac','p1','W1@mac','demo','builder',null), ('pc','p2','orch@pc','demo',null,null)`;
assert.equal((await sql`select cb._role('W1@mac') as r`)[0].r, 'builder');
assert.equal((await sql`select cb._role('orch@pc') as r`)[0].r, 'lead');
await sql`insert into cb.tasks (project, title) values ('demo', 'x')`;
await assert.rejects(() => sql`update cb.tasks set stage = 'coding'`, /stage/);
```

- [ ] **Step 2: Run it, expect FAIL** (`function cb.project_pipeline does not exist`)
- [ ] **Step 3: Add the section, columns, tables and the four functions above to `db/schema.sql`**
- [ ] **Step 4: Run it, expect PASS**
- [ ] **Step 5: Commit** `feat(squad): pipeline switch, stage and role columns, page tables (#3598)`

### Task 2: Design pages and area pages (`cb page`)

**Files:**
- Modify: `db/schema.sql` (squad section), `cli/cb.ts`, `cli/help.ts`, `server/rpc.ts`
- Create: `test/squad-pages.test.ts`

**Interfaces:**
- Consumes: `cb.pages`, `cb.page_versions` (Task 1)
- Produces:
  - `cb.page_set(body text, task text default null, area text default null, project text default null, actor text
    default null) returns int`: the page's version after the save. Exactly one of `task` / `area`; `area` needs
    `project`. Refuses an empty body and anything `cb._sensitive` flags (message: `that looks like %s; pages are on the
    board, so describe the code and where the value lives, never the value`). The same body as the current version
    saves nothing and returns the current version. Every real save copies the new version into `cb.page_versions` and
    logs a note on the card (task pages): `design page v<n>`.
  - `cb.page_get(task text default null, area text default null, project text default null, version int default null)
    returns jsonb`: `{project, task_id, area, version, body, updated_by, updated_at, approved_version, approved_body}`
    (`approved_*` null for area pages or before approval); null when no page.
  - CLI: `cb page show <task> | --area <name> [--project p]` prints the body with a header line
    `design page for #N, v3 (approved v2) · W3@mac · <time>`; `--approved` prints the approved version instead (what
    reviewer and QA compare against); `cb page set <task> | --area <name> -f <file>` and
    `-f -` for stdin. New options: `area` (string), `file` (string, short `f`).
  - Help entry `page` in the `work` group.

- [ ] **Step 1: Write the failing tests**
  - `page_set: versions every real save, ignores an identical one, refuses secrets`: v1 → `1`, same body → `1`,
    new body → `2`, `select count(*) from cb.page_versions` = 2, a body containing `password=Hunter2!x` rejects
    `/pages are on the board/`, task and area together reject `/one of/`.
  - `page_get: current, a given version, and the approved one`: after `update cb.tasks set approved_version = 1`,
    `page_get(task => '1')` has `version 2`, `approved_version 1`, `approved_body` = the v1 text;
    `page_get(task => '1', version => 1).body` = v1.
  - `cb page set -f reads a long multi-line file`: write 12,000 characters over 300 lines to a temp file, run
    `cb page set 1 -f <file>` through `spawnSync('node', ['cli/cb.ts', ...])` (env as `test/help.test.ts` builds it),
    then `page_get(task => '1').body` equals the file exactly.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement `cb.page_set`, `cb.page_get`, the `page` case and its help entry; add both to `RPC_FUNCTIONS`**
- [ ] **Step 4: Run `test/squad-pages.test.ts` and `test/help.test.ts`, expect PASS**
- [ ] **Step 5: Commit** `feat(squad): versioned design and area pages, cb page (#3598)`

### Task 3: Roles on sessions (`cb iam --role --area --model`)

**Files:**
- Modify: `db/schema.sql` (`cb.iam` at ~1338, `cb.sessions_overview` at ~1500), `cli/cb.ts` (`iam`, `sessions`
  cases, OPTIONS), `cli/help.ts` (`iam` entry)
- Test: `test/squad-stages.test.ts`

**Interfaces:**
- Produces:
  - `cb.iam(machine text, pane text, actor text, project text default null, role text default null, area text default
    null, model text default null) returns text`. A given role must be one of the seven (error lists them); null keeps
    the current value; `area` is stored through `cb.norm_tag`.
  - `sessions_overview` rows gain `role`, `area`, `model`.
  - CLI: `cb iam W1@macbook iris --role builder --area claims --model sonnet`; the confirmation line adds
    `as builder (area claims)`; `cb sessions` lines show the role. New options: `role`, `model` (strings).

- [ ] **Step 1: Write the failing test** `iam: stores role, area and model; rejects an unknown role; keeps them on a plain re-bind`
  (`cb.iam('mac','p1','W1@mac','demo', role => 'builder', area => 'Claims RI')` → `_role` = `builder`, `_area` =
  `claims-ri`; `role => 'boss'` rejects `/one of lead, architect, owner, builder, reviewer, qa, investigator/`; a second
  `cb.iam('mac','p1','W1@mac')` keeps `builder`).
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** (the drop line for `cb.iam` exists; only the signature and the upsert change)
- [ ] **Step 4: Run `test/squad-stages.test.ts` and `test/help.test.ts`, expect PASS**
- [ ] **Step 5: Commit** `feat(squad): roles, areas and models on sessions (#3598)`

### Task 4: Stage entry and the lead's restage

**Files:**
- Modify: `db/schema.sql` (`cb.task_add` ~598, squad section), `cli/cb.ts` (`add`, `bug`, new `stage`),
  `cli/help.ts`, `server/rpc.ts`
- Test: `test/squad-stages.test.ts`

**Interfaces:**
- Consumes: `_pipeline`, `_role` (Tasks 1, 3)
- Produces:
  - `cb.task_add(..., stage text default null, why text default null)` (two new trailing params). In a pipeline
    project: actor `github` → unstaged (PR tracking cards); type `research` → unstaged (investigations); `stage` null → `design`, status `next` unless the caller
    said `backlog`; `stage => 'build'` goes through the same check as `cb.stage_set` below. Outside a pipeline project
    `stage` is refused. `stage_since := now()` on entry.
  - `cb.stage_set(id text, stage text, why text, actor text default null) returns text`: lead only (`_role`), on an
    unclaimed card (no assignee, status `next` or `backlog`) in a pipeline project, `why` required (errors say which
    is missing). `stage => 'build'`: only from `design`, only type `bug` or `chore` (Q2315: small found work); logs a
    note `small work, skipped design: <why>` with data `{"small": true}`. `stage => 'none'` (Q2323: work with no
    code, e.g. ops or a data check): from any stage, clears the stage and logs `taken out of the pipeline: <why>` with
    data `{"unstaged": true}`; the card is then worked the old way. Sets the stage with `cb.stage_ok = on`.
  - `cb bug` in a pipeline project prints `#<id> starts at design; a small fix can skip it: cb stage <id> build --why
    "..."` instead of `cb edit --assignee`. `inbox.bugs` (triage) is unchanged.
  - CLI: `cb add`/`cb bug` gain `--stage build --why "<why>"`; new command `cb stage <id> build|none --why "<why>"`. New
    options: `stage`, `why`. Help entries: `stage` in the `work` group; `add` mentions `--stage`.

- [ ] **Step 1: Write the failing tests** (synthetic actors `O1@mac` owner area `claims`, `B1@mac` builder, `R1@mac`
  reviewer, `orch@pc` lead, `Q1@mac` qa, project `demo` with the pipeline on, set up in a shared `setup()` helper)
  - `new cards start at design; PR cards stay unstaged`: `task_add` → stage `design`, status `next`; with
    `status => 'backlog'` → stage `design`, status `backlog`; actor `github` → stage null.
  - `small found work goes to build only from the lead, with a reason`: builder `stage_set(.., 'build', ..)` rejects
    `/lead/`; lead without `why` rejects `/why/`; lead on type `feature` rejects `/bug or chore/`; lead on a claimed
    card rejects `/unclaimed/`; lead on a filed bug with a why → stage `build`, one note with
    `data ->> 'small' = 'true'`; `task_add(.., stage => 'build', why => 'one-line fix', type => 'bug', actor =>
    'orch@pc')` works the same; the lead's `stage_set(.., 'none', 'restart only')` on an unclaimed design card
    clears the stage with one note `data ->> 'unstaged' = 'true'`; a builder's rejects `/lead/`.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement the `task_add` change, `cb.stage_set`, the CLI and help**
- [ ] **Step 4: Run `test/squad-stages.test.ts` and `test/help.test.ts`, expect PASS**
- [ ] **Step 5: Commit** `feat(squad): cards start at design; the lead can send small fixes to build (#3598)`

### Task 5: `cb pass` / `cb fail` and approval through Ahmed's answer

**Files:**
- Modify: `db/schema.sql` (`cb.answer` ~936, `cb.ask` ~824 unchanged, squad section), `cli/cb.ts` (new `pass`,
  `fail`), `cli/help.ts`, `server/rpc.ts`
- Test: `test/squad-stages.test.ts`

**Interfaces:**
- Consumes: `_pipeline`, `_role`, `page_get`, `crew`, `approval_for`, `stage_set` (Tasks 1-4)
- Produces:
  - `cb.questions.page_version int` (new column): the page version the approval question showed.
  - `cb._stage_move(tid bigint, to_stage text, hold text, note text, data jsonb default '{}') returns void`:
    sets `cb.stage_ok = on` for the update, writes `stage`, `stage_since = now()`, `assignee = hold`, and status
    (`approval` → `review`; `done` → status `done`, stage null; else `next`), deletes the card's `cb.stage_nudges` row;
    the history trigger logs the note with `data || {"stage": {"from", "to"}}`.
  - `cb.stage_pass(id text, summary text, links jsonb default '{}', actor text default null) returns text` (the new
    stage, or `done`). Refused with `pipeline is off for <project>` when it is. Legal passes:

    | From | Who (`_role`) | Requires | To | Also |
    |---|---|---|---|---|
    | design | owner / architect, holding it | a page exists | approval | posts the approval question; `crew.design = actor` |
    | build | builder, holding it | `links.pr` given or on the card | review | `crew.build = actor` |
    | review | reviewer, holding it, not `crew.build` / `crew.design` | — | merge | `crew.review = actor` |
    | merge | lead, holding it | `links.commit` | qa | — |
    | qa | qa, holding it, not `crew.build` | — | done | — |

    `approval` cannot be passed by a session (error: `waiting for Ahmed's answer on Q<n>`). Links merge into the card.
  - `cb.stage_fail(id text, why text, to_stage text default null, actor text default null) returns text`:
    - from `review` or `qa` by the holder: `to_stage` null → `build` held for `crew.build`; `'design'` → `design`
      held for `crew.design`;
    - from `approval` by `crew.design` (the designer withdraws to fix the page): → `design` held for the designer,
      the approval question withdrawn (`cb.withdraw`).
    - Anything else refused.
  - The approval question: `cb.ask(project, body => 'Approve the design for #<id> "<title>"?', options =>
    [{label: 'Approve', description: 'it goes to build'}, {label: 'Changes needed', description: 'back to <designer>
    with your note'}], task_id, context => <the page body, then "v<n>, written by <designer>">, actor => 'board')`,
    then `update cb.questions set approval_for = <tid>, page_version = <n>`.
  - **Only Ahmed approves:** in `cb.answer`, a question with `approval_for` set refuses any answer unless
    `cb.ahmed_like(actor)` and `application_name = 'cb-web'` (`only Ahmed approves designs, from the board`).
  - **The page is frozen while it waits:** `cb.page_set` on a card at `approval` raises `#<id> waits for Ahmed's
    approval of v<n>: to change the page, take it back with cb fail <id> "<why>"`.
  - `cb._approval_answered(qid bigint) returns void`, called at the end of both answer paths in `cb.answer`: when the
    card is still at `approval`: `Approve` (via `cb._picked`) → `build`, unassigned, `approved_version =
    questions.page_version`; `Changes needed` → `design` held for `crew.design`, note = the answer text. Then the
    question is marked delivered (`delivered_to = 'board'`). When the card has moved on: a note on the card
    `approval answer changed to "<answer>" after the card moved on` with data `{"digest": true}`, card untouched.
  - CLI: `cb pass <id> "<summary>" [--pr <url>] [--commit <sha>]` prints `#<id> → <plain stage words>`;
    `cb fail <id> "<why>" [--to design]`. `--to` already exists. Help entries `pass`, `fail` in the `work` group.

- [ ] **Step 1: Write the failing tests** (the Task 4 `setup()`; claim by raw `update ... set status =
  'in_progress', assignee = '<actor>'`, since claiming is Task 7)
  - `a card walks every stage`: owner `stage_pass` without a page rejects `/page/`; with a page → `approval`, status
    `review`, one question with `approval_for = 1`, `page_version = 1`; `cb.answer('<q>', 'Approve', 'ahmed')` →
    stage `build`, unassigned, `approved_version = 1`, question `delivered`; builder pass without a PR rejects
    `/--pr/`, with one → `review`; reviewer pass → `merge`; lead pass without `--commit` rejects, with it → `qa`;
    qa pass → status `done`, stage null; `crew` = `{design: O1@mac, build: B1@mac, review: R1@mac}`.
  - `fail returns the card to the same builder or designer`: review fail → `build`, status `next`, assignee
    `B1@mac`; qa fail `to_stage => 'design'` → `design`, assignee `O1@mac`; "Changes needed" → `design`, held for
    `O1@mac`; the designer's fail at `approval` → `design`, question `withdrawn`.
  - `only Ahmed approves, and only what he saw`: a session connection answering the approval question as `R1@mac`
    rejects `/only Ahmed approves/` and the card stays at `approval`; `page_set` on the waiting card rejects
    `/waits for Ahmed's approval of v1/`.
  - `the wrong role and the builder reviewing are refused`: builder passing a design card rejects
    `/owner or architect/`; `B1@mac` with role reviewer passing its own built card rejects `/built it/`;
    `stage_pass` at approval rejects `/waiting for Ahmed/`.
  - `a changed approval answer never moves the card twice` (Review Focus 2): approve, builder claims, then
    `cb.answer('<q>', 'Changes needed', 'ahmed')` from the dashboard connection → card still `build` held by
    `B1@mac`, one note with `data ? 'digest'`.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement the functions, the `answer` and `page_set` hooks, the CLI cases and help**
- [ ] **Step 4: Run `test/squad-stages.test.ts`, `test/squad-pages.test.ts`, `test/help.test.ts`, and the existing
  test file(s) that call `cb.answer` (`grep -l "cb.answer(" test/*.ts`), expect PASS**
- [ ] **Step 5: Commit** `feat(squad): cb pass/fail, approval only through Ahmed's answer (#3598)`

### Task 6: The guard: a staged card leaves the pipeline only through Ahmed or the lead

**Files:**
- Modify: `db/schema.sql` (`cb.tasks_before` ~480)
- Test: `test/squad-stages.test.ts`

**Interfaces:**
- Consumes: `_pipeline`, `_role`, `cb.stage_ok` (Tasks 1, 5)
- Produces: in `cb.tasks_before`, for an update of a card with a stage in a pipeline project, without
  `cb.stage_ok = on`:
  - status set to `done` or `cancelled`: allowed only from the dashboard (`application_name = 'cb-web'`) or a lead
    (`_role`) with a non-empty `cb.note`; then `stage := null`. Otherwise raise `#<id> is at <stage>: finish it with cb
    pass <id> or cb fail <id> "<why>" (only Ahmed, or the lead with a note, closes it outside the pipeline)`.
  - `project` changed: allowed only from the dashboard; otherwise raise `#<id> is at <stage>: a staged card stays in
    its project (Ahmed can move it from the board)`.
  - Other status moves (blocked ↔ in_progress, claims, holds) are untouched.

- [ ] **Step 1: Write the failing tests**
  - `done and cancel outside the pipeline`: a session's `task_done` on a staged card rejects `/is at build/`; the
    lead's `task_move(..., 'cancelled', 'dup of #9', 'orch@pc')` works and clears the stage; the dashboard's works.
  - `a staged card cannot leave by a project move`: a session's `task_update(.., '{"project":"other"}', ..)` rejects
    `/stays in its project/`; the same from the dashboard works.
  - `pipeline off: staged cards behave as normal cards` (Review Focus 3): switch off; a session's `task_done` works;
    `stage_pass` rejects `/pipeline is off/`; a new card has no stage.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement the guard**
- [ ] **Step 4: Run `test/squad-stages.test.ts` and `test/cli.test.ts`, expect PASS**
- [ ] **Step 5: Commit** `feat(squad): staged cards close or move only through Ahmed or the lead (#3598)`

### Task 7: Role-aware claiming and new-work pushes

**Files:**
- Modify: `db/schema.sql` (`cb.task_claim` ~710, `cb.inbox` `next_work` ~1423, squad section)
- Test: `test/squad-stages.test.ts`

**Interfaces:**
- Consumes: `_pipeline`, `_role`, `_area`, `crew`, `stage_since` (Tasks 1-6)
- Produces: `cb._claimable(t cb.tasks, a text) returns boolean` (stable):
  - not `_pipeline(t.project)` → true;
  - unstaged card: type `research` → `investigator` (or `t.assignee = a`); any other → `_role(a)` is null or `lead`,
    or `t.assignee = a` (the lead handed it out);
  - staged card: the role must match the stage below; `t.assignee = a` (a hold) only skips the area and 15-minute
    checks, so a lead assigning a design card to a builder never lets the builder claim it;
  - `design` → owner whose `_area(a)` is in `t.labels`; or architect / owner without an area when no live (seen in 10
    min) owner session has an area in `t.labels`, or `t.stage_since < now() - interval '15 minutes'`;
  - `build` → builder; `review` → reviewer not in `crew.build`/`crew.design`; `merge` → lead; `qa` → qa not
    `crew.build`; `approval` → false.
  - `cb.task_claim` adds `and cb._claimable(t, a)` and orders area matches first right after P0
    (`(cb._area(a) = any(t.labels)) desc`); `inbox.next_work` adds `and cb._claimable(t, me)` and skips unassigned bugs only when
    they have no stage (a staged bug is routed by its stage like any card; triage still tells the lead).

- [ ] **Step 1: Write the failing tests**
  - `next gives each role only its stage`: one card per stage; each role's `task_claim` returns only its card;
    a roleless session gets only unstaged cards; the lead gets the merge card; an investigator gets the
    `research` card and nothing else; a builder the lead assigned a design card to gets nothing.
  - `design goes to the area owner first, an architect after 15 minutes`: card tagged `claims`, live owner area
    `claims` and an architect; the architect's claim returns nothing; `update cb.tasks set stage_since = now() -
    interval '16 minutes'` → the architect gets it.
  - `two sessions claiming at once get one card each or nothing` (Review Focus 1): one build card, two builders
    claim concurrently (`Promise.all` over two `postgres(TEST_URL)` connections); exactly one returns a row.
  - `the push of new work reaches only sessions that can claim it`: a new build card shows in the builder's
    `cb.inbox(...)->'next_work'` and not in the reviewer's.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement `_claimable` and the two hooks**
- [ ] **Step 4: Run `test/squad-stages.test.ts`, `test/relay.test.ts`, `test/cli.test.ts`, expect PASS** (the last two
  pin today's claiming and inbox for non-pipeline projects)
- [ ] **Step 5: Commit** `feat(squad): sessions claim only their stage, area owners first (#3598)`

### Task 8: Stalls and holds

**Files:**
- Modify: `db/schema.sql` (squad section), `server/main.ts` (the `lead()` interval, ~line 412)
- Create: `test/squad-timers.test.ts`

**Interfaces:**
- Consumes: `cb.stage_nudges`, `_stage_move` (Tasks 1, 5)
- Produces: `cb.stage_stalls_due() returns int` (messages sent plus cards released). For staged cards in pipeline
  projects, `stage <> 'approval'`, with an assignee (unstaged cards, including investigations, are never touched):
  - quiet since = greatest(`updated_at`, the card's last event without `data ? 'nudge'`, the holder's last event
    anywhere);
  - only while the holder's session is live (seen within 10 min); a session that is down keeps its cards and
    holds (Q2324);
  - status `in_progress`, quiet ≥ 90 min, nudge row exists and is newer than "quiet since" → release;
  - status `in_progress`, quiet ≥ 30 min, no nudge row newer than "quiet since" → message from `board` to the holder
    (`data {"to", "nudge": true, "stall": true}`): `#<id> "<title>" has had no update for <h>h <m>m at <stage words>.
    Say where it stands (cb log <id> "...") or it goes back to the queue in an hour.`; upsert the nudge row;
  - status `next` (a hold) whose live holder is quiet ≥ 90 min → release.
  - release = assignee null, status `next`, rank at the head of Next (`min(rank) - 1024`), note
    `freed from <holder>: <why>` with data `{"stall": true}`, message to the holder `#<id> went back to the queue: <why>`.
  - `server/main.ts`: the same 60 s interval also runs `select cb.stage_stalls_due()`, logging errors as `stalls: ...`.

- [ ] **Step 1: Write the failing tests** (age rows the way `test/pings.test.ts` does with an `age(mins)` helper)
  - `a quiet card is nudged at 30 minutes and freed at 90 if nobody answers`: 20 min → 0; 31 min → one message to
    `B1@mac` matching `/no update for 0h 31m at Building/`; again → 0; aged 91 min after the nudge → card `next`,
    unassigned, one `stall` note.
  - `work elsewhere is not quiet`: the holder logs on another card at minute 40 → no release at 91.
  - `a session that is down keeps its cards` (Q2324): `last_seen = now() - interval '3 hours'`, card quiet 3 h →
    no nudge, still assigned, hold kept.
  - `approval, investigation and non-pipeline cards are never touched`: a `research` card held 3 h with no events
    gets no nudge and stays assigned.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement `cb.stage_stalls_due` and the interval line**
- [ ] **Step 4: Run `test/squad-timers.test.ts` and `test/pings.test.ts`, expect PASS**
- [ ] **Step 5: Commit** `feat(squad): nudge quiet cards, free stalled cards and holds (#3598)`

### Task 9: The lead's digest, and the per-event copies it replaces

**Files:**
- Modify: `db/schema.sql` (squad section; `cb.inbox` `answer_copies` ~1379; `cb.pings_due` ~1615;
  `cb.tasks_unblock` ~2307), `server/main.ts`, `server/rpc.ts`
- Test: `test/squad-timers.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `cb.digest(project text, since timestamptz default now() - interval '15 minutes') returns jsonb`: an array of
    plain lines, P0 first, at most 20, each ending with the command that acts on it:
    1. `Stages: design N · waiting for Ahmed N · build N · review N · merge N · QA on dev N` (always first)
    2. per card freed since `since`: `#id freed from <holder> (<why>): cb session <holder>`
    3. `N designs wait for Ahmed's approval, oldest <h>h (#id)` (covers the spec's approval reminder)
    4. per merge-stage card: `#id reviewed: merge it, then cb pass <id> --commit <sha>`
    5. per answered, undelivered question asked by a lead, or whose asker's relay is gone 10 min:
       `Q<n> answered for <asker> (<why>): cb pending`
    6. per design card with no live owner for its tags: `#id has no area owner (tags: ...): an architect takes it
       after 15 min, or cb tag <id> <area>`
    7. per note since `since` with `data ? 'small'`, `data ? 'unstaged'` or `data ? 'digest'`: `#id <the note>: cb show <id>`
    8. per unstaged card in Next with no assignee: `#id is not staged: cb edit <id> --assignee <session>`
    9. per session down for 10 min or more that holds cards, and per card held by a name with no session row (a
       re-bound pane): `<holder> is down and holds #id, #id: restore it, or cb edit <id> --assignee <session>`
    10. per live session whose `model` doesn't match `cb._role_model(role)`: `<session> is a <role> on <model>; the
       role runs <model>: restart it with --model <model>`. `cb._role_model(role text) returns text`: `sonnet` for
       builder and qa, `opus` for every other role (spec: Models per role). `ponytail:` fixed defaults until piece 2
       adds the per-project map.
  - `cb.digests_due() returns int`: for each pipeline project with a lead session seen in the last day: when 15 min
    have passed since the last digest (kept in `cb.settings` under `digest:<project>` as `{"at"}`) or a P0 card was
    created in the project since then, send `cb.digest(project, last_at)` as one message from `board` to each lead
    (`data {"to", "digest": true}`), summary `Digest for <project>:` plus the lines; record `at`. Only line 1 = nothing
    to say: send nothing, but record `at`.
  - Copies off for pipeline projects: `inbox.answer_copies` adds `and not cb._pipeline(proj)`; `pings_due` skips the
    orchestrator copy for cards with a stage; `tasks_unblock` adds `and not cb._pipeline(f.project)` to its message.
    Bug triage (`inbox.bugs`) is unchanged.
  - `server/main.ts`: the 60 s interval also runs `select cb.digests_due()` (`digest: ...` on error). `digest` goes in
    `RPC_FUNCTIONS` (the web shows it in Task 10).

- [ ] **Step 1: Write the failing tests**
  - `the digest names what needs the lead, each with its command`: one card per stage, one freed card, one approval
    waiting 3 h, one small-work note, one unstaged card; `cb.digest('demo')` first line matches `/^Stages: design 1/`
    and the others match `/freed from .*cb session/`, `/wait for Ahmed's approval, oldest 3h/`, `/merge it, then cb
    pass/`, `/cb edit \d+ --assignee/`; a card held by `W1@mac` after its pane re-bound as `W9@mac` gives
    `/W1@mac is down and holds #\d+/` (Review Focus 4).
  - `digests go every 15 minutes, at once on a P0, and never empty`: first call sends 1 message to `orch@pc`;
    immediately again → 0; a new P0 card → 1; `settings.at` aged 16 min with nothing new but the stage line → 0.
  - `pipeline projects stop sending the lead per-event copies`: an answered worker question gives no
    `answer_copies` for `orch@pc` in a pipeline project and still gives one in a non-pipeline project; a pinged staged
    card's `pings_due` goes to the holder only.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement `cb.digest`, `cb.digests_due`, the three copy changes and the interval line**
- [ ] **Step 4: Run `test/squad-timers.test.ts`, `test/pings.test.ts`, `test/relay.test.ts`, `test/tick.test.ts`,
  expect PASS**
- [ ] **Step 5: Commit** `feat(squad): lead digest replaces per-event copies in pipeline projects (#3598)`

### Task 10: Agent-native output: `cb resume` and next-step lines

**Files:**
- Modify: `db/schema.sql` (squad section), `cli/cb.ts` (new `resume`; `pass`, `fail`, `stage`, `next`, `start`
  output), `cli/help.ts`, `server/rpc.ts`
- Test: `test/squad-stages.test.ts`, `test/help.test.ts`

**Interfaces:**
- Consumes: `_role`, `_area`, `page_get`, `stage_pass` requirements (Tasks 1-5)
- Produces:
  - `cb._stage_words(stage text) returns text`: the exact plain words from Global Constraints (`design` → "Design",
    `approval` → "Waiting for your approval", `build` → "Building", `review` → "In review", `merge` → "Merging to
    dev", `qa` → "Checking on dev against the design"; null → "Not staged"). Tasks 5, 8 and 10's UI use the same
    words (the UI keeps its own copy in `StageChip`; a test pins both lists equal by reading `web/src/components/Chips.tsx`).
  - `cb._finish_line(t cb.tasks) returns text`: the command that finishes the card's stage for its holder:
    `design` → `cb page set <id> -f page.md, then cb pass <id> "<summary>"`; `build` → `cb pass <id> "<summary>"
    --pr <url>`; `review` → `cb pass <id> "<verdict>" or cb fail <id> "<what is wrong>"`; `merge` → `merge it, then cb
    pass <id> --commit <sha>`; `qa` → `cb pass <id> "<checked on dev>" or cb fail <id> "<what fails>"`; unstaged →
    `cb done <id> "<summary>"`; `approval` → `waiting for Ahmed (Q<n>)`.
  - `cb.resume(actor text default null) returns jsonb`: `{actor, role, area, model, project, cards: [{id, title,
    stage, stage_words, status, finish, page: {version, body} | null, notes: [last 5 {at, actor, summary}],
    questions: [open questions on the card {id, body}]}]}`. `page` is the approved version for builder, reviewer and
    qa when one exists, else the current one. Cards = open cards assigned to the actor, newest activity first.
  - CLI `cb resume [--json]`: a compact text block per card: line, `stage: <words>`, `finish with: <finish line>`,
    the page body (indented), notes, open questions. `cb start` adds one line: `after a compaction or restart: cb
    resume`.
  - `cb pass`, `cb fail`, `cb stage` print `#<id> → <words>; <who takes it now>. You: cb next` (who: "an owner or
    architect", "Ahmed", "a builder", "a reviewer", "the lead", "QA", or the held session's name).
  - `cb next` for a staged card prints the card, its page (approved version for builder/reviewer/qa) and
    `finish with: <finish line>`.
  - Help entry `resume` in the START A SESSION group.

- [ ] **Step 1: Write the failing tests**
  - `resume gives back each card with its stage, finish line, page and notes`: builder holding a build card with an
    approved v1 and a newer v2 → `cards[0].stage_words` = "Building", `finish` matches `/cb pass \d+ .*--pr/`,
    `page.version` = 1, `notes` has the last note.
  - `stage words are the same in SQL and in the UI chip`: read `web/src/components/Chips.tsx`, find each of the six
    phrases; compare to `cb._stage_words` for every stage.
  - CLI (spawnSync as `test/help.test.ts` does): `cb pass` output matches `/→ In review; a reviewer takes it\. You:
    cb next/`; `cb resume` output contains `finish with:`; `cb start` output contains `cb resume`.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement the functions, the `resume` case, the output changes and the help entry**
- [ ] **Step 4: Run `test/squad-stages.test.ts`, `test/help.test.ts`, `test/cli.test.ts`, expect PASS**
- [ ] **Step 5: Commit** `feat(squad): cb resume and next-step lines for agents (#3598)`

### Task 11: Board UI: stage chip, approval filter, design page, pipeline switch

**Files:**
- Modify: `web/src/lib/api.ts` (`Task` gains `stage`, `crew`, `approved_version`; `Project` gains `pipeline`),
  `web/src/components/Chips.tsx` (new `StageChip`), `web/src/components/TaskCard.tsx`,
  `web/src/components/TaskPanel.tsx`, `web/src/views/Board.tsx`, `server/queries.ts` (`projects` returns `pipeline`)
- Test: `test/server.test.ts` (one API test); typecheck with `pnpm -s build`

**Interfaces:**
- Consumes: `page_get`, `project_pipeline`, `digest` over `/api/rpc` (Tasks 1, 2, 9)
- Produces:
  - `StageChip({ stage })` with the exact words from Global Constraints; on `TaskCard` next to the type chip; amber
    (`text-lamp`, the existing "holding on a question" colour) for "Waiting for your approval".
  - Board header: a "Waiting for your approval" filter (cards with `stage === 'approval'`), and for the selected
    project a "Squad pipeline" checkbox calling `project_pipeline`.
  - `TaskPanel`: a "Design page" section under the body, rendered with the existing `Md` component, showing
    `v<n>` and, when `approved_version` differs, "changed since you approved v<k>" with a toggle to show the approved
    version. `ponytail:` no diff view; add one if Ahmed asks. Ahmed can edit the page in place (an Edit button
    calling `page_set` from the dashboard): he corrects investigation findings himself ("all the findings above are
    wrong"), and the session re-reads the page.
  - A "Digest" line on the Sessions view for a pipeline project, from `digest`. `ponytail:` read-only.

- [ ] **Step 1: Write the failing test** in `test/server.test.ts`:
  `GET /api/projects includes pipeline, GET /api/tasks includes stage and crew` (signed-in admin, as the file's
  other tests do).
- [ ] **Step 2: Run it, expect FAIL**
- [ ] **Step 3: Implement the query change and the four UI changes**
- [ ] **Step 4: Run `test/server.test.ts`, expect PASS; run `NODE_OPTIONS=--max-old-space-size=6144 pnpm -s build`,
  expect no type errors**
- [ ] **Step 5: Check it by eye** with the `ui` design rules of the board (plain words, theme tokens): start the
  board locally against the test DB, open a pipeline project, confirm the chip, the filter, the page and the switch.
- [ ] **Step 6: Commit** `feat(squad): stage chips, approval filter, design page, pipeline switch on the board (#3598)`

### Task 12: Release check

**Files:** none new.

- [ ] **Step 1:** `cb lock take db`, then the full suite from a clean checkout of the branch head:
  `CB_TEST_DB=claude_board_test NODE_OPTIONS=--max-old-space-size=4096 timeout 600 pnpm -s test`; expect 0 failures.
  `cb lock release db`.
- [ ] **Step 2:** A fresh review of the whole branch diff (a different session or the final reviewer subagent).
- [ ] **Step 3:** `cb ask claude-board` for Ahmed's go to merge and deploy, with the test counts and the spec
  deviation above. Schema goes live before the code (`maintain.md#upgrade`).
- [ ] **Step 4:** After his go: `git merge --ff-only`, deploy, then `cb done 3598 "<summary>" --commit <sha>`.
