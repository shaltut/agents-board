# Live check: Codex, agy and OpenCode seats (#4612)

The check that has to pass before `codex`, `agy` or `opencode` goes into `CB_MCP_GATE_OK` for real work. It needs
PR 96 (the guard installer for those agents) and PR 98 (their relays) merged; PR 104 adds Codex's interactive-session
rule, and until it is installed part A reports those checks as skips that name it. Run it on a scratch repo only: the
seats run on other providers (agy on a personal Google account), so no client data goes near them.

| File | What |
|---|---|
| `setup.mjs` | makes the synthetic scratch repo and its squad file (builders 1-3: codex, agy, opencode; reviewer 1: agy) |
| `check.mjs` | part A: the installer's `--check` plus hook probes through each installed shim, no agent started; part B: the live steps, answered pass, fail or skip; writes `<scratch>.live-check.md` |
| `pr98-steps.txt` | the PR 98 review's 14-step relay check, read by part B |

Everything below runs in **your own terminal**, never in a seat: the guard blocks the installer and `cb squad trust`
there. PowerShell on the PC; `<scratch>` is a new folder (for example under `C:\w`), `<machine>` is this machine's name
in squad files.

```powershell
# 0. the board checkout, with PR 96 and PR 98 merged (and PR 104 for the write_stdin checks)
cd <board checkout>
git pull --ff-only

# 1. scratch repo and squad file (synthetic; change the models to what your CLIs offer). setup refuses a folder inside
#    any git repo, and one under a root in CB_SCRATCH_DENY unless it is under one in CB_SCRATCH_ALLOW (; between paths):
#    name the folders that hold client work there, in this terminal
$env:CB_SCRATCH_DENY = '<folder with client repos>'; $env:CB_SCRATCH_ALLOW = '<a folder under it that is yours>'
node kit/live-check/setup.mjs --dir <scratch> --machine <machine> --board (Get-Location).Path --workspace "Live Check" `
  --codex-model gpt-6.1-sol --agy-model gemini-3-pro --opencode-model anthropic/claude-opus-5-5

# 2. the guard for the other agents: Codex and OpenCode once per machine, agy once per seat folder
node kit/guard/install.mjs --agents codex,opencode
node kit/guard/install.mjs --agents agy --seat <scratch>
node kit/guard/install.mjs --check --agents codex,agy,opencode --seat <scratch>

# 3. part A: no seat starts
node kit/live-check/check.mjs --guard $HOME\.claude-board\guard --seat <scratch> --auto-only

# 4. the board project, its squad, and folder trust (then trust <scratch> in agy once: it loads hooks only there)
cb add live-check "Live check: Codex, agy and OpenCode seats (#4612)" -s in_progress -p P1
cb squad set live-check -f <scratch>.squad.json
cb squad trust live-check

# 5. the seats: CB_MCP_GATE_OK in this terminal only, after each CLI's MCP check (no MCP server in its own config)
$env:CB_MCP_GATE_OK = 'codex,agy,opencode'
cb squad up live-check --dry-run
cb squad up live-check

# 6. part B: guided, step by step (part A runs again first)
node kit/live-check/check.mjs --guard $HOME\.claude-board\guard --seat <scratch>
```

The install steps are those of [maintain.md](../../docs/ops/maintain.md) ("Codex, agy and OpenCode seats"): each shim
is copied into the installed guard and probed there before anything is swapped in; a second run changes nothing.
Part A tells which of PR 96 and PR 104 the installed guard has by asking its Codex shim (a tool it does not judge,
outside a seat; an interactive python, in one), and reports a rule it lacks as a skip that names the PR.

Afterwards (setup prints the same paths):

```powershell
# 7. close each seat (/exit, then its pane), then remove what setup and check made. The guard stays installed
Remove-Item -Recurse -Force <scratch>
Remove-Item <scratch>.squad.json, <scratch>.live-check.md
# and archive the live-check project on the board, or keep it for the next check
```
