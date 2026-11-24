# Lead by role, Azure DevOps PRs, protected branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session with the lead role is its project's lead whatever its name; the board takes Azure DevOps PR links; each squad can name branches its sessions may never push to.

**Architecture:** Rules stay in SQL (`db/schema.sql`, functions re-created on every setup); the CLI (`cli/squad-up.ts`, `cli/tick.ts`, `cli/cb.ts`) stays thin; role files (`prompts/roles/*.md`) tell sessions what to run; the global PreToolUse hook (`kit/hooks/block-dangerous.mjs`) enforces the push fence.

**Tech Stack:** Node 24 TypeScript run directly (no build), postgres.js, PL/pgSQL, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-24-lead-by-role-and-ado-prs-design.md` (approved by Ahmed: Q2551; Q2552 = protected branches in this card; Q2553 = GO on the board and on the PR).

## Global Constraints

- Repo rules: `CLAUDE.md` at the repo root. Failing test first, then the code. Error messages say what to do next.
- Tests: `CB_TEST_DB=claude_board_test NODE_OPTIONS=--max-old-space-size=4096 timeout 600 node --test --test-concurrency=1 test/<file>.test.ts`, holding the board's test lock: `cb lock take db2` before, `cb lock release db2` after (exit 2 = queued: wait). Run only the files you touch or that import what you touch. Never the full suite; never a VPS; never the live board.
- `db/schema.sql` is applied in file order. A `language sql` function's body is validated when it is created, so it must not call a function defined further down (`cb._role` is defined near line 3517; `cb.triagers` near line 388 is `language sql`). `plpgsql` bodies are checked only when called.
- An `orch@<machine>` or `orch` session with no role still counts as the lead everywhere (today's behaviour; `cb._role` already defaults it).
- No change to how the board stores PRs (`links.pr`, `task_parts.pr` stay one URL string).
- Board text and test fixtures carry no real names, emails or client data.
- Commit messages: conventional commits, ending with the two attribution lines the controller gives you.

## Review Focus

1. **A lead-role session in another project.** `cb._role(a)` reads the actor's latest session, whichever project it is in. A check that must mean "lead of THIS project" must also test the project. Each task-1 test seeds the lead in project A and asserts nothing changes in project B.
2. **ihop-squad unchanged.** Its plan today: `orch@shaltoot` is live in ihop-squad, so it is skipped, nothing renamed. The squad-up test pins it.
3. **Push-fence false positives.** `git push origin feature/development-fix` and `git push origin my-staging` must NOT be blocked when `development` and `staging` are protected; the match is on the whole destination branch name (globs only where the list has `*`).
4. **Push-fence bypass forms.** `git -C path push origin x:development`, `git push origin +x:refs/heads/development`, `git push --delete origin development`, `git push origin :development` must be blocked.
5. **Hook without the variable.** With `CB_PROTECTED_BRANCHES` unset or empty, the hook's output is byte-for-byte today's for every existing test.

---

### Task 1: The lead by role

**Files:**
- Modify: `db/schema.sql` (cb.triagers ~388; cb.inbox answer_copies ~1547; cb.pings_due nudge copy ~1818; cb._huddle_post ~1863; cb.tick review-hold exemption ~2291)
- Modify: `cli/squad-up.ts` (planSquad, squadUp probe loop and output lines), `cli/cb.ts` (~608, the bug command's "(no orchestrator there)")
- Modify: `cli/help.ts` (the `iam` names line and the squad text: a lead is whoever has the lead role)
- Test: `test/squad-up.test.ts`, and the schema tests for each changed function (find them: `grep -ln "triagers\|answer_copies\|huddle\|unreviewed" test/*.ts`)

**Interfaces:**
- Produces: `Live` rows in `cli/squad-up.ts` carry `role: string | null` (from `sessions_overview`, which already returns `role`).
- Produces: `planSquad(...)` returns the same shape; `heldBy` is no longer filled for a lead that gets an alternate name (keep the field; it stays `{}` in that case).

- [ ] **Step 1: failing tests**
  - squad-up: (a) `orch@shaltoot` live in project `other`, a session `QO@shaltoot` with role `lead` live in `demo` → the plan starts no lead and skips none by name; (b) `orch@shaltoot` live in `other`, no lead in `demo` → the plan starts `demo-orch@shaltoot` with role lead (its launch prompt binds `cb iam demo-orch@shaltoot demo --role lead`); (c) `orch@shaltoot` live in `demo` → skipped as today, nothing renamed; (d) update the existing `heldBy` test at line ~82 to the new rule.
  - schema: a session `QO@m` with role lead in project `p` (no `orch@` name): is in `cb.triagers('p')`; receives answer copies in `cb.inbox` (non-pipeline project); receives the stale-card nudge copy; can post to a huddle it is not a member of in `p`; its own card in review is not listed as `unreviewed` by `cb.tick('p')`. The same session bound to project `q` gets none of these for `p`. An `orch@m` session with no role still gets all of them.
- [ ] **Step 2: run them, see them fail**
- [ ] **Step 3: code**
  - `cb.triagers` (language sql): replace the name test with the session row's own role, inline: `coalesce(s.role, case when s.actor = 'orch' or s.actor like 'orch@%' then 'lead' end) = 'lead'` (the row is already filtered to the project).
  - The four plpgsql spots: the actor is the project's lead when its latest session is in that project with role lead (or the `orch` default). Add one helper `cb._is_lead(a text, proj text) returns boolean` defined right after `cb._role`, used by all four; the job-cancel check near line 4869 may use it too.
  - `cli/squad-up.ts`: the lead counts as present when any live row has `project === project && role === 'lead'`, or the wanted name is live in this project. When `orch@<m>` is live in another project and no lead is present, the wanted lead becomes `${project}-orch@${m}` (same role, repo, machine). The herdr probe loop asks about that name too. `squad_set`'s 32-character check (~4615) also measures `<project>-orch@<machine>`.
  - `cli/cb.ts` bug command: "(no orchestrator there)" when no told session is the project's lead (ask SQL: `cb._is_lead(x, project)`).
- [ ] **Step 4: run the touched test files, all green; read pass/fail counts**
- [ ] **Step 5: commit** `feat(squad): a project's lead is its lead-role session, whatever its name (#3746)`

### Task 2: Azure DevOps pull requests

**Files:**
- Modify: `db/schema.sql` (cb.pass, the build-stage URL check near line 3713)
- Modify: `cli/tick.ts` (`prRef`)
- Modify: `prompts/roles/builder.md`, `prompts/roles/reviewer.md`, `prompts/roles/lead.md`, `cli/help.ts` (the `pass` entry)
- Test: `test/repos-parts.test.ts` (or wherever the GitHub-URL refusal is tested: `grep -n "full pull request URL" test/*.ts`), `test/tick.test.ts`, and any test that pins role-file text (`grep -ln "prompts/roles" test/*.ts`)

**Interfaces:**
- Produces: accepted PR link forms at build for a card with repos: `^https://github\.com/[^/]+/[^/]+/pull/[0-9]+/?$` and `^https://dev\.azure\.com/[^/]+/[^/]+/_git/[^/]+/pullrequest/[0-9]+/?$`.
- Produces: `prRef(link, project)` returns `null` for any `dev.azure.com` link, even when `GITHUB_REPO_<PROJECT>` is set (export it if the test needs it).

- [ ] **Step 1: failing tests**: build pass with `https://dev.azure.com/org/proj/_git/api/pullrequest/12` succeeds for a part; `https://dev.azure.com/org/proj/_git/api/pullrequests` (no number) and `https://dev.azure.com/org/proj/pullrequest/12` (no `_git/<repo>`) are refused, and the error names both forms; `prRef('https://dev.azure.com/o/p/_git/r/pullrequest/7', 'qhs')` is null with `GITHUB_REPO_QHS=o/r` set.
- [ ] **Step 2: run, see them fail**
- [ ] **Step 3: code**: the regex and error text (`give the full pull request URL: https://github.com/<owner>/<repo>/pull/<n> or https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<n>`); `prRef` early return.
- [ ] **Step 4: role files**, each a short block headed "On Azure DevOps (a dev.azure.com PR link)":
  - builder: push the branch (never a protected branch), open the PR with `az repos pr create --repository <repo> --source-branch <branch> --target-branch <base>`, pass with its full link.
  - reviewer: `az repos pr show --id <n>` for the PR and its head (`lastMergeSourceCommit.commitId`); the code with `git fetch origin +refs/pull/<n>/merge:refs/remotes/pr/<n>` (works without the az login); GO on the board in the `cb pass` summary with the head SHA, and the same line on the PR: `az rest --method post --resource 499b84ac-1321-427f-aa17-267ca6975798 --url "https://dev.azure.com/<org>/<project>/_apis/git/repositories/<repo>/pullRequests/<n>/threads?api-version=7.1" --body @go.json` with `{"comments":[{"content":"GO at <sha>"}],"status":"closed"}`. If az says to log in: say so on the card with `cb log`; the board GO stands.
  - lead: compare the GO's SHA with `az repos pr show --id <n>` (`lastMergeSourceCommit.commitId`); merge with `az repos pr update --id <n> --status completed`; then `cb pass <id> "<what merged>" --repo <repo> --commit <merge sha>` as today. `cb tick` shows no state for Azure DevOps PRs.
- [ ] **Step 5: run the touched test files, all green**
- [ ] **Step 6: commit** `feat(board): Azure DevOps pull request links and the az steps in the role files (#3746)`

### Task 3: Protected branches per squad

**Files:**
- Modify: `db/schema.sql` (cb.squad_set validation: the allowed top-level keys and the new `protected` check)
- Modify: `cli/squad-up.ts` (`Squad.protected?: string[]`; `Launch.env?: Record<string,string>` filled by `launchFor`; `startOne` adds `--env CB_PROTECTED_BRANCHES=<list>` to `tab create`, `pane split` and `workspace create`)
- Modify: `kit/hooks/block-dangerous.mjs`
- Modify: `cli/help.ts` (squad text), `docs/ops/maintain.md` (squad file section: `protected`; release: copy the hook on the PC and the Mac)
- Test: `test/squad-kit.test.ts` (squad_set), `test/squad-up.test.ts`, `test/dangerous.test.ts` and/or `test/hook.test.ts` (whichever tests the hook today)

**Interfaces:**
- Consumes: Task 1's `planSquad`/`startOne` (unchanged signatures; `startOne(l, run, tabs, pause?)`).
- Produces: env var `CB_PROTECTED_BRANCHES`: comma-separated list, exactly the squad file's strings, set only when the list is non-empty.
- Produces: in the hook, an exported `protectedPush(cmd: string, list: string[]): string | null` (the matched branch, or null), used by the main path when the env var is set.

- [ ] **Step 1: failing tests**
  - squad_set: accepts `"protected": ["development", "releases/*", "athena-production"]`; refuses a non-array, an empty string, `-x`, a name with a space or `;`, more than 30 entries; the messages say what to fix. A squad without `protected` is unchanged.
  - squad-up: a squad with `protected` → every pane-making herdr call (tab create, pane split, workspace create) carries `--env` `CB_PROTECTED_BRANCHES=development,staging`; a squad without it → no `--env`.
  - hook (`protectedPush` and the full stdin→stdout path with the env set): blocked: `git push origin development`, `git push -u origin feat/x:development`, `git -C /r/api push origin HEAD:refs/heads/development`, `git push origin +x:development`, `git push --delete origin development`, `git push origin :development`, `git push origin releases/2026-11-12` (glob `releases/*`), and a second segment `cd x && git push origin staging`. Not blocked: `git push origin feature/development-fix`, `git push origin my-staging`, `git push origin feat/x`, `git commit -m "push to development"`, `cb tell X "git push origin development"`. With the env unset: every existing hook test unchanged.
- [ ] **Step 2: run, see them fail**
- [ ] **Step 3: code**
  - squad_set: entries 1-100 characters matching `^[A-Za-z0-9._/*][A-Za-z0-9._/*-]*$`, at most 30; error e.g. `protected: give branch names or globs like "development" or "releases/*" (letters, digits, . _ / * -), at most 30`.
  - hook: run on the message-stripped command (reuse `stripMessages`); split on `;`, `&&`, `||`, `|`, newline; in a segment where `git` (with any `-C <path>`/`-c k=v` options) is followed by `push`, take the non-option words after `push`: the first is the remote, the rest refspecs; `--delete`/`-d` makes each remaining word a destination; for `src:dst` the destination is `dst` (`:dst` too); strip a leading `+` and `refs/heads/`; a bare `src` is its own destination. A destination matches a list entry exactly, or by glob where the entry has `*` (`*` matches any run of characters, including `/`). Block with the hook's existing block JSON, reason `git push to protected branch <name>`.
- [ ] **Step 4: run the touched test files, all green**
- [ ] **Step 5: docs** (help squad text: one sentence on `"protected"`; maintain.md: the key, and that a release copies `kit/hooks/block-dangerous.mjs` to `~/.claude/hooks/` on the PC and the Mac)
- [ ] **Step 6: commit** `feat(squad): protected branches per squad, fenced by the push hook (#3746)`
