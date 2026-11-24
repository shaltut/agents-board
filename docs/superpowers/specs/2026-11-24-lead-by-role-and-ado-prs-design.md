# A project's lead by role, and Azure DevOps pull requests (card #3746)

## Why

The QHS squad runs on the PC (Ahmed, 24 Nov), and it hit two limits of the board:

1. **No lead.** `cb squad up` always names the lead `orch@<machine>`. `orch@shaltoot` already leads ihop-squad,
   and one session name belongs to one project, so QHS started without one. QO@shaltoot now leads QHS by role
   (`cb iam QO@shaltoot qhs --role lead`). The pipeline gates (merge, restage, digest, squad set, job cancel)
   already go by role, but six older places still find "the orchestrator" by the `orch@` name.
2. **Azure DevOps.** QHS repos live on Azure DevOps. For a card with repos, `cb pass` at build accepts only
   `https://github.com/<o>/<r>/pull/<n>`, and the lead, reviewer and builder role files speak only `gh`.

Ahmed: "then start" this card, bundling both.

## Goals

- Any session whose role is `lead` in a project is that project's lead everywhere on the board, whatever its name.
- `cb squad up` treats a live lead-role session in the project as the lead and starts none. When it must start
  a lead and `orch@<m>` belongs to another project, it starts `<project>-orch@<m>`.
- A builder can pass build with an Azure DevOps PR link. Reviewers and the lead know how to read, GO and merge one.

## Non-goals

- No Azure DevOps state lookups in `cb tick` (open, merged, head moved). GitHub PRs keep theirs; an Azure DevOps
  PR simply gets no tick lines. The lead checks the head by hand before merging, as the role file says.
- No change to how the board stores PRs (`links.pr`, `task_parts.pr` stay one URL).
- No rename of existing leads. `orch@shaltoot` stays ihop-squad's.

## Anti-goals

- A second session that thinks it is a project's lead without anyone choosing it. Only `cb iam --role lead`
  (Ahmed's or the lead's own choice) or `cb squad up` makes one.
- A tick line that tells the lead to run `gh` against an Azure DevOps PR.

## Approaches

**The lead**
- **A. By role (my pick).** Replace each `orch@` name test with `cb._role(actor) = 'lead'`. `cb._role` already
  counts an `orch@` name with no role as the lead, so nothing that works today changes.
- B. By a wider name pattern (`orch%@%`, lead named `orch-qhs@shaltoot`). Smaller diff, but it keeps the board's
  meaning in session names, and QO would still not count.

**Azure DevOps**
- **A. Accept the link, merge by hand with `az` (my pick).** The pass check accepts
  `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<n>`. The role files gain the `az` lines.
- B. Also teach `cb tick` Azure DevOps state through `az repos pr show`. Every tick then needs Ahmed's QHSLab
  login; when it lapses, tick errors. Worth it only if QHS PRs pile up.

## Design

**Lead by role** (`db/schema.sql`, `cli/squad-up.ts`, `cli/cb.ts`, `cli/help.ts`):
- `cb.triagers`, the inbox answer copies, the stale-card nudge copy, huddle admin and the "review held by a
  person" exemption test `cb._role(x) = 'lead'` instead of `like 'orch@%' or = 'orch'`. Job cancel already does.
- `cb bug`'s "(no orchestrator there)" note tests the role the same way.
- `planSquad`: the lead counts as live when any live session of this project has role `lead`
  (the live rows gain `role`). When none does and `orch@<m>` is live in another project, the plan starts
  `<project>-orch@<m>` instead of printing "lead name held". The supervisor still never starts a lead.
- `squad_set`'s 32-character name check also measures `<project>-orch@<m>`.

**Azure DevOps** (`db/schema.sql`, `cli/tick.ts`, `prompts/roles/*.md`, `cli/help.ts`):
- `cb.pass` at build (card with repos): the URL may be a GitHub PR or an Azure DevOps PR, same anchoring.
  The error names both forms.
- `prRef` in tick returns nothing for an Azure DevOps link, even when `GITHUB_REPO_<PROJECT>` is set, so it
  never asks `gh` about the wrong repo.
- Role files, one short block each, "On Azure DevOps (a dev.azure.com link)":
  - builder: push the branch, open the PR with `az repos pr create`, pass with its full link.
  - reviewer: read it with `az repos pr show --id <n>` and the code with
    `git fetch origin +refs/pull/<n>/merge:refs/remotes/pr/<n>` (works without the az login); the GO goes in
    the `cb pass` summary with the head SHA (`lastMergeSourceCommit`).
  - lead: compare that SHA with `az repos pr show`, then `az repos pr update --id <n> --status completed`.
- The `az repos` lines need Ahmed's QHSLab-tenant `az login`. That is a precondition, not code.

## Questions for Ahmed

1. **Push guard for QHS branches.** The kit blocks pushes to `main` and `master` only. A QHS builder in bypass
   mode could push straight to `development`, `staging` or a bot's `*-production` branch. Add a per-squad
   `"protected": [...]` list that the kit's hook also blocks? (Recommended: yes, in this card.)
2. **Where the GO lives for Azure DevOps.** On the board only (no login needed to review), or also as a PR comment
   through `az rest` (needs the login for every review)? Recommended: board only.

## Tests (each file the change touches)

- `test/squad-up.test.ts`: lead live by role under another name → not started; `orch@m` held elsewhere →
  `<project>-orch@m` started; today's ihop-squad plan unchanged.
- `test/squad-kit.test.ts`: the name-length check with a long project name.
- A schema test per changed function: a lead-role session not named `orch@` triages bugs, gets answer copies,
  admins a huddle, and its own review card is not "unreviewed"; an `orch@` session with no role still does.
- `cb.pass` takes an Azure DevOps link at build for a card with repos, refuses a malformed one.
- tick: an Azure DevOps link yields no PR ref with `GITHUB_REPO_<P>` set.

## What is left to the builder

Exact wording of the role-file blocks and help lines; test names; where in `squad-up.ts` the role is read.
