# Squad piece 3: the PC job runner (design)

Card #3600. Follows `2026-11-22-squad-design.md` ("Piece 3: the PC job runner"); its decisions and anti-goals bind
this design. Ahmed started it on 2026-11-23 and chose **checks only** for this piece.

## Why

Mac sessions may not run heavy work: the Mac drops off the network under load (owner rule, 2026-11-19). Today a
worker sends the lead `run: <command> at <sha> on <branch>`, the lead runs it in a PC worktree and pastes the
output back. That is a large share of the lead's traffic (cause: "orchestrator bombarded"), it is slow, and the
command is free text. The runner makes it a board job: a session asks for a **named check**, the PC runs it, the
answer comes back by itself.

## Goals

- A session runs `cb run <recipe> [params] --sha <sha>`; the PC runs it at that commit and the session gets the
  exit code and a short summary pushed to it like any board message.
- Only named recipes with checked parameters. Never free shell.
- Full logs stay on the PC; the board stores only the summary.
- Works for any project that has recipes on the PC; iHop is the first.

## Non-goals

- Jobs that change anything outside the PC (image builds, pushes, deploys, scenario cycles against dev, GitOps).
  Ahmed chose checks only; each later kind needs its own approval.
- Replacing the Mac's own pre-push hook (it stays, per Q1700).
- Starting the runner automatically (piece 4, the supervisor).

## Anti-goals

- The runner runs something a session was denied. Recipes are the only fence: no recipe, no run.
- Recipes editable from the board. Whoever can write a board row (any session, honour-system actors, or anyone
  who reaches vps2) must not be able to make the PC run a command.
- Job logs or client code stored on vps2 beyond the short summary.

## How it works

### Recipes: a file on the PC only

- Changed from the umbrella outline ("recipes live in the kit"): the kit is a repo sessions can push to, so a recipe
  there could be edited by a session. A file outside every repo, edited only by Ahmed, keeps the fence his. My call.
- `~/.claude-board/runner.json` on the PC (outside every repo), edited by Ahmed. Per project: the git URL, a
  worktree base folder, and the recipes.
- A recipe is an **argv array** with `{param}` slots, a working folder inside the repo, extra env, a timeout, and
  for each parameter a pattern it must match. Commands run with no shell.
- Parameter checks, always applied on top of the recipe's own pattern: repo-relative path, no `..`, not absolute,
  never starting with `-` (no flag injection), at most 20 values per list parameter.
- The runner publishes **only names and parameter names** to the board (`cb.runner_recipes`) when it starts, so
  `cb run` can refuse an unknown recipe and `cb help run` can list them. The commands never leave the PC.
- First iHop recipes (all read-only checks; exact argv in the file, from CLAUDE.md and today's `run:` requests):

| Recipe | Params | What it runs |
|---|---|---|
| `install` | none | `pnpm install --frozen-lockfile` |
| `check` | `ws` (1-6 workspace names) | `pnpm --filter <ws> check` per workspace |
| `test` | `app` (claims-api, preauth), `files` | node:test via tsx, one or more files |
| `itest` | `files` | claims-api only: the PC test stack up (synthetic data), the files with `INTEGRATION_TESTS=1`, the stack down |
| `kbtest` | `files` | knowledge-base DB tests (`*.db.test.ts`): the same stack, then `vitest run <files>` |
| `vitest` | `ws`, `files` | `pnpm --filter <ws> exec vitest run <files>` |
| `lint` | `files` | `oxlint` + `prettier --check` on the files |
| `build` | `ws` | `turbo build --filter=<ws>` |
| `guards` | none | the pre-push guard scripts (fixed list) |

### Jobs on the board

- New table `cb.jobs`: id, project, recipe, params (jsonb), sha, requester, card id (optional), state
  (`queued`, `running`, `passed`, `failed`, `error`, `cancelled`), exit code, summary (≤ 1,000 chars), runner name,
  created / started / finished times.
- `cb run <recipe> --sha <sha> [--card <id>] [--<param> v ...] [--wait]`: checks the recipe and parameter names
  against `cb.runner_recipes`, inserts the job, prints `job #N queued (k ahead)`. `--wait` blocks until it finishes
  (up to the recipe's timeout plus queue time, capped at 30 min) and prints the result.
- `cb jobs [project]` lists queued and running jobs and the runner's last heartbeat; `cb job <id>` shows one;
  `cb job cancel <id>` (the requester, the lead or Ahmed).
- When a job ends the board sends the requester a message (`cb.tell` from `runner`): recipe, sha, result, exit
  code, summary, and the log command. The relay delivers it like any other message.
- The sha must be on the project's remote (pushed). A sha the runner can't fetch ends as `error: push it first`.

### What the runner will execute (my call, after the builder check)

Recipes fence the command, but `install`, `test`, `build` and the rest run whatever code is at the sha. So:

- **Only commits on a branch of the project's own remote**: the runner fetches `refs/heads/*` only and refuses a sha
  no branch contains (`error: not on a branch of origin`). Pull-request refs and unreachable objects are refused.
  Pushing a branch needs write access to the repo, which is the same trust as merging into it.
- **Clean environment**: a job starts from an empty environment plus `PATH`, the system basics (`SYSTEMROOT`,
  `TEMP`, `HOME`/`USERPROFILE`) and the recipe's own `env`. The runner's board URL, tokens and anything else in its
  own environment never reach a job.
- **Only bound sessions of that project** may queue a job (`cb.iam` seen in the last day, project matches); Ahmed's
  dashboard may too.
- This is the runner's deny list: recipe allowlist + parameter checks + branch-only commits + clean env.

### The runner daemon on the PC

- `cb runner` (a new CLI command, `cli/runner.ts`), started by hand in a herdr pane on the PC until piece 4.
  One runner per machine; a second one refuses to start.
- Connects to the board like the relay (same `connect`, its own application name), `LISTEN`s for new jobs, claims
  with `FOR UPDATE SKIP LOCKED`, heartbeats every 30 s; a 30 s poll is the safety net.
- Pre-auth integration tests are **not** in this piece: iHop's test-stack script provisions platform, claims and
  knowledge-base only. They need a pre-auth target in that script first (an iHop card, not this one). My call.
- **Slots: 2 jobs at once; DB-backed jobs (`itest`, `kbtest`) one at a time**, each with its own test-stack project name and
  ports so two never share a database. Slots and ports are in `runner.json`.
- **Worktrees:** one per slot per project at a short path (`C:/r/<project>-<slot>`, MAX_PATH). Per job: fetch the
  sha, `git checkout --detach <sha>`, `git clean -fdx` except `node_modules`, and `pnpm install --frozen-lockfile`
  when the lockfile changed since that slot's last install (an `install` step counts in the job's time).
- **Timeouts:** per recipe; a job over its timeout is killed (whole process tree) and ends `error: timed out`.
- **Summary:** for node:test and vitest, the pass / fail / skip counts and the names of up to 5 failing tests; for
  others, the last 5 lines once code-frame lines (a linted file's source) and pnpm trailer lines are dropped. **The runner masks** what the board's `cb._sensitive` patterns would flag (token-like
  strings, emails, 10-digit IDs …) with `[masked]` before it writes the summary; if the board still refuses the
  text, the summary becomes `summary withheld: see cb job log <id>`. The job's result is never changed by this.
  My call: masking keeps the counts, which is what the requester needs.
- **Logs:** the full output goes to `~/.claude-board/runner/logs/<job>.log` on the PC, kept 7 days.
  `cb job log <id> [--tail N]` from any machine reads it from the runner over Tailscale: the runner serves
  `GET /jobs/<id>/log` on its Tailscale address only, read-only, no other routes. **It answers only the PC and the
  MacBook** (a peer allowlist in `runner.json`, checked by the caller's Tailscale address); vps1 and vps2 are refused,
  because logs hold client code and must not reach a VPS. My call.
- A runner that stops leaves its running jobs `running`; on start it marks its own unfinished jobs `error: runner
  restarted` and tells the requesters. Queued jobs wait for a runner; `cb jobs` shows how long the runner has been
  silent. Nothing is retried automatically (the requester re-runs).

### Prompts

- `_common.md`: "Heavy work (suites, type checks, builds, installs, DB tests) goes through `cb run`; never run it on
  the Mac." Builder and reviewer role texts name `cb run check` / `cb run test` where they mention tests.

## Constraints

- Board rules in `cb.*` SQL functions in `db/schema.sql`, idempotent; CLI thin. RPC allowlist only if the web needs
  it (it doesn't in this piece; `cb jobs` is CLI only).
- PC limits: Node heap cap, Windows MAX_PATH, the test-stack needs Docker Desktop running (the runner checks
  `docker info` before an `itest` and ends the job `error: Docker is not running` if not).
- No identifiers or patient data in summaries, board text or the job params (they are file paths and workspace
  names).

## Approaches

| Approach | Trade-off |
|---|---|
| **Board jobs table + PC daemon** (umbrella design, picked) | Same mechanics as the relay; results arrive as board messages; recipes stay on the PC. New table, CLI and daemon. |
| A session drives a PC herdr pane directly | No new code, but it is free shell on the PC: breaks the anti-goal. Dropped. |
| GitHub Actions self-hosted runner on the PC | Reuses Actions, but CI is off on purpose, jobs would need workflow files per project and a push per run, and results land on GitHub, not with the session. Dropped. |

## Tests

- SQL: job insert refuses an unknown recipe or parameter; claim is exclusive under two concurrent claimers;
  cancel rules; the end message reaches the requester; restart marks the runner's own running jobs.
- Runner (pure parts): argv building from a recipe and params; every parameter check (`..`, absolute, leading
  `-`, pattern, count); summary parsing for node:test and vitest output; slot and DB-slot scheduling.
- One live check before release: a Mac session runs `cb run check`, `cb run test` and `cb run itest` on iHop at a
  pushed sha; `cb run test --files ../x` and `--files -r` are refused; the result arrives by itself; `cb job log`
  reads the log from the Mac.

## Left to the builder

The exact argv per iHop recipe (from CLAUDE.md and `docs/database-workflow.md`), the summary parsers, the log
server's port, the `runner.json` schema details.
