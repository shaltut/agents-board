# OpenCode adapter design (card #4002, phase 3)

Status: implemented in `cli/agents/opencode.ts`, `kit/guard/shim-opencode.mjs`; not reachable from a live squad (`cb.squad_set` still refuses non-Claude primary seats).

## Verified on this machine (read-only)

- `opencode --version` = **1.19.4** (scoop, `~/scoop/apps/opencode/1.19.4/opencode.exe`). The spec says "OpenCode v2"; the installed version is 1.19.4, so this note follows the installed binary.
- `opencode --help`: `[project]` positional, `--port`, `--hostname` (default 127.0.0.1), `-m/--model provider/model`, `--agent`, `--auto` ("auto-approve permissions that are not explicitly denied"), `--pure`. `opencode serve --help` has the same server flags. `run --attach/--password/--username`.
- Strings in the binary (not run): both route families exist: v1 `/global/health`, `/session/status`, `prompt_async`; v2 `/api/session`, `/api/session/:id/prompt`, `/api/session/:id/interrupt`, `/api/session/active`, `/api/session/:id/question`. Env names `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`. Docs (opencode.ai/docs/server) describe the v2 routes only; the request bodies are NOT verified against a live server (the brief forbids starting one).
- `~/.config/opencode/opencode.jsonc`: provider `freellmapi`, model `freellmapi/auto`. `AGENTS.md` there exists on purpose. Plugin API (`@opencode-ai/plugin` 1.18.34 types): `tool.execute.before(input{tool,sessionID,callID}, output{args})`, `permission.ask`.
- `herdr agent start --help`: `--kind opencode` is a supported kind; herdr runs the bare executable `opencode` with the args after `--`.

## The 12 members

1. `kind` = `opencode`. 2. `relayStart` = `pane-prestart`: the endpoint file (port, password) must exist before the agent starts, so the relay is up first.
3. `buildLaunch`: `--kind opencode -- <cwd> --hostname 127.0.0.1 --port <p> -m <provider/model> --auto`. Env: the caller's env minus `GITHUB_PERSONAL_ACCESS_TOKEN` and `CLAUDE_CODE_*`, plus `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1` and `OPENCODE_DISABLE_AUTOUPDATE=1`. Throws on: a model not matching the spec regex (`provider/model`), a missing or out-of-range `CB_OPENCODE_PORT`, a missing `OPENCODE_SERVER_PASSWORD` (a seat nobody can reach is not started). No `--agent`: no per-role OpenCode agents exist yet (open).
   **The freellm wrapper is not in this path.** `herdr agent start --kind opencode` executes `opencode` directly, so `~/.local/bin/freellm.ps1` (folder guard) cannot be invoked from `LaunchSpec`. Instead `freellmRefusal(cwd)` mirrors the wrapper's folder rule (under `F:\Work` only TactiAI and arabcomputers) and `buildLaunch` throws for a `freellmapi/*` model there. This is a copy of the wrapper's rule, not the wrapper: if the wrapper changes, the copy must too. A non-freellmapi provider is not subject to the folder rule (its own data terms apply).
4. `deliver`: v1 `GET /session` (newest by `time.updated`), then `POST /session/<id>/prompt_async` body `{parts:[{type:'text',text}]}`, Basic auth (`opencode:<password>`), 5 s timeout, loopback only, port and password from `cb-seat-<seatKey>.opencode.json` (0600, atomic write, same shape as Claude's endpoint file). The spec's v2 `POST /api/session/{id}/prompt` exists in the binary but its body is unknown; v1 was chosen because its body is documented and stable.
5. `isAlive`: `GET /global/health`. A refused connection or a missing endpoint file is dead; a timeout or any HTTP status (even 401) is alive (same "unknown counts alive" rule as Claude).
6. `readStatus`: herdr's `agent_status` (herdr's OpenCode plugin v13 already reports it: `~/.config/opencode/plugins/herdr-agent-state.js`); `safeToClose` = idle or done.
7. `close`: `herdr agent prompt <herdrName> /exit` through the Runner (TUI slash command), 30 s. Not live-checked.
8. `detectQuotaStop`: pane-tail regexes. Quota: `FreeUsageLimitError`, `insufficient_quota`, `usage|free limit reached|exceeded`, `quota exceeded|exhausted`, `out of credits`. Rate limit: `rate limit`, `429`, `too many requests`, `retrying in N`. `retryAfterSec` parsed from "retry/try again in|after N s|min". Patterns are from the spec and OpenCode's error names, not captured pane text.
9. `guardInstallSpec`: `~/.config/opencode/plugins/cb-guard.js`, shim `kit/guard/shim-opencode.mjs`, matcher list `bash|powershell|edit|write|patch|apply_patch|multiedit|question` on all platforms.
10. `instructionMapping`: native `AGENTS.md`, project `CLAUDE.md` (fallback only), `~/.config/opencode/AGENTS.md`; env `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1` (what the wrapper sets). No extra args.
11. `trustSpec`: no trust dialog expected; `--auto` answers permission prompts; no preseed path.
12. `disableAskSpec`: tool `question`, mechanism `permission`, target `opencode.jsonc permission.question = "deny"` (the guard also maps `question` to `ask`).

## Guard shim

stdin `{"tool","args","sessionID"}`; env `CB_ROLE`, `CB_PROTECTED_BRANCHES`, `CB_ALLOW_ASK`. Output: `{}` allow, `{"decision":"block","reason":...}` block, always exit 0 (same bytes as shim-claude; the plugin throws `Error(reason)`). Mapping: `bash|powershell` -> shell (needs string `args.command`), `edit|write|patch|apply_patch|multiedit` -> edit, `question` -> ask. Anything else blocks, including read-only tools and MCP names, so the plugin must forward only those tools. Fails closed like shim-claude (bad input, unknown tool or role, core load error).

## Integration (outside my files)

- `cli/squad-up.ts`: before `herdr agent start`, pick a free loopback port and a random password, call `writeOpencodeEndpoint(machine, pane, ...)`, and pass `CB_OPENCODE_PORT` and `OPENCODE_SERVER_PASSWORD` in `Launch.env`. Today nothing supplies them, so `buildLaunch` throws by design. Also set `CB_ROLE`/`CB_AGENT` (already done). Pane-prestart ordering (relay before agent) for this kind.
- `cli/relay.ts`: nothing new if it keeps using `adapter.isAlive/deliver`; on exit call `clearOpencodeEndpoint`.
- `kit/guard/install.mjs`: learn to write `~/.config/opencode/plugins/cb-guard.js` (a plugin, not a settings entry). Its `tool.execute.before` must spawn `node shim-opencode.mjs` with `{tool,args,sessionID}` and `CB_*` env, throw `Error(reason)` on a block, and throw on any non-zero exit, timeout, or unparsable output. It must not touch the owner's other plugins in that folder. The plugin source is not in this change.
- `db/schema.sql`: `cb._check_model` already has the opencode regex per the spec; the primary-agent gate stays. `defaultModelFor('opencode', ...)` stays `null` on purpose, to match `cb._role_model` (a squad file must name `provider/model`, e.g. `freellmapi/auto`).
- `cli/agents/index.ts` registers one entry; `test/agents.test.ts` line 44 drops `opencode` from the not-installed list (the codex and agy sessions edit the same line; expect a trivial merge).

## Open questions

1. **Data egress.** `freellmapi/auto` routes to free providers (some CN-hosted, some train on input). The owner allows any agent on any project, and no project allow list was added, but the mirrored folder rule still refuses client folders for the freellmapi provider. Keep, widen, or drop it?
2. Does a prompt posted to the server show up in the TUI session in the pane (the TUI and `--port` server share one process in 1.19.4, assumed, not run)? Which session does the TUI use when several exist ("newest" is a guess)?
3. Request body and path of v2 `/api/session/{id}/prompt`, and whether `prompt_async` queues behind a running turn: needs one live check.
4. Per-role OpenCode agents (`--agent <role>`) and `permission` denies in config: none exist; role rules rely on the plugin and the read-only-role edit block.
5. Windows `bash` tool id: the binary has `bash` and `powershell` tools; which runs on this PC is unconfirmed. Both are mapped.
6. Windows `--port` collisions and `OPENCODE_SERVER_PASSWORD` basic-auth username (assumed `opencode`).
