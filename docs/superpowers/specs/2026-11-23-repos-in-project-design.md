# Squad piece 5: several repos inside one project (design)

Card #3703, under #3594. Builds on `2026-11-22-squad-design.md`, `2026-11-23-squad-kit-design.md`,
`2026-11-23-pc-job-runner-design.md` and `2026-11-23-supervisor-design.md`; their decisions still bind.

## Why

A board project is a product: QHS is four repos (api in .NET, dashboard in React, app in Flutter, bot), iHop is two
(iHop-Platform and ihop-reading-service). The board already treats a project as a product (cards, questions, pages and
the GitHub watch work across any number of repos), but the squad file and the PC runner, built this week, assume one
repo per project: every squad session starts in that one folder, and `cb run` knows one git URL per project. Ahmed
(2026-11-23): "tying one project to one repo does not make sense". This piece makes a project hold several **repos**,
and makes squad sessions, cards and runner jobs know which repo they work in.

## Decisions already made

- **1a (Ahmed):** a card that touches several repos stays **one card**. At build it gets **one part per repo**, each
  built by a builder of that repo and ending in that repo's own PR.
- **2a (Ahmed):** role counts are **per repo** (QHS: api builders 2, dashboard 1, app 1, bot 1), not one shared pool.

## Goals, non-goals, anti-goals

- Goal: one project, many repos; every session starts inside the repo it works in, so that repo's CLAUDE.md, stack and
  tests apply; the board routes each card (or each part of it) to sessions of the right repo; the runner checks any
  repo of the project.
- Goal: a one-repo project keeps working unchanged (today's squad files and runner.json stay valid).
- Non-goal: a pipeline switch per repo (the switch stays per project); repos shared between projects; automatic
  splitting of a card into separate cards.
- Anti-goal: a card silently built in the wrong repo, or a session started in a folder that is not its repo.

## The model

```
project qhs
 ├─ repo api        areas: api           builders 2, reviewers 1
 ├─ repo dashboard  areas: dashboard     builders 1, reviewers 1
 ├─ repo app        areas: mobile        builders 1, reviewers 1
 └─ repo bot        areas: bot           builders 1
project-wide roles: lead, architect, qa, investigator (they start in the project's home repo)
```

### 1. Squad file

New optional key `repos`; each repo has a path per machine. Areas become objects that name their repo. Repo-bound
roles (builder, reviewer, owner) take a count per repo; project-wide roles keep one count.

```json
{
  "supervise": true,
  "machines": { "shaltoot": { "herdr": null, "board": "F:/Work/claude-board" },
                "macbook":  { "herdr": "macbook", "board": "/Users/ahmedshaltoot/Work/claude-board" } },
  "repos": {
    "api":       { "home": true, "paths": { "shaltoot": "F:/Work/QHS/api", "macbook": "/Users/ahmedshaltoot/Work/QHS/api" } },
    "dashboard": { "paths": { "shaltoot": "F:/Work/QHS/dashboard", "macbook": "/Users/ahmedshaltoot/Work/QHS/dashboard" } }
  },
  "areas": [ { "name": "api", "repo": "api" }, { "name": "dashboard", "repo": "dashboard" } ],
  "roles": {
    "builder":  { "count": { "api": 2, "dashboard": 1 }, "model": "sonnet", "machine": "macbook" },
    "reviewer": { "count": { "api": 1, "dashboard": 1 }, "model": "opus",   "machine": "macbook" },
    "owner":    { "model": "opus", "machine": "shaltoot" },
    "qa":       { "count": 1, "model": "sonnet", "machine": "macbook" }
  }
}
```

- A squad file without `repos` is today's shape: one repo named `main`, its path the machine's `repo`; area strings
  stay strings. Nothing existing has to change.
- `home`: exactly one repo; project-wide roles (lead, architect, qa, investigator) start there.
- Names: repo-bound sessions carry the repo, `qhs-api-B1@macbook`, `qhs-dashboard-R1@macbook`; a one-repo project keeps
  `ihop-B1@macbook`. Owners stay one per area (an area names its repo, so the owner starts there).
- The Mac cap of 8 is checked on the sum of all counts on the Mac, as today.

### 2. Sessions know their repo

`cb iam ... --repo <name>` records it (`cb.sessions.repo`); squad launches pass it. A session without a repo (hand
started, or a one-repo project) counts as the home repo.

### 3. Cards know their repos

- `cb.tasks.repos text[]`. Set by `cb add --repo api,dashboard`, `cb edit --repo ...`, or derived: a card tagged with
  areas gets those areas' repos when it enters design.
- **Design pass requires repos** in a project with more than one repo: the owner or architect names them (the design
  page already lists the files it touches; now the card says which repos). One-repo projects: always `main`.
- An unstaged card (worked the old way) needs no repo.

### 4. Build parts (decision 1a)

- When a card with several repos passes approval into `build`, the board creates **one part per repo**
  (`cb.task_parts`: task, repo, assignee, pr, state, crew). A one-repo card has no parts and works exactly as today.
- A builder's `cb next` offers cards (or parts) **of its own repo** only. It claims a part, works in its repo's
  worktree, and `cb pass <id> --pr <url>` closes **its** part with its PR.
- The card leaves build when every part has its PR. The card's links keep every PR (`pr`, `pr:dashboard`, ...).
- **Review is per part too** (a .NET reviewer reviews the api PR, a React reviewer the dashboard one); the card leaves
  review when every part has a GO. A NO-GO sends only that part back to its builder. My call: one reviewer for PRs
  in different stacks would review code it does not know.
- **Merge and QA stay card-level**: the lead merges all PRs (in the order the design page gives), QA checks the whole
  change on dev once.
- The digest and the card show parts in plain words: "build: api done (PR #12), dashboard building (qhs-dashboard-B1)".

### 5. Supervisor

- `cb.supervise_state` counts waiting work per **role and repo** (parts count by their repo; a one-repo card by its
  repo), and sessions per role and repo.
- `planTick` starts and closes per role and repo against the per-repo counts; names as in section 1; every launch's
  folder is that repo's path on that machine. Everything else (caps, 3 starts per tick, restore, close rules) is
  unchanged.

### 6. PC runner

- `runner.json` projects may carry `repos`: each repo has its own `git`, `lockfile`, `install`, `recipes` (exactly the
  fields a project has today). A project without `repos` is one repo `main`, as today.
- `cb run <recipe> --sha <sha> [--repo <name>]`: the repo defaults to the session's repo; a recipe name is looked up in
  that repo. `cb jobs <project>` lists recipes per repo.
- Slot clones are per project and repo: `C:/r/qhs-api-1`, `C:/r/qhs-dashboard-1`. The slot count stays global (2).
- `cb.jobs.repo` and `cb.runner_recipes.repo` columns; the board message names the repo when the project has several.

### 7. Prompts and help

- Role prompts: "you work in your repo; `cb next` gives you cards of your repo; for a card with parts you pass your
  part". The architect's and QA's first prompt lists every repo path of the project so they can read across repos.
- `cb help` and `docs/ops/maintain.md`: the squad file's `repos`, `--repo` on iam/add/edit/run.
- Permission files need no change: squad sessions run in bypass mode with deny rules only.

## Edge cases (my calls, from the builder check)

- **Every repo with builders has reviewers.** `squad_set` refuses a repo with a builder count and no reviewer count
  (a part with nobody to review it would sit in review forever).
- **A card never defaults to a repo.** In a multi-repo project a staged card with no repos is not claimable by
  builders; the digest lists it for the lead ("#N has no repo: cb edit N --repo ..."). `cb stage <id> build` there
  requires `--repo`. Adding `repos` to a project backfills nothing.
- **Repos lock at build.** `cb edit --repo` is refused while a card is past design; the way to change the repo list is
  `cb fail <id> --to design`.
- **Send-backs:**
  - a reviewer's NO-GO sends back only that reviewer's part;
  - `cb fail <id> --to design` (review or QA) sends the whole card back; on re-approval every part goes back to build
    with its last builder and keeps its PR link; a part whose repo was dropped is listed on the card for the lead to
    close its PR;
  - a QA fail names the repo: `cb fail <id> --repo <r> "<why>"` reopens that part with its builder for a follow-up PR
    (kept next to the first: `pr:<r>` becomes the newest, the old one stays in the card's history). Without `--repo`
    on a multi-part card QA is asked to name one.
- **Links:** every part's PR is `pr:<repo>`; the bare `pr` is the first repo in the card's repo list (the design's merge
  order), so today's readers of `links.pr` keep working. `cb tick` reads the repo from the PR URL, not from one
  project setting.
- **Merge is per part inside, card-level outside:** the lead passes each repo's merge with `cb pass <id> --repo <r>
  --commit <sha>`; the card goes to QA when every part has its commit; a part that cannot merge holds the card at merge
  with a digest line.
- **Runner repo names must match the squad's.** The runner publishes its repos per project at start; `cb run` with a
  repo the runner does not have is refused, naming the repos it has. No fallback to another repo.
- **Session names:** the home repo keeps today's names (`ihop-B1@macbook`), other repos carry the repo
  (`ihop-reading-B1@macbook`), so turning iHop into two repos needs no drain.
- Holds, stalls, closing marks, restore and `cb resume` count a part's assignee exactly like a card's.

## What a person sees (QHS example)

1. Ahmed adds "Show the visit date on the dashboard" tagged `api` and `dashboard`.
2. The api owner (or the architect) designs it; the card now says repos: api, dashboard. Ahmed approves.
3. The card enters build with two parts. The supervisor starts `qhs-api-B1@macbook` in the api repo and
   `qhs-dashboard-B1@macbook` in the dashboard repo. Each builds, runs `cb run test --repo ...` on the PC, opens its PR.
4. When both PRs exist the card goes to review: an api reviewer and a dashboard reviewer each give a GO.
5. The lead merges api first, then dashboard; QA checks the screen on dev; the card is done.

## Risks

- **Two builders on one card disagree on the contract between repos** (an API shape). The design page must state the
  contract; a part's builder that needs it changed asks on the card, it does not change the other repo.
- **Merge order across repos** matters (API before the screen that calls it): the design page states it; the lead
  follows it.
- **More sessions per card**: a two-repo card uses two builders and two reviewers. The Mac cap still holds.
- **Old squad files**: covered by the one-repo default; tests pin that `ihop`'s current shape plans exactly as today.

## Tests

- squad_set: `repos` accepted and checked (paths absolute, one home, areas name a known repo, counts per repo, Mac sum);
  today's shape unchanged.
- Claiming: a builder of repo A never gets a card or part of repo B; a session with no repo is the home repo.
- Parts: a two-repo card enters build with two parts; each builder passes its own; the card moves only when all have
  PRs; a NO-GO on one part sends only that part back; a one-repo card has no parts.
- Design pass refuses a multi-repo project card with no repos.
- supervise_state / planTick: waiting and counts per role and repo; launch folder = the repo path.
- Runner: per-repo recipes and slot clones; `--repo` default from the session; a one-repo runner.json unchanged.
- Live check on a throwaway two-repo project before release (two local repos, one card touching both).

## Build order (for the plan)

1. Schema: squad `repos`/areas, `sessions.repo`, `tasks.repos`, `task_parts`, claim and pass rules, digest lines.
2. Squad launch and supervisor per repo.
3. Runner per repo.
4. Prompts, help, docs; live check.

## Not in this piece

A pipeline switch per repo; repos shared by two projects; moving existing cards between repos in bulk; a dashboard
editor for the squad file.
