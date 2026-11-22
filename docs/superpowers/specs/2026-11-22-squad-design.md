# Squad: a role pipeline for Claude Code sessions on Claude Board

Card #3594 · 2026-11-22 · status: approved by Ahmed (Q2319); build cards #3598-#3601

## Why

Ahmed runs about 8 Claude Code sessions on the MacBook and an orchestrator on the Windows PC, coordinated through
Claude Board. It is slow and hard to trust. The causes, all four agreed by Ahmed (Q2307):

1. **Card-only context.** A worker gets a card and nothing else: no map of the system, no owner who knows the module,
   no design check. Implementations are short-sighted.
2. **The orchestrator is the event sink.** Every board event lands in one session's context. It compacts, loses
   priorities, and needs 30-minute reminders and "not moving for 1 h" pings to keep work moving.
3. **Judgment left undone.** Stalls, scaling up/down and specialization are calls left to the drowning orchestrator,
   so they never get made.
4. **No allowed-commands list.** Workers stop on commands nobody allowed up front, and the stop goes to the orchestrator.

## Goals

- Every task follows Ahmed's process (Q2306): research the code and context, ask Ahmed to clarify, write a short design
  page, Ahmed approves it, it stays current while the work happens, and "done" is checked against it.
- Coordination (stage handoffs, stalls, queue counts, starting/closing sessions) lives in board code and a supervisor
  script, not in an LLM's context (Q2308).
- Long-lived **area owners** (business or technical) plus **stage roles**: architect, builder, reviewer, QA (Q2309).
- Builders run Sonnet; architects, area owners and reviewers run Opus.
- Sessions live on the MacBook (fast internet, light CPU). Heavy commands run on the PC (strong CPU, slow internet).
- One command starts a squad on any of Ahmed's projects: replicable, not tied to iHop.

## Non-goals

- Changing how other people on a project work. They don't use the board; the squad is Ahmed's alone.
- Replacing GitHub review or CI. The squad posts on PRs like today.
- Agent-to-agent approval of blocked actions (see Anti-goals).

## Anti-goals (a failure even if it works)

- **An agent clears another agent's safety stop** (herdr keystrokes into a permission prompt, or a job runner that
  runs a command a builder was denied). Trust comes from the fence Ahmed sets, not from agents overriding it.
- The lead is again the place every event lands.
- Ahmed becomes the bottleneck for anything but design approval and real decisions.
- Client code or job logs stored on the VPS board beyond what cards already hold.

## Constraints

- Board rules live in SQL `cb.*` functions in `db/schema.sql` (idempotent, re-applied on start; `add column if not
  exists`, `drop function if exists`). Server and CLI stay thin; web calls go through the `server/rpc.ts` allowlist.
- The board runs on vps2 (a third-party cloud). Card text already follows the no-identifiers rule; design pages and
  area files follow the same rule: describe the code and the decision, never paste patient data, credentials or
  client records.
- The Mac drops off the network under load: a hard per-machine session cap, and nothing heavy runs there.
- Permission facts, checked in the docs and in a test on 2026-11-22 (below).

## Approaches considered

**How a task moves through the stages (Q2312, Ahmed picked the first):**

| Approach | Trade-off |
|---|---|
| **Stage on the card** (picked) | One card = one design page = one history. A NO-GO sends the same card back to its builder. Needs a stage field and role-aware claiming. |
| One card per stage, chained with blockers | Least new code (reuses `cb block`), but every NO-GO adds a card and the page and history spread over 4+ cards. |
| Prompt-only handoffs | No board change, but it is cause 3 again: the handoff is a judgment call nobody makes. Dropped. |

**Build order (Q2313, Ahmed picked):** pipeline → kit → runner → supervisor. Each piece is usable on its own:
the pipeline works with sessions started by hand; the kit works without the runner; the runner works without the
supervisor.

## Piece 1: the stage pipeline (detailed: plan from this)

### Turning it on

- A project runs the pipeline when its `pipeline` setting is on (Ahmed's toggle, dashboard-only, like other project
  settings). Off = the board behaves exactly as today.
- In a pipeline project, a new card from `cb add` or `cb bug` starts at `design`, status `next`. GitHub PR tracking
  cards stay unstaged and belong to the lead.
- Unstaged cards in a pipeline project are worked the old way: the lead assigns them. Role sessions only claim staged
  cards.
- **Small found work may skip design and approval (Q2315).** The lead may start a bug or one-file chore the squad
  found itself at `build`, with a one-line note on why. Review and QA still apply; it shows in the digest. Tasks Ahmed
  gives always start at `design`.

### Stages

A card in the pipeline has a `stage`. The existing `status` list is untouched; stage is a second field.
Cards with no stage behave exactly as today.

| Stage | Who works it | Leaves when |
|---|---|---|
| `design` | the area owner for the card's area, else an architect | the design link is set and the owner passes it |
| `approval` | Ahmed | he approves (→ `build`) or asks for changes (→ `design`, same owner) |
| `build` | a builder | a PR link is set and the builder passes it |
| `review` | a reviewer who did not design or build this card | GO → `merge`; NO-GO → `build`, same builder |
| `merge` | the lead | merged and live on the dev environment; passes with `--commit <sha>` |
| `qa` | QA, checks the change **on dev** against the design page's acceptance list (Q2316) | pass → status `done`; fail → `build`, same builder, who opens a follow-up PR |

`status` follows the stage: a claimed stage is `in_progress`; a stage waiting for its role is `next`; `approval`
is `review` (Ahmed's eyes, as the column means today).

### The design page

- **Stored on the board (Q2317)** as a markdown page attached to the card, versioned: every save keeps the old
  version with who and when. Required before `design` can pass. Ahmed reads it on the card in the board UI (markdown
  already renders there) with the change since the version he approved.
- Area files use the same storage: one page per area per project, kept by its owner.
- One `cb.pages` table (project, card or area, body, version, updated_by, updated_at) plus a versions table.
  CLI: `cb page show <card>` / `cb page show --area <name>`, `cb page set <card> -f page.md` (from a file or stdin,
  since long multi-line arguments get cut off in `cb`), `cb page set --area <name> -f ...`.
- Approval records the version Ahmed approved; reviewer and QA see the diff against it.
- Short and plain: what, why, files it touches, risks, an **acceptance list**, open questions.
- Kept current by whoever holds the card: a builder who finds the plan wrong updates the page and logs why.
- Reviewer and QA judge against it. A change that drifts from the page is a NO-GO unless the page was updated and
  the change is inside what Ahmed approved; a change outside it goes back to `approval`.

### Roles on sessions

- `cb iam W1@macbook ihop --role builder [--area claims]` stores `role` and `area` on the session row
  (`sessions` gets `role`, `area`, `model`; names stay the current convention).
- Roles: `lead`, `architect`, `owner` (area owner), `builder`, `reviewer`, `qa`, `investigator` (see Investigations).
- An area is a tag. A card's area tag routes `design` to that area's owner first.
- The card remembers its crew (`designed_by`, `built_by`, `reviewed_by`), so a NO-GO returns to the same builder and
  a reviewer is never the builder.

### Claiming and handoff (board code, not judgment)

- `cb next` for a session with a role returns only cards at that role's stage, by the existing order (P0, goals,
  priority, Ahmed's order), area match first.
- `cb pass <id> "<summary>" [--pr <url>] [--link design=<url>]` advances one stage. `cb fail <id> "<why>"` sends it
  back per the table. Both go through one `cb.stage_advance` function that checks the stage, the role, the required
  link and the crew rule, then unassigns, sets the next stage and notifies the next role's idle sessions.
- Entering `approval` posts a `cb ask` to Ahmed ("Approve the design for #N?", options Approve / Changes needed, the
  page linked). His answer drives the advance; no session relays it.
- Review verdicts are explicit (`cb pass` / `cb fail`), not regex-parsed from summaries. Posting the GO on GitHub stays
  as today.
- **Back to the page:** a reviewer or QA who finds a change outside the approved page runs
  `cb fail <id> --to design "<what is outside the page>"`. The owner updates the page, it goes through `approval`
  again, then back to `build` with the same builder.
- **Same builder / same owner is a hold, not a preference:** the returned card is `next` with its assignee set to the
  original session (`task_claim` already honours this). The hold ends when the stall or relay-gone rule fires; then any
  builder (or owner, else architect) can claim it.
- **Owner, else architect:** `design` waits 15 min for a live, free owner of the card's area; after that, or at once
  if the area has no owner, an architect can claim it.
- **Writes that bypass `stage_advance`** on a staged card: `done`/`cancelled` are refused except from Ahmed (dashboard)
  or the lead with a note, which clears the stage and is logged. `blocked` ↔ `in_progress` (blocking questions) is
  allowed and leaves the stage alone. Enforced in `tasks_before`.

### Stalls (board code)

- Extends the existing `pings_due` timer, automatic for every staged card (no opt-in). "Quiet" means no event on the
  card and no event from its holder anywhere, so a session busy elsewhere or waiting on a job is not quiet.
  - after 30 min quiet: a nudge to the holder;
  - after 90 min quiet with the nudge unanswered: unassigned and put back at the head of its stage queue, logged on
    the card, holder told.
- For staged cards the copy to `orch@*` stops; the stall shows in the lead's digest instead.
- `approval` never auto-moves: a reminder to Ahmed, at most every 2 h.
- A session that is down keeps its cards (Q2324: Ahmed restores it); the lead's digest names it and what it holds.
  The nudge and the 90-minute release apply only while the holding session is live.

### The lead and its digest

- The lead is a session with `role = lead` **or** named `orch@*` (the name check stays, so today's sessions keep
  working).
- In a pipeline project the lead stops getting per-event copies: answer copies, the pings copy and the unblocked
  messages. Bug triage still reaches it, because filing an unstaged bug needs a person to stage it. An answer "needs a
  human call" when it answers the lead's own question or its asker's relay is gone.
- Instead the server sends it a **digest** every 15 min, or at once on a P0: stage counts, stalls the board already
  acted on, Ahmed's answers that need a human call, cards with no area owner, sessions at their cap. Each line ends
  with the command to act on it, like `cb tick`.
- The lead's jobs shrink to what needs judgment: splitting Ahmed's requests into cards with an area, cross-area
  conflicts, merges, and decisions that go to Ahmed. Priorities are re-read from the board every digest, never kept
  in memory.

### Board UI

- Card chip shows the stage in plain words ("Design", "Waiting for your approval", "Building", "In review",
  "Merging to dev", "Checking on dev against the design").
- A filter or lane for "Waiting for your approval" so design approvals don't get lost among other questions.

### Tests (board's existing `node --test` against the test Postgres)

- `stage_advance`: every legal move, every refused one (wrong role, missing link, reviewer = builder).
- NO-GO and QA fail return to the same builder.
- Stall timer: nudge at 30, unassign at 60, approval never unassigned.
- `next` filters by role and prefers area match; cards without a stage are unchanged.
- Digest replaces per-event copies only for pipeline projects.

## Investigations (added 2026-11-22, Ahmed, after approval)

Ahmed's ask: a session that only helps him debug and trace, often on UAT or production, which are air-gapped (Claude
can't reach them: Ahmed runs the steps and pastes results). Long investigations lose track and drop findings.

- An investigation is a card of type `research`. It never gets a stage: it is claimed by a new role,
  **investigator** (Opus), and never freed by the stall rules, since it often waits on Ahmed's steps.
- **The card's page is the investigation log**, and the source of truth, not the session's memory:
  the question, where we are now, a numbered findings list (each: what, evidence, status open / confirmed / wrong),
  the next step, and the bugs filed. The investigator updates the page after every step and re-reads it after a
  compaction or restart.
- **Ahmed edits the log himself** on the board ("all the findings above are wrong"); the session re-reads it.
- **It never fixes.** A bug it finds becomes a card (`cb bug`, linked to the investigation); a fix happens only on
  Ahmed's word, through the pipeline. The investigator's permission file is read-only plus `cb` (piece 2).
- Piece 1 carries the board side (role, routing, stall exemption, page editing in the UI); piece 2 carries the role
  prompt, the page template and the permission file.

## Models per role

Ahmed should never have to say "use Opus for this". The model is part of the role:

| Role | Model | Why |
|---|---|---|
| lead, architect, area owner, reviewer, investigator | Opus | judgment: design, review, tracing |
| builder, QA | Sonnet | builds and checks against a written page |

- One map per project on the board (both machines read it), filled from these defaults. Fable only when Ahmed names it.
- Every launch passes `--model` (and effort) explicitly: the Mac's default model changes whenever a session runs
  `/model`, so nothing relies on the default.
- `cb iam --role` records the model; the lead's digest flags a session whose model doesn't match its role.
- Piece 1 stores the session's model; the map and launching with it are pieces 2 and 4.

## Piece 2: the kit (outline: its own design when it's next)

- **Role prompts**: `prompts/roles/<role>.md`, each one short: what the role does, the commands it uses, when it passes
  or fails a card, what it never does.
- **Permission files per role**: `kit/permissions/<role>.json`, passed with `claude --settings`. Builders: narrow allow
  rules for git, gh, the project's test commands. Reviewers and QA: read-only git, `gh pr view/diff/comment`, `cb`;
  deny on edit, write and push. Everyone: deny push to `main`, force push. Launch flags fix the model per role
  (`--model sonnet` / `--model opus`).
- **Area files**: one living document per area, kept by its owner, read by everyone who works a card in that area.
  Must be readable from the Mac and work for any project.
- **Squad file + start command**: one file per project naming roles, counts, models, areas and machines;
  `cb squad up <project>` starts them through herdr (by hand until the supervisor exists).
- **What goes in from today's rules**: one GO from a different session before merge, design before build, nothing
  heavy on the Mac, two panes per herdr tab, reviewers never edit, PHI and identifier rules.

## Piece 3: the PC job runner (outline)

- Mac sessions submit **named recipes with parameters** (`cb run test --file tests/x.test.ts --sha <sha>`), never
  arbitrary shell. Recipes live in the kit per project. The runner has its own deny list.
- A `jobs` table on the board (recipe, params, sha, requester, state, exit code, a short summary), claimed by a runner
  daemon on the PC with `FOR UPDATE SKIP LOCKED` + `LISTEN`, same style as the relay.
- The runner works in its own PC worktrees, fetches the sha, runs, posts the exit code and summary; the requester gets
  it pushed like any board message.
- Full logs stay on the PC and are read over Tailscale, not stored on the VPS board.

## Piece 4: the supervisor (outline)

- A script on the PC, looping every minute: reads per-role queue counts and idle sessions from the board, starts or
  closes sessions through herdr with the role's model and permission file.
- Hard caps per machine (Mac: 8) and per role. Never closes a session holding a card. Closes sessions idle 20 min.
- Starting is herdr `agent start ... -- --model <m> --settings <file>` then the role prompt; verified flags first.

## What the permission test showed (2026-11-22)

Two Sonnet sessions in auto mode replayed 14 git/node commands in a throwaway repo with a local remote:

- **No allow list:** all 14 ran, including `git push origin main` and `git push --force`. The auto-mode classifier
  did not stop routine git here, and it is **not a fence**: it let force-push through.
- **Builder permission file:** 12 ran; the two deny rules (push to main, force push) refused. Deny rules are the fence.
- **Likely source of today's "classifier" stops:** Ahmed's global `~/.claude/hooks/block-dangerous-commands.sh`
  matches its patterns anywhere in the command text, including inside messages and heredocs. It blocked this
  session's own test setup on the text `git reset --hard`, and it is why the word "shutdown" can't appear in a
  `cb tell`. Caveat: the test used a local remote; a real GitHub remote may be judged differently.

## Decided by Ahmed

- Q2306: design page per task, Ahmed approves every one, kept current, done validated against it.
- Q2307: all four causes.
- Q2308: coordination in board code plus a supervisor script; the orchestrator becomes a lead with a digest.
- Q2309: area owners plus stage roles.
- Q2312: stage on the card.
- Q2313: order pipeline → kit → runner → supervisor.
- Q2314: run the permission test (done, above).
- Q2315: small found work (a bug, a one-file chore) may start at `build` with the lead's note; Ahmed's tasks never.
- Q2316: QA runs after merge, on the dev environment; done = seen working on dev.
- Q2317: design pages and area files live on the board as versioned markdown.
- Q2324: no card is freed because its session or machine is down; Ahmed restores it.
- Q2323: work with no code (ops, a data check) leaves the pipeline when the lead marks it, with a one-line reason
  (`cb stage <id> none --why "..."`); it shows in the digest.
- Q2318: change the global dangerous-commands hook "for max efficiency": strip quoted strings, heredocs and
  `cb tell`/`cb ask` message text before matching, and match patterns only where a command starts (line start, after
  `;`, `&&`, `||`, `|`). Every real dangerous command stays blocked. Part of piece 2 (the kit), with a small test
  file of commands that must block and texts that must pass; Ahmed confirms in the terminal before the global file
  is changed.

## My calls (all four groups accepted by Ahmed, Q2320)

- Stage is a second field; the status list stays. Cards without a stage work as today.
- Stall timings: nudge 30 min, unassign after 90 min with the nudge unanswered, approval reminder every 2 h (became
  a digest line, see the plan), relay gone 10 min (dropped by Q2324: a down session keeps its cards).
- A project setting turns the pipeline on; new cards there start at `design`; PR tracking cards stay unstaged.
- NO-GO / changes-needed returns are holds for the same session until a stall rule fires.
- Out-of-page changes go back to `design`, then `approval`, then `build` with the same builder.
- Only Ahmed, or the lead with a logged note, can finish or cancel a staged card outside the pipeline.
- The lead keeps bug triage messages; other copies become the digest.
- A `merge` stage held by the lead sits between review and QA (from Q2316). The lead passes it once the change is
  live on dev; how "live on dev" is checked is per project, in the kit.
- Digest every 15 min, immediate on P0.
- Area = a tag; role and area stored on the session row.
- A change outside the approved page goes back to `approval`.

## Open questions

None left for Ahmed. The kit, runner and supervisor get their own short designs when their turn comes.
