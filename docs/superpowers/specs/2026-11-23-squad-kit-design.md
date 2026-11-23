# Squad piece 2: the kit (design)

Card #3599. Follows `2026-11-22-squad-design.md` ("Piece 2: the kit"); the decisions there (Q2317, Q2318, Q2325,
"Models per role", "Agent-native board") bind this design. Ahmed started it with Q2351 (2026-11-23).

## Why

Piece 1 gave the board stages and roles, but a session still learns its job from a long generic prompt, runs with
whatever permissions the machine has, and is started by hand. The kit makes a session's role carry its instructions,
its fences and its model, and makes a whole squad start with one command, for any project.

## What it is

### 1. Role prompts: `prompts/roles/<role>.md` and `cb role <role>`

- One short file per role (lead, architect, owner, builder, reviewer, qa, investigator), each at most about 60 lines:
  what the role does, the `cb` commands it uses, when it passes and when it fails a card, what it never does.
- `prompts/roles/_common.md`: rules every role follows, taken from today's rules: one GO from a different session
  before merge; design before build; nothing heavy on the Mac (ask the lead until the PC runner exists); reviewers
  and QA never edit; no identifiers or patient data in board text; Ahmed's questions go through `cb ask`.
- The board serves the text (squad design, "Agent-native board": both machines read the same copy without copying
  files): a `cb.role_texts` table, filled from `prompts/roles/*.md` whenever the schema is applied (the VPS container
  does this on start). My call.
- `cb role <role>` prints `_common.md` then the role file (`--json` too). `cb iam --role <r>` and `cb resume` end with
  `Your role: cb role <r>`, so a session re-reads its job after a compaction.
- Project rules stay in the project's own CLAUDE.md; the kit never copies them.

### 2. Permission files: `kit/permissions/<role>.json`

- Passed at launch with `claude --model <m> --settings <file>`. They add to the project's own `.claude/settings.json`
  (which keeps the project's test commands); they never replace it.
- **Every role starts in bypass mode** (Q2362, Ahmed: "Everyone in bypass"): no permission prompts and no classifier
  stops; `squad up` passes `--permission-mode bypassPermissions`. The deny list below is the only fence. Reviewers,
  QA and investigators have Edit, Write and NotebookEdit denied, but can still change files through the shell; their
  "never edit" is a rule in their role prompt, accepted by Ahmed.
- Before release, a live check confirms that bypass still refuses the deny list (push to main, force push). If it
  doesn't, the release stops and Ahmed chooses again.
- Everyone: deny push to `main`/`master` in every spelling (`origin main`, `HEAD:main`, `+main`), force push (`-f`,
  `--force`, `--force-with-lease`). The lead lands work with `gh pr merge`, allowed for the lead only. claude-board's
  own release (fast-forward and push main) stays with Ahmed's terminal or the orchestrator outside the squad. My call.
- Also denied in every spelling: `--mirror` and `--all` anywhere in a push; `HEAD` or `@` as the pushed ref (`git push
  origin HEAD`); a push that names no branch (`git push`, `git push origin`, `git push upstream`, `git push -u`,
  `git push -u origin`); each with its `git -C <dir> push` twin. `git push -u origin feat/x` stays allowed.
- These cover the Bash tool. The whole **PowerShell tool is denied** for every role (a PC lead in bypass mode would
  otherwise have no fence there): squad sessions work through Bash.
- Reviewer, QA, investigator: also deny Edit, Write, NotebookEdit, `git commit` (and `git -C <dir> commit`), `git push`,
  `gh pr merge`.
- Builder, owner, architect: everything else; `gh pr merge` denied. Lead: `gh pr merge` allowed.
- Deny rules are the fence (the 2026-11-22 permission test): the auto-mode classifier is not.

### 3. Area files

Already on the board since piece 1 (`cb page show|set --area <name>`), versioned (Q2317). The kit only adds the
habit: the owner role keeps its area page current; every role reads the area page of the card it works
(`cb next` / `cb resume` already print it).

### 4. Squad file and `cb squad up <project>`

- The squad file names, per project: each role's count, model and machine, and the areas with their owners.
- It lives **on the board** (Q2356): a `squad` jsonb setting on the project, checked by the board when saved (known
  roles, counts within the Mac cap, known models and machines) and logged as an event on every change. `cb squad set
  <project> -f squad.json` saves it (`-` reads stdin), `cb squad show <project> [--json]` prints it in one line per
  role. The PC, the Mac and the supervisor all read the same copy; nothing is copied to the Mac.
- Model defaults come from "Models per role" (Opus for lead, architect, owner, reviewer, investigator; Sonnet for
  builder and QA); a squad file may name a different model per role.
- `cb squad up <project> [--dry-run]` (run on the PC): for each session the squad file names that isn't live
  (`cb sessions`), open a herdr pane on its machine (two panes per tab), `herdr agent start <name> --kind claude
  --pane <p> -- --model <m> --settings <kit path on that machine>`, then prompt it:
  `cb iam <name> <project> --role <r> [--area <a>] --model <m>`, `cb role <r>`, `cb next`.
- Names carry the project, because actor names are global on the board: `<project>-<R><n>@<machine>`
  (ihop-B1@macbook, ihop-R2@macbook, ihop-O-claims@macbook); the lead stays `orch@<machine>`. My call.
- Folders: the squad file gives, per machine, the project's checkout path and the board checkout path (for
  `--settings`). Each pane opens in the checkout; a builder makes its own worktree per card, as its role prompt and the
  project's CLAUDE.md say. Machine names are checked against `herdr machine list` when `squad up` runs (the board can't
  see herdr). My call.
- Every machine entry has a `herdr` key (the herdr machine name, or `null` for this PC); a missing key is refused.
  Machine keys are slugs (`^[a-z][a-z0-9-]{0,31}$`). `repo` and `board` are **absolute paths only** (`/...` or
  `C:/...`), with no spaces, `~` or shell characters: they go into a herdr command line, where `~` would not expand.
- Live means: the board saw the session in the last 90 seconds, or herdr has an agent with that name on that machine
  (a compacting session can look quiet to the board). A name that is down is started again under the same name: when
  Ahmed runs `squad up`, that is him restoring it (Q2324). My call.
- The Mac cap (8) counts every live session on the machine, all projects, not only this squad file. My call.
  The machine is recognised by its **herdr label** (`macbook`), whatever key the squad file gives it, both when the
  squad is saved and when `squad up` plans.
- It never closes or restarts a live session, never goes over the cap, and `--dry-run` prints the plan only.
  Starting and stopping on demand is the supervisor (piece 4).

### 5. The dangerous-commands hook (Q2318)

- The hook moves into the kit: `kit/hooks/block-dangerous.mjs` (Node; it needs no `.sh`), with
  `test/dangerous.test.ts`: a list of commands that must block and texts that must pass (e.g. `cb tell orch "the shutdown is planned"`, a heredoc
  that mentions `git reset --hard`).
- Only **message text** is removed before matching: the text arguments of `cb tell|ask|log|add|done|move|fail|pass`,
  `git commit -m`, `gh pr create|comment --body`, and heredocs fed to `cb`, `cat > <file>` or `git commit -F -`.
  Every other quoted string and heredoc is still checked, so `psql -c "drop table x"`, a
  heredoc into `psql`, `ssh vps1 "sudo reboot"`, `bash -c "rm -rf /"`, `node -e`, `python -c` stay blocked. My call:
  the builder check showed that stripping every quoted string would let those through.
- Patterns match **anywhere** after the message text is stripped (controller ruling: fail closed, so `ssh host
  <power-off word>`, `nohup`, `xargs` stay blocked), not only at a command start. Patterns that span words (`mv ...
  /dev/null`, force push, hard reset) stay inside one command segment: they never cross `;`, `&`, `|` or a newline.
  The power-off words are not matched inside file names (`graceful-shutdown.ts`, `shutdown.test.ts`).
- While writing this design, today's hook blocked a design edit because the text named a power-off command: the
  exact problem this fixes.
- Installed to `~/.claude/hooks/` on the PC only after Ahmed says yes **in the terminal** (Q2318), then to the Mac.

### 6. No stale-card pings on a card that waits on Ahmed (Q2357)

The hourly "has had no update" ping (`cb.pings_due`) and the pipeline's stall nudge (`cb.stage_stalls_due`) skip a
card that has an open question tied to it (status `open`, to Ahmed or to another person: either way it waits on a
person). Dormant follow-ups don't count. My call on the stall nudge and on who counts. Once he answers, the clock starts again from the answer, so a card that then sits still is pinged as before.
Pipeline-off and pipeline-on projects alike.

### 7. Shipping

The Mac copy (maintain.md) adds `kit` to its tar list; maintain.md also records that vps2's checkout is on the `vps`
branch (a release fast-forwards it to `origin/main`).

## Tests

- Every role file exists, stays short, and names only commands `cb help` knows.
- `cb role` prints common + role, refuses an unknown role, `--json` works.
- Each permission file parses and carries the push-to-main and force-push denies; read-only roles deny Edit/Write.
- Squad file: saved only when valid (known roles, counts within the cap, known models); `cb squad show`.
- `cb squad up --dry-run` prints the right plan for a sample squad without calling herdr.
- `test-dangerous.sh`: every must-block line blocks, every must-pass line passes.
- One live check by hand before release, in a throwaway repo with a local remote: `cb squad up` starts one builder and
  one reviewer on the Mac in bypass with their model and permission file; the builder's `git push origin main` and
  `git push --force` are refused, the reviewer's Edit is refused.

## Not in this piece

The PC job runner (piece 3), the supervisor that starts and closes sessions by itself (piece 4), a dashboard editor for
the squad file.
