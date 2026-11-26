# agy (Antigravity CLI) adapter design

Card #4002, phase 5 · 2026-11-26 · A trial. Status: built, nothing reaches a live squad (`cb.squad_set` still refuses non-Claude primary agents).

Checked on this PC: `agy --version` = **1.5.17**, `agy --help`, `herdr agent start|prompt --help`, agy's own builtin docs (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`, `.../antigravity_guide/references/cli.md`), strings in `agy.exe`, a real `.agents/hooks.json` from the 25-26 Nov overnight run, and `~/.gemini/antigravity-cli/settings.json` (keys only). No agy session was started. Research: phase 0 report E (`C:/w/agents-research/E-antigravity.md`).

Files: `cli/agents/agy.ts` (the adapter; `createAgyAdapter(run)` takes the herdr Runner so tests inject a fake, `agyAdapter` uses `realRun`), `kit/guard/shim-agy.mjs`, `kit/agy/settings.json`, tests `test/agents-agy.test.ts`, `test/guard-agy.test.ts`.

## The 12 members

| Member | agy | Evidence |
|---|---|---|
| `kind`, `relayStart` | `'agy'`, `'pane-prestart'`: agy has no inbox socket, no session hook can hand a relay anything | no external TUI API (report E 4.2) |
| `buildLaunch` | `--mode auto --settings <board>/kit/agy/settings.json [--model <m>]`. Env: the squad env minus `CLAUDE_CODE_*` and `GITHUB_PERSONAL_ACCESS_TOKEN` (any case), plus `AGY_CLI_DISABLE_AUTO_UPDATE=true`. No `--agent` (see Open). `--model ''` is omitted. Never `--dangerously-skip-permissions`. | `agy --help`: `--mode (accept-edits, auto, plan)`, `--settings ... never saved: a JSON object ... inline or as a file path`, `--model` |
| model check | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, not `opus/sonnet/haiku/fable` (same rule as `cb._check_model`). `claude-opus-5-5-medium` passes: agy serves Claude ids, and only the bare aliases are copy-paste errors. `defaultModelFor('agy', _)` stays `null` (`cb._role_model`), so a squad file without a model launches agy's own default | spec section 3 |
| `deliver` | `herdr agent prompt <herdrName> <text>` on `seat.herdr`: bracketed paste plus Enter. agy queues it while busy (`queuedMessages: "queue"`, which `kit/agy/settings.json` pins). herdr rejects a blocked agent (`agent_blocked`) before sending a byte: that throws, the relay keeps the message. A text starting `-` (clap flag) or `/` (slash autocomplete) gets one leading space | `herdr agent prompt --help`; report E 4.2 |
| `isAlive` | `herdr agent get <name>` through the shared `classifyAgentGet`: exit 0 alive, `agent_not_found` gone, anything else alive (never kills a healthy relay) | same helper `cli/squad-up.ts` uses |
| `readStatus` | herdr's `agent_status` (screen scraping): idle/working/blocked/done, else `unknown`. Safe to close = idle or done, with a detail line that background subagents may still run | `herdr --skill` says agy can be idle with background tasks |
| `close` | `herdr agent prompt <name> /exit` (`/exit` or `/quit` is in agy's CLI guide). A seat with no herdr name is `failed` | `antigravity_guide/references/cli.md:24` |
| `detectQuotaStop` | quota: `exhausted your quota on this model`, `Out of credits`, `prepaid balance is insufficient`, spend cap. Rate limit: `rate limit active for ... retry in Ns` (gives `retryAfterSec`), `RESOURCE_EXHAUSTED`, `429` | strings present in `agy.exe` 1.5.17; changelog 1.5.10 |
| `guardInstallSpec` | target `~/.gemini/config/hooks.json` (global, so it needs no per-repo trust), shim `kit/guard/shim-agy.mjs`, one matcher on every platform: `run_command\|write_file\|edit_file\|write_to_file\|replace_file_content\|multi_replace_file_content\|ask_question` | hooks.md; overnight `hooks.json` shape (group, `PreToolUse`, `matcher`, `hooks[{type,command,timeout}]`) |
| `instructionMapping` | native files `AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md` and the `~/.gemini` globals; **not** `CLAUDE.md`. No extra args or env | report E 4.4 |
| `trustSpec` | dialog "Do you trust the contents of this project?"; preseed `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces`, which holds **native Windows paths** (this PC: `["C:\\Users\\Fast_"]`). Nothing is written by the adapter | settings.json read |
| `disableAskSpec` | tool `ask_question`, mechanism `hook`, target `kit/guard/shim-agy.mjs` (core's `ask` rule, `CB_ALLOW_ASK=1` lifts it) | report E |

## The guard shim

Input `toolCall {name, args}`; `run_command` carries `args.CommandLine` (hooks.md example). Mapping: `run_command` -> shell; `write_file`, `edit_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content` -> edit; `ask_question` -> ask. Only the first three names are in report E; the last three are tool names present in `agy.exe` and not confirmed as edit tools. Output `{"decision":"allow"}` or `{"decision":"deny","reason":"Blocked ..."}`, exit 0, reason prefixes as in `shim-claude.mjs`. **`{}` counts as a deny in agy, so allow is printed explicitly** (pinned by an exact-string test). It fails closed like the Claude shim: empty or bad input, no `toolCall`, no string `CommandLine`, an unknown tool (also `read_file`: the matcher decides what reaches the shim), an unknown `CB_ROLE`, a missing or throwing `core.mjs`, a verdict-less core. Claude's `tool_name`/`tool_input` shape is itself rejected.

One semantic difference: agy's `allow` means *auto-approve this call* (hooks.md), not Claude's "no opinion". Under `--mode auto` that is the intended state, but it also skips agy's own reviewer for a call the guard allows. Say so before the shim is wired anywhere with a stricter mode.

## What this means for squads (sandbox)

The sandbox blocks writes outside the workspace, including a worktree's git dir (`.git/worktrees/<name>/index.lock`), so **an agy seat cannot `git commit` in a git worktree** (seen in the overnight run). Builder seats on agy need a full clone as their cwd, or another seat commits for them. Reviewer, QA and investigator seats are read-only and are unaffected, so they are the natural first agy roles. `kit/permissions/<role>.json` has no agy counterpart: the role fence is the hook only.

## Integration (outside my files)

- `cli/agents/index.ts`: done (one import, one line in `getAdapter`). `test/agents.test.ts`: the registry test no longer lists `agy` as not installed (one array edit; the other two phases edit the same line, so expect a trivial merge).
- `kit/guard/install.mjs`: `GUARD_FILES` must add `shim-agy.mjs`; the 6 probes use Claude's input shape, so add agy probes (`toolCall` shape, expect `{"decision":"allow"}`); then write the hooks.json group `cb-guard` (`PreToolUse`, matcher from `guardInstallSpec`, `node <abs>/shim-agy.mjs`, timeout 10, forward slashes, no quotes: Windows runs hooks through `cmd /c`; before agy 1.5.8 a quoted hook command was silently skipped, so re-run the probes on every agy bump).
- `cli/squad-up.ts`: `--kind agy` and the pane env (`CB_ROLE`, `CB_AGENT`, `CB_PROTECTED_BRANCHES`) already come from `launchFor`; the pane must have `agy` on PATH (`%LOCALAPPDATA%\agy\bin`); pre-seed `trustedWorkspaces` or park as `agent_not_ready`.
- `cli/relay.ts` / `cli/supervise*.ts`: a `pane-prestart` relay is started with the pane and calls `deliver`; supervisor close uses `adapter.close` (done) and `adapter.readStatus` (done). `cb.squad_set` keeps refusing agy as primary until Ahmed lifts it.

## Open

1. **Data terms (owner).** The seat runs on the owner's personal Google account; consumer terms say "Interactions" may be used to improve Google products and reviewed by people, and that using the service "in connection with products not provided by us" is a breach (report E 3, 4.9). No client repo until Ahmed settles it; no project allow list is added here. A Google Cloud pay-as-you-go project is the report's suggested alternative.
2. `--agent <role>` (custom agent with `agent.md`, `inheritCustomizations: false`) is not used: it needs per-role files under `~/.gemini/config/agents/`; the role fence is the hook and the first prompt.
3. Status: herdr's scraper was tuned on agy 1.2.17. The `statusLine` JSON (`agent_state`, `tool_confirmation_pending`, `quota`) and OSC 7501 would be exact, but the script runs on the seat's machine and a Mac seat's file is not visible to the board host; wiring it needs a herdr `report-agent` bridge. Check `herdr agent explain` after each agy bump.
4. `herdr agent prompt --wait` and a leading-space text were not run against a live agy (rule: no sessions). Bracketed paste is documented to work from 1.3.1.
5. Edit-tool names beyond `write_file`/`edit_file`, and `send_command_input` (stdin into a running command, unguarded): confirm from a hook log of a real run.
6. `kit/agy/settings.json` (`queuedMessages` only) was not loaded by a live agy; `--settings` merge-or-replace semantics are undocumented.
