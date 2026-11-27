# agy (Antigravity CLI) adapter design

Card #4002, phase 5 · 2026-11-26 (fix round 1 applied) · A trial. Status: built, nothing reaches a live squad (`cb.squad_set` still refuses non-Claude primary agents).

Verified on this PC (agy **1.5.17**, read-only): `agy --version`, `agy --help`, `herdr agent start|prompt --help`; agy's own builtin docs (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`: PreToolUse input/output contract; `antigravity_guide/references/cli.md`: `/exit`); strings in `agy.exe`; a real overnight `.agents/hooks.json`; `settings.json` keys; `herdr agent prompt <missing> "-x"` answers `agent_not_found` (a leading `-` is accepted as the text). **Not verified here:** that a workspace `.agents/hooks.json` loads and which tool names a real run emits (docs and report E only), the matcher semantics, that `/exit` works through herdr, and any live agy behaviour. No agy session was started. Research notes are kept outside the repo.

Files: `cli/agents/agy.ts` (`createAgyAdapter(run)` takes the herdr Runner; `agyAdapter` uses `realRun`), `kit/guard/shim-agy.mjs`, `kit/agy/settings.json`, tests `test/agents-agy.test.ts`, `test/guard-agy.test.ts`.

## The 12 members (U = unverified: inferred from report E or strings, not seen on a live agy)

| Member | agy | Evidence |
|---|---|---|
| `kind`, `relayStart` | `'agy'`, `'pane-prestart'`: no inbox socket, no session hook can hand a relay anything | no external TUI API (report E 4.2) |
| `buildLaunch` | `--mode auto --settings <board>/kit/agy/settings.json [--model <m>]`. Env: squad env minus `CLAUDE_CODE_*`, `ANTHROPIC_*`, `CLAUDECODE`, `GITHUB_PERSONAL_ACCESS_TOKEN` (any case), plus `AGY_CLI_DISABLE_AUTO_UPDATE=true`. No `--agent` (Open 2). `--model ''` omitted. Never `--dangerously-skip-permissions` | `agy --help` for the three flags |
| model check | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, not the four bare aliases `opus/sonnet/haiku/fable` (spec section 3, same as `cb._check_model`). Ruling: agy serves Claude-family ids (`claude-opus-5-5-medium` is valid); the rule is the four aliases. `defaultModelFor('agy', _)` stays `null` | spec section 3 |
| `deliver` | `herdr agent prompt <herdrName> <text>` on `seat.herdr`, text verbatim (`opts.raw` changes nothing). agy queues while busy (`queuedMessages "queue"`, pinned in `kit/agy/settings.json`, U). herdr refuses a blocked agent (`agent_blocked`) before sending a byte: that throws, the relay retries. No text mutation: `-` is accepted by herdr (verified); the slash-autocomplete swallowing was fixed in agy 1.1.9 (report E, collaborator; U on 1.5.17) | `herdr agent prompt`; report E |
| `isAlive` | `herdr agent get <name>` via the shared `classifyAgentGet`: exit 0 alive, `agent_not_found` gone, else alive | same helper as `cli/squad-up.ts` |
| `readStatus` | herdr `agent_status`: idle/working/blocked/done, else `unknown`; safe to close = idle or done, with a detail that background subagents may still run | `herdr --skill` |
| `close` | `herdr agent prompt <name> /exit`. `/exit` is documented in agy's cli.md but **unverified through herdr on a live agy**, so `sent` means submitted, not exited. The supervisor must confirm closure through `isAlive` (today `cli/supervise.ts:202` trusts `sent`: Integration) | cli.md:24 |
| `detectQuotaStop` | Only the last 6 non-empty lines. Quota: `exhausted your quota on this model`, a line `[AI: ]Out of credits`, `prepaid balance is insufficient`, `spend cap reached/exceeded/hit` (U). Rate limit: `rate limit active for <model>` (with `retry in Ns`), a line starting `429` or `RESOURCE_EXHAUSTED`. A `429` or "rate limit" inside normal output is not a stop | strings in `agy.exe`; changelog 1.5.10 via report E |
| `guardInstallSpec` | **Per seat**, never the global `~/.gemini/config/hooks.json` (that applies to every agy session on the machine, the owner's included). Target: `.agents/hooks.json` in the seat's workspace (cwd), kept out of git via `.git/info/exclude`. Matcher `.*` (catch-all; the overnight run used it). Hooks inside the `--settings` file are not an option: report E 4.3 says hooks in `settings.json` are not loaded. Workspace hooks load only after trust (U) | hooks.md; overnight `hooks.json`; report E |
| `instructionMapping` | `AGENTS.md`, `GEMINI.md` (rules.md), `.agents/rules/*.md`, `~/.gemini/AGENTS.md`, `~/.gemini/config/rules/*.md` (the last three U); **not** `CLAUDE.md` | report E 4.4 |
| `trustSpec` | dialog hint "Do you trust the contents of this project?" (U: report E, not seen); preseed `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces`, native Windows paths (e.g. the user's home folder, verified). Never written here | settings.json |
| `disableAskSpec` | tool `ask_question` (U), hook, target `kit/guard/shim-agy.mjs` | report E |

## The guard shim

Input `toolCall {name, args}` plus `cwd` and `workspacePaths` (hooks.md common fields). Output `{"decision":"allow"}` or `{"decision":"deny","reason":"Blocked ..."}`, exit 0; `{}` counts as a deny in agy, so allow is printed explicitly (exact-string test). agy's `allow` means *auto-approve*, so every allow is a decision and a tool the shim cannot judge is a deny.

The hook is installed with a catch-all matcher, so **every tool reaches the shim**, which judges only listed names (the sets are exported; `test/guard-agy.test.ts` checks them against `guardInstallSpec`):
- shell `run_command` (`args.CommandLine`) goes through `core.evaluate`.
- edit `write_file`, `edit_file`, `write_to_file`, plus `replace_file_content`, `multi_replace_file_content` (strings in `agy.exe`, U): role rule from core, then confinement.
- read `read_file`, `view_file` (names from agy's builtin skills and hooks.md examples): allowed for any seat when the path passes the confinement below.
- `ask_question`: denied unless `CB_ALLOW_ASK=1`.
- `send_command_input`: **denied for every role** until a hook log confirms its text field, then it can be judged as shell (stdin into a running interpreter would bypass `core.check`).
- anything else (`list_dir`, `grep_search`, `search_web`, subagents, MCP, case variants): deny.

**The first live check must capture the real tool names from a hook log and fill these sets; until then an agy seat will be refused tools it needs, on purpose.**

Edit confinement: the target comes from a `TargetFile`, `AbsolutePath`, `FilePath`, `path` or `file_path` arg (all five unconfirmed; any other name, or a missing, empty or non-string value, denies; every given arg must pass). It is resolved against the hook's `cwd`, realpath'd (a symlink out of the workspace is caught), and denied outside the workspace (`workspacePaths[0]`, else `cwd`) or inside `.git`, `.agents`, `.gemini` (any depth) or `kit/guard`. A pane with neither `CB_ROLE` nor `CB_AGENT` is denied with a reason naming the board guard, because the hook file is per seat; one with `CB_AGENT` but no `CB_ROLE` is denied too (#4392: squad up sets both, and core applies no secret or fence rule to a null role). Reads get the same confinement (same path args, cwd, realpath, outside-the-workspace deny, missing or non-string path or no cwd denies): inside `.git` stays readable, inside `.gemini`, `.agents` and `kit/guard` is denied. Deny segments are compared folded to lower case on every platform; on Windows also without trailing dots and spaces and without anything from `:` on (NTFS streams). A read or edit whose path arg names a secret file (core's `secretPath`, #4347), as given or as resolved through a link, is denied (#4392). MCP: agy has no per-run way to start without the servers in `~/.gemini/config/mcp_config.json` or a plugin, so that is an install gate (`mcpOff` in `cli/agents/agy.ts`).

Known limits: shell commands that write or read files are unconfined here (the shell rules in core are the fence); a dangling symlink as the leaf of a path is judged by its literal path; the `cwd` and `workspacePaths` fields are assumed from hooks.md until a hook log shows them (a missing one denies).

## What this means for squads (sandbox)

The sandbox blocks writes outside the workspace, including a worktree's git dir (`.git/worktrees/<name>/index.lock`), so **an agy seat cannot `git commit` in a git worktree** (overnight run). Builder seats on agy need a full clone as cwd, or another seat commits for them. Reviewer, QA and investigator seats are read-only, so they are the natural first agy roles. `kit/permissions/<role>.json` has no agy counterpart: the role fence is the hook.

## Integration (outside my files)

- `cli/agents/index.ts`: done. `test/agents.test.ts`: the registry test no longer lists `agy` as not installed; the controller resolves the three-way conflict.
- Seat launcher (`cli/squad-up.ts`): before starting an agy seat, write `<cwd>/.agents/hooks.json` (group `cb-guard`, `PreToolUse`, matcher `.*`, `node <abs>/shim-agy.mjs`, timeout 10, forward slashes, no quotes: Windows runs hooks through `cmd /c`, and before agy 1.5.8 a quoted hook command was silently skipped), add `.agents/` to `.git/info/exclude`, pre-seed `trustedWorkspaces`, and have `agy` on PATH. Pane env already carries `CB_ROLE`, `CB_AGENT`, `CB_PROTECTED_BRANCHES`.
- `kit/guard/install.mjs`: add `shim-agy.mjs` to `GUARD_FILES` and agy-shaped probes (`toolCall` shape, expect `{"decision":"allow"}`, plus an unlisted tool and `send_command_input` expecting deny); re-run on every agy bump.
- `cli/supervise.ts`: after `close` returns `sent`, confirm with `isAlive` before treating the seat as closed. `cb.squad_set` keeps refusing agy as primary until Ahmed lifts it.

## Open

1. **Data terms (owner).** The seat runs on the owner's personal Google account; consumer terms say "Interactions" may train Google products and be human-reviewed, and use "in connection with products not provided by us" is a breach (report E 3, 4.9). No client repo until Ahmed settles it; no project allow list here.
2. `--agent <role>` (custom `agent.md`, `inheritCustomizations: false`) is unused: it needs per-role files; the fence is the hook and the first prompt.
3. Status: herdr's scraper was tuned on agy 1.2.17. The `statusLine` JSON (`agent_state`, `tool_confirmation_pending`, `quota`) and OSC 7501 would be exact, but the script runs on the seat's machine and a Mac seat's file is not visible to the board host; it needs a herdr `report-agent` bridge.
4. Nothing was run against a live agy: `deliver`, `/exit`, the workspace hook loading, matcher semantics, `--settings` merge-or-replace and `kit/agy/settings.json` are all untested.
5. Tool names and path-arg names (see the shim): fill from a real hook log, then add `send_command_input` as shell and the read tools that exist.
