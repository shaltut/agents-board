# Codex Adapter Design

Card #4002 · 2026-11-26 · Phase 2 of 5 · Status: built, not live (the squad file still refuses non-Claude primary agents).

Implements `cli/agents/codex.ts`, `kit/guard/shim-codex.mjs`, `test/agents-codex.test.ts`, `test/guard-codex.test.ts`. Starting point: section 2 of `2026-11-26-agent-neutral-core-design.md`; every flag below was checked against the installed CLI.

## Verified on this machine (read-only: `--version`, `--help`, config and binary strings; no Codex session was started)

- `codex --version` on PATH printed `codex-cli 0.160.0`; the binary under `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` is `0.166.0`; `~/.codex/version.json` names 0.167.0 as latest. Two installs: the one herdr launches is whichever `codex` is first on its PATH (open question 5).
- `codex --help`: `--no-daemon`, `-m`, `-a never|on-request`, `-s read-only|workspace-write|danger-full-access`, `-c key=value` (TOML, literal fallback), `-p` is a **profile file** (`$CODEX_HOME/<name>.config.toml`), not a role name, `--dangerously-bypass-hook-trust`, `queue --thread --message`.
- `herdr 0.9.5`: `agent start|prompt|get|read|send-keys|wait`; `agent prompt` is rejected with `agent_blocked` while a dialog is open.
- Binary strings (0.166): `check_for_update_on_startup`, `shell_environment_policy`, `project_doc_fallback_filenames`, `sandbox_workspace_write.network_access`, `request_user_input`, the "Hooks need review" and "Update available" dialogs, the hook JSON fields, and the limit messages used by `detectQuotaStop`.
- `~/.codex/hooks.json` today holds only herdr's `SessionStart` entry (managed by herdr, "add custom hooks beside this file"); `[features] hooks = true` is set; `warp@codex-warp` is `enabled = false` and nothing here touches it.

## The 12 members

| Member | Codex behaviour | Evidence |
|---|---|---|
| `kind` / `relayStart` | `codex` / `pane-prestart`: Codex has no inbox socket and its only hook (SessionStart) is herdr's, so the board's relay starts with the pane. | hooks.json |
| `buildLaunch` | `--no-daemon -m <model> -a never -s <read-only for reviewer, qa, investigator; else workspace-write>` plus `-c` for: network on in workspace-write, `shell_environment_policy.exclude=['GITHUB_PERSONAL_ACCESS_TOKEN','CLAUDE_CODE_*']`, `check_for_update_on_startup=false`, `project_doc_fallback_filenames=['CLAUDE.md']`. `env` is the launch env minus `GITHUB_PERSONAL_ACCESS_TOKEN` and `CLAUDE_CODE_*` (any case). Empty model: no `-m`. A Claude name or a non-matching name throws. Not used: `-p <role>` (needs a profile file), `--dangerously-bypass-hook-trust`, `--approve-for-me`. | `--help` |
| `deliver` | `herdr agent prompt <herdrName> <text>`, 15 s cap, throws on any failure (relay then retries). The text is never in an error. `codex queue --thread` is not used: it needs a thread id the board does not have. | herdr help |
| `isAlive` | `herdr agent get <name>`: exit 0 or unknown counts alive, only `agent_not_found` is dead (`classifyAgentGet`, same rule as the supervisor). | squad-up.ts |
| `readStatus` | herdr `agent_status`; `safeToClose` only for idle/done. A startup dialog reads blocked, so it is never closed. | supervise-plan |
| `close` | `herdr agent prompt <name> /exit` (`/exit` and `/quit` both exist in the binary). A busy turn queues it, so the supervisor's `safeToClose` check stays the gate. | binary |
| `detectQuotaStop` | quota: "You’ve hit your usage limit…", "Your workspace is out of credits", "You hit your spend cap"; `retryAfterSec` only for "try again in N hours/minutes" (a clock time gives none). rate_limit: "exceeded retry limit, last status: 429" and "Automatically switched to <model> due to usage limits" (a model switch, not a stop: Phase 4 decides). Plain "rate limit" words are not matched: a pane tail holds model prose. | binary |
| `guardInstallSpec` | `~/.codex/hooks.json`, `PreToolUse`, matcher `^(Bash\|apply_patch\|request_user_input)$` on every platform, shim `kit/guard/shim-codex.mjs`. | binary |
| `instructionMapping` | native `AGENTS.md` and `~/.codex/AGENTS.md`; `CLAUDE.md` as fallback filename (used only where a folder has no AGENTS.md). | binary |
| `trustSpec` | extra arg `-c check_for_update_on_startup=false` pre-empts "Update available". "Hooks need review" is not pre-empted and **never answered by the board**: the seat parks as `agent_not_ready` until Ahmed trusts the hooks. `preseedPath` `~/.codex/config.toml` (`[projects.'<path>'] trust_level = "trusted"`, already set for the iHop and board checkouts). | binary, config |
| `disableAskSpec` | `request_user_input` via the same hook (shim tool `ask`, `CB_ALLOW_ASK=1` lifts it). | binary |

## The guard shim

Input (Codex `PreToolUse`): `{session_id, turn_id, hook_event_name, tool_name, tool_input, tool_use_id, ...}`. `Bash` and `PowerShell` need a string `tool_input.command` (shell); `apply_patch`, `Edit`, `Write` are edit; `request_user_input` is ask. Anything else blocks, including a missing `tool_name` (Claude's omitted-name leniency is not copied), an MCP tool, and a `hook_event_name` other than `PreToolUse`.
Output: allow prints `{}` (Codex rejects `permissionDecision:allow`); block prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`, exit 0. The binary also accepts exit 2 with the reason on stderr; the JSON form is used so a reason is never lost. Fail-closed paths are the same as `shim-claude.mjs` (no static local import; a missing core blocks).

## Open

1. **Live check needed:** `request_user_input` as a `PreToolUse` matcher target and the shell tool's `tool_name` on Windows (`Bash` assumed, `PowerShell` also accepted). If either differs, the shim blocks loudly rather than allowing.
2. **Sandbox vs the board:** `-s workspace-write` with `-a never` may stop a seat reaching the relay pipe/socket or `git push`. Network is opened for non-read-only roles (egress: owner's call); a reviewer under `read-only` may not even be able to run `cb`. One live run settles it.
3. **Quoting:** herdr types the args into the pane's shell. The `-c` values use TOML literal single quotes so no double quote has to survive PowerShell or zsh; confirm with one real `herdr agent start`.
4. **Model names:** none are defaulted (`defaultModelFor('codex', ...)` stays null, matching `cb._role_model`). The owner names them in the squad file.
5. Two Codex installs (0.160 on PATH, 0.166 packaged): the `Update available` text and flags were read from 0.166.

## Integration (outside my files)

- `cli/squad-up.ts`: `trustSpec().dialogHint` is already shown; nothing else. It does not apply `instructionMapping().extraArgs`, which is why `buildLaunch` includes them itself.
- `kit/guard/install.mjs`: add `shim-codex.mjs` to `GUARD_FILES`; add probes for the deny object (`git reset --hard` blocks, `ls` gives `{}`, `not json` blocks); a hooks.json writer that merges one `PreToolUse` entry (command `node <abs>/shim-codex.mjs`, matcher from `guardInstallSpec`) and **leaves herdr's SessionStart entry and the warp plugin alone**. After it, hooks.json changes hash, so the next start shows "Hooks need review": trusting it (or `trusted_hash` in `[hooks.state]`) is Ahmed's step, never the installer's.
- `db/schema.sql`: Phase 1's gate lifts with a one-line flip once Ahmed agrees; `cb._check_model` already encodes the codex model rule.
- `cli/relay.ts` / `cb relay --agent codex`: needs the `pane-prestart` start path (the relay launched by the pane, not by a hook).
