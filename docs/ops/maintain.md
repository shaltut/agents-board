# Running the board on the VPS

Everything here runs in `/opt/claude-board/deploy` on the VPS (vps2) unless it says otherwise. `dc` below is
`docker compose`. The https side is Nginx Proxy Manager's proxy host `board.shaltoot.cloud` ([deploy.md](deploy.md#5-https-in-front)).

## Is it up?

```bash
dc ps                                   # db and board: running (healthy)
curl -s localhost:4747/healthz          # {"ok":true}; 503 = the board can't reach Postgres
dc logs --tail 50 board                 # errors, "github: ..." poll failures, Telegram
dc exec board cb github                 # watched repos: last poll should be minutes ago
dc exec board cb sessions               # which sessions are alive
```

For alerts, point an uptime monitor (Cloudflare health checks, UptimeRobot) at `https://<public url>/healthz`.

## Restart

```bash
dc restart board          # the server; sessions and browsers reconnect by themselves
dc restart db             # Postgres; the board and every relay reconnect (give it a minute)
```

Never `dc down -v`: `-v` deletes the database volume (and gh's login).

## Upgrade

The agent-neutral core (#4002: the per-seat relay, Stage A+B, and the unified command guard, Stage C) ships as ONE
release. Order: vps2 (the board and its schema) first, then the PC, then the Mac, then restart `cb supervise`.

A release is: the change merged to `main` (reviewed, the suite green on the PC or Mac), then:

```bash
cd /opt/claude-board && git fetch && git merge --ff-only origin/main
git log --oneline -1                    # must show the sha you pushed
cd deploy && dc up -d --build board     # builds, applies the schema, swaps the container (seconds of downtime)
dc logs --tail 20 board                 # "claude_board ready", then the listen line
dc ps                                   # board shows a fresh "Up <seconds>"
```

vps2's checkout is on the `vps` branch, which tracks `origin/vps`, not `main`. A plain `git pull --ff-only` says
"Already up to date", and `dc up -d --build board` then rebuilds the OLD code from cached layers. Merge `origin/main`
as above, and check `git log --oneline -1` before the build.

If vps2's public ssh port times out, use the Tailscale route:
`ssh -o HostName=<tailscale ip> -o HostKeyAlias=<public ip> vps2`.

Then the workers, right away, because their `cb` must match the schema:

- **PC:** `git -C F:\Work\claude-board pull --ff-only`
- **MacBook:** `~/Work/claude-board` is a copy, not a clone. From the PC (Git Bash, in the updated checkout):

  ```bash
  tar czf /tmp/cb.tgz bin cli db prompts server hooks kit && sum=$(md5sum /tmp/cb.tgz | cut -d' ' -f1)
  scp /tmp/cb.tgz macbook:Work/claude-board/cb.tgz
  ssh macbook "cd ~/Work/claude-board && [ \"\$(md5 -q cb.tgz)\" = $sum ] && tar xzf cb.tgz && rm cb.tgz && zsh -lc 'node cli/cb.ts sessions' | head -3"
  ```

  Extract only when the checksums match: a Tailscale hiccup once delivered half an archive, and a partial extract
  broke every `cb` on the Mac for 15 minutes.
- **Mac gate (HARD), before the first real squad restarts on the Mac:** start one throwaway Claude on haiku in its
  own herdr tab, in a scratch folder (no client data), and leave it with a relay on the new code for 5+ minutes.
  Confirm its screen is unchanged, its cost reads 0.0000 and no turn started. If any of those fails, stop the Mac
  rollout and roll the Mac back. Pair it with the first live `herdr --env` start.
- Relays restart themselves when their code changes. Their connections are named `cb-relay/<version>` (a hash of
  the relay's code), so one query shows which sessions run what:
  `dc exec db psql -U cb -d claude_board -c "select application_name, count(*) from pg_stat_activity group by 1"`.
  Each session holds two (its LISTEN and its queries); `cb` calls ride on them (cli/bridge.ts).
- **The guard**, when the release changed `kit/guard/` (this one does): each machine runs its own installed copy in
  `~/.claude-board/guard`, not the checkout's. With Ahmed's yes, on the PC and then on the Mac (from
  `~/Work/claude-board`, after the tar step), run `node kit/guard/install.mjs` and then
  `node kit/guard/install.mjs --check`, and point the hook at it:
  [Installing the guard](#installing-the-guard-on-a-machine).
  **Never copy `kit/hooks/block-dangerous.mjs` into `~/.claude/hooks/`.** It is now a thin wrapper that imports
  `../guard/core.mjs`; copied alone it cannot find it, and it blocks EVERY shell command on that machine.
- **Restart the supervisor** (`cb supervise`, see [Supervisor](#supervisor)) after the PC has the new code.
  After any change to `cli/recipes.ts` or `runner.json`, restart BOTH `cb runner` and `cb supervise` (rule 3 under
  [PC job runner](#pc-job-runner)).
  Relays restart themselves once when their code changes.
- **Claude seats need no `~/.claude` change for the relay.** The live SessionStart hook already runs
  `node <checkout>/cli/relay.ts` (the launcher). It now hands Claude's messaging socket and token to the seat relay
  through the endpoint file `cb-seat-<seatKey>.claude.json` in the OS temp folder. That file holds the messaging
  token: never print or copy it. `hooks/claude-endpoint.mjs` is an alternative hook entry, not required.

If the schema change drops or renames a function the old CLI calls, a worker's `cb` fails until it is updated: that
is the window to keep short.

**Rolling back** code: `git checkout <previous sha> && dc up -d --build board`. The schema is applied forward only:
new columns stay (older code ignores them), and functions revert, because `db/setup.ts` re-applies `db/schema.sql`
(line 25) and the old file redefines them. If an upgrade damaged data, restore the last backup (below).
On vps2 the checkout is now detached from `vps`: the next release must first run `git checkout vps`, before its merge.

For the agent-neutral release the order runs the other way: the PC and the Mac FIRST (check out the previous sha, tar
step on the Mac, restart `cb supervise`), vps2 LAST. A new `cb` against old functions fails; an old `cb` against the
new columns works. The guard's own way back is one line, see below.

## Installing the guard on a machine

Run only with Ahmed's yes: it changes `~/.claude`, which every Claude session on the machine reads.

The guard is `kit/guard/` (`core.mjs`, `shim-claude.mjs`, `install.mjs`). The old single-file
`kit/hooks/block-dangerous.mjs` is retired as an install: it is a thin wrapper that imports `../guard/core.mjs`, so
**never copy it into `~/.claude/hooks/`**. Alone it blocks EVERY shell command on that machine.

1. From the checkout, install: `node kit/guard/install.mjs`. It defaults to `~/.claude-board/guard` (`--target <dir>`
   changes that). Then verify (after step 2): `node kit/guard/install.mjs --check` exits 0 when the installed files
   match the checkout AND `~/.claude/settings.json` has a PreToolUse hook that runs the installed shim with an absolute
   node that exists and a matcher covering Bash (and PowerShell on Windows), and the 6 probes pass through that exact
   hook command (#4348). Each problem prints one `hook:` line saying what to change. A herdr seat whose wiring is off
   hears one `Guard:` line at session start. Also checked: `disableAllHooks` is not set in that file, the hook is a
   `command` hook, and any `timeout` is 15 s or more (a hook that times out counts as allow). Git Bash forms
   (`/c/...`, `$HOME/...`, `~/...`) count as the same paths. On Windows the probes run through Git Bash, as Claude
   Code runs hooks (`CLAUDE_CODE_GIT_BASH_PATH`, else `%ProgramFiles%\Git\bin\bash.exe`; cmd.exe only with neither).
   Only this one settings file is read: `settings.local.json`, project settings and managed policy are not.
   `--check --no-wiring` checks the files only (CI, a machine with no `~/.claude`), where plain `--check` exits 1.
2. In `~/.claude/settings.json`, point the PreToolUse hook command at
   `node <abs-home>/.claude-board/guard/shim-claude.mjs` (the absolute home path, not `~`: the full home path, e.g. `C:/Users/<you>` on Windows, `/Users/<you>` on the Mac). On Windows, set that
   entry's matcher to `Bash|PowerShell`: Claude Code's PowerShell tool runs commands a `Bash`-only hook never sees.
   On the Mac the matcher is `Bash`.
3. Leave the pre-release `~/.claude/hooks/block-dangerous.mjs` (the standalone copy) in place, untouched. The way
   back is one line: set the hook command back to `node ~/.claude/hooks/block-dangerous.mjs`.
4. Check it, with the shim: `echo '{"tool_input":{"command":"ls"}}' | node ~/.claude-board/guard/shim-claude.mjs`
   prints `{}`, and
   `echo '{"tool_input":{"command":"git reset --hard"}}' | node ~/.claude-board/guard/shim-claude.mjs` prints the block JSON
   (`{"decision":"block","reason":"Blocked dangerous command: git reset --hard"}`), and, the protected-branch fence,
   `echo '{"tool_input":{"command":"git push origin development"}}' | CB_PROTECTED_BRANCHES=development node ~/.claude-board/guard/shim-claude.mjs`
   prints the block JSON
   (`{"decision":"block","reason":"Blocked dangerous command: git push to protected branch development: push your own branch and open a PR; the lead merges it"}`).
   And, the kill-by-name rule (#3809),
   `echo '{"tool_input":{"command":"taskkill /F /IM node.exe"}}' | node ~/.claude-board/guard/shim-claude.mjs` prints
   the block JSON with a reason starting `Blocked dangerous command: kill by process name`. And, malformed stdin
   (`echo 'not json' | node ~/.claude-board/guard/shim-claude.mjs`) must block, not allow: the reason starts
   `Blocked: guard could not read hook input (invalid JSON`. And, a builder's push to main:
   `echo '{"tool_input":{"command":"git push origin main"}}' | CB_ROLE=builder node ~/.claude-board/guard/shim-claude.mjs`
   must block, with a reason starting `Blocked by role (builder): git push to protected branch main`. The installed hook blocks these command lines when a Claude session runs them, so a session runs the
   checks from a small script that builds the command strings.
5. If `node` is not on the PATH of the shell that runs hooks (possible on the Mac), the hook exits 127, and Claude Code
   treats that as **allow**: the fence silently disappears. So the hook command uses an absolute node path
   (`command -v node` prints it; `--check` refuses a bare `node`), and from a fresh session confirm that a blocked
   command is refused.

On the Mac, the same, from `~/Work/claude-board` after the tar step above.

## Backups

`deploy/backup.sh` runs nightly from root's crontab ([deploy.md](deploy.md#6-backups)): a `pg_dump -Fc` in
`/var/backups/claude-board`, 14 days kept. Run it by hand before anything risky:

```bash
sudo /opt/claude-board/deploy/backup.sh       # prints the file
```

Once a month, prove a backup restores, into a scratch database next to the live one:

```bash
f=$(ls -t /var/backups/claude-board/*.dump | head -1)
dc exec -T db createdb -U cb claude_board_restore_check
dc exec -T db pg_restore -U cb -d claude_board_restore_check --no-owner --exit-on-error < "$f"
dc exec -T db psql -U cb -d claude_board_restore_check -c "select count(*) from cb.tasks"
dc exec -T db dropdb -U cb claude_board_restore_check
```

Copy dumps off the VPS only to Ahmed's own machines (the PC or the Mac): they hold client work.

## Restore

The board goes back to the dump; everything after it is lost. Take a fresh backup first if the current state matters.

```bash
sudo /opt/claude-board/deploy/backup.sh                 # what is there now, just in case
dc stop board
dc exec -T db dropdb -U cb claude_board
dc exec -T db createdb -U cb claude_board
dc exec -T db pg_restore -U cb -d claude_board --no-owner --exit-on-error < /var/backups/claude-board/<file>.dump
dc up -d board                                          # re-applies the schema, starts polling
```

Then tell the sessions: `dc exec board cb broadcast "The board was restored to <time>: re-register anything you did since."`

## Users

Day to day, on the board: Users (key 7). Add a member, copy their link or set a password, put them on projects, make
an admin, remove someone. Everyone changes their own password at the top of the page (admins: under their name).

From the VPS shell, when the board itself can't be used (no admin can sign in):

```bash
dc exec board cb users                                                          # who, which role
read -rs PW && printf %s "$PW" | dc exec -T -e PGAPPNAME=cb-web board cb user password ahmed; unset PW   # reset a password
dc exec -e PGAPPNAME=cb-web board cb user role omar admin                       # or member
```

A locked name (5 wrong passwords from one address) unlocks by itself after 2 minutes; `dc restart board` clears every
lock at once. Removing someone, or a new link for a member, is on the Users page only.

## Secrets

All in `deploy/.env` (mode 600). After changing one: `dc up -d` (recreates what changed).

- **Database password:** `dc exec db psql -U cb -d claude_board -c "alter user cb password '<new>'"`, then
  `CB_PG_PASSWORD` in `.env`, `dc up -d`, then every worker's URL (the PC's `.env`, the Mac's `~/.zshrc`) and their
  relays. Do it if a worker machine is lost or the password leaks.
- **Telegram bot token:** revoke in @BotFather, new token in `.env`, `dc up -d board`.
- **GitHub:** gh's own login inside the board container (`dc exec board gh auth status`), stored by gh in the
  `ghconfig` volume as a plain file (no keyring in a container): anyone with root on vps2 can read it, and it has
  the signed-in account's scopes. Rotate: `dc exec board gh auth logout`, then the login in
  [deploy.md](deploy.md#8-the-move-ahmeds-live-board-from-the-pc-to-the-vps) step 7. Narrower option: a fine-grained,
  read-only `GH_TOKEN` in `.env` (it overrides the login). `dc logs board | grep github` shows HTTP 401 when the
  login stopped working.
- **Nginx Proxy Manager:** its admin account and Let's Encrypt certificates are NPM's (it renews them itself).

## Disk and housekeeping

```bash
docker system df                 # images, volumes
docker image prune -f            # old board images after upgrades
dc exec db psql -U cb -d claude_board -c "select pg_size_pretty(pg_database_size('claude_board'))"
```

The board is small (tens of MB). Postgres vacuums itself. A Postgres major version upgrade (16 to 17) is a dump,
a new volume and a restore, never just a new image tag.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every POST says "cross-site request refused" | the proxy rewrites `Host`, or the board is served on a port other than 443 (NPM drops the port from `Host`) | serve on 443; pass the public Host through |
| The public URL says 502 Bad Gateway | the board is down, or not on NPM's network | `dc ps`; `docker network inspect nginx-proxy-manager_default` lists `claude-board-board-1`; `dc up -d board` |
| Pages load but nothing updates live | a proxy buffering the event stream | the board sends `X-Accel-Buffering: no`; another proxy: turn its buffering off for `/api/stream` |
| Signed in, but sent back to the login page | the cookie isn't kept: https page with a non-Secure cookie blocked, or a proxy dropping `Set-Cookie` | check `X-Forwarded-Proto: https` reaches the board |
| "That name and password don't match" for the right password | 5 failures from that address in 2 minutes, or no password set | wait 2 minutes or `dc restart board`; set a password from the shell |
| `healthz` 503, board logs `ECONNREFUSED db` | Postgres is down or still starting | `dc ps`, `dc logs db` |
| db won't start: "cannot assign requested address" | Tailscale wasn't up when Docker started, so `CB_PG_BIND` doesn't exist yet | `sudo systemctl enable tailscaled`; `dc up -d db` |
| A worker's `cb` says "board unreachable at 100.x.y.z" | the VPS, Tailscale or Postgres is down, or the URL/password is wrong | `tailscale ping vps2`; `dc ps`; check the worker's URL |
| A worker's `cb` errors "function cb.x(...) does not exist" | the worker's code is older or newer than the VPS's schema | update the worker's checkout (Upgrade) |
| No Telegram pushes | no token, or another server polls with it (409 in the logs) | `TELEGRAM_BOT_TOKEN` in `.env`; stop the other server |
| Log: "another board server polls Telegram and GitHub" | a second server (the PC's?) holds the poller lock | stop it; this one takes over within a minute |
| GitHub watch silent | gh signed out, or its token expired or was revoked | `dc exec board gh auth status`; `dc exec board cb github` shows the last error; log in again |
| The board or db restarted on its own at night | Watchtower, if the opt-out label was lost | `docker inspect -f '{{.Config.Labels}}' claude-board-board-1` shows `watchtower.enable:false` |

## PC job runner

Heavy checks (type checks, test suites, builds, DB tests) run on the PC, not on the Macs: sessions queue them with
`cb run` and get the result as a message. One runner serves all projects.

Set up, once, on the PC:

1. Copy `docs/ops/runner.example.json` to `~/.claude-board/runner.json` (or point `CB_RUNNER_CONFIG` at it). Set
   `log.host` to the PC's Tailscale address and `log.port` to a free port (the example's are placeholders), list the
   Tailscale addresses that may read logs in `log.peers`: the PC's own address (`cb job log` on the PC connects to it) and the MacBook's, and each project's `git` URL, `base` folder
   and recipes. Logs live in `~/.claude-board/runner/logs` (override with `CB_RUNNER_HOME`), kept 7 days.
2. Start `cb runner` in a herdr pane on the PC and leave it. It connects to the board, publishes its recipes
   (`cb jobs` shows them) and serves job logs. `itest` and `kbtest` need Docker running.
   - `slots` (1-10) is how many jobs run at once; `dbLanes` (1-9, default 1, at most `slots`) is how many of them may
     be DB jobs. Each DB job holds a lane, and `{lane}` in its recipe's env values becomes that lane's number, so every
     lane gets its own test stack: `"TEST_STACK_PROJECT": "cb-runner-it-{lane}"`, `"TEST_STACK_PG_PORT": "5544{lane}"`,
     `"TEST_STACK_REDIS_PORT": "5638{lane}"`, `"TEST_STACK_S3_PORT": "5901{lane}"`. Keep lane ports off the old
     single-stack ports (55432, 56379, 59000) and any stack you start by hand.
   - With `dbLanes` above 1, `laneEnv` names those env values. Every DB recipe must set each of them with `{lane}`,
     and all DB recipes must write each one the same way, so lane n is one stack whichever recipe runs in it. The
     runner refuses to start otherwise.
   - Switching on lanes: stop the runner, remove the stack left from before (`docker compose -p cb-runner-it down -v`),
     then start it. A stopped runner's `finally` steps do not run, so that stack stays up until removed.
   - A `guards` recipe can also run the repo's script tests on every job with the pre-push hook's own command
     (`pnpm exec lefthook run pre-push --commands <command> --no-tty`): the commit's own `lefthook.yml` decides which
     files run, so no file list is copied into runner.json.
3. After any change to `cli/recipes.ts` or `runner.json`, restart BOTH `cb runner` and `cb supervise`: the supervisor
   validates runner.json with the code it loaded at start.
   Restarting the runner is safe: a job that was running ends `error: runner restarted`, the requester is told, queued jobs go on.
4. runner.json must follow a project merge (`cb.project_alias`): rename that project's key to the target and restart
   `cb runner` straight after. The merge moves the jobs and the published recipes on the board, but until then the
   runner has no config for the new name (a claimed job ends `error: bad job row`), and a restart under the old name
   publishes the old name again (the moved jobs stay queued).
5. runner.json takes a project's shape from its squad file: a squad with a `repos` key (even one repo) needs that
   project's runner.json entry under `repos` with the same names. A one-entry `repos` squad's home is not `main`, so
   its sessions start with `--repo <name>` and `cb run` defaults to that name; a flat entry offers only `main` and
   every `cb run` is refused.
6. Switching a project from flat to `repos`:
   - runner.json and the squad file switch together; until both list the same repos, `cb run` is refused.
   - Slot clones are named `<project>-<slot>` for `main` and `<project>-<repo>-<slot>` for any other repo (`ihop-1`
     becomes `ihop-<repo>-1`). The old `<project>-<slot>` folders under `base` and their files in
     `~/.claude-board/runner/state` are orphaned: delete them by hand. The first job in each slot clones and installs again.
   - Jobs still queued as `main` at the switch are never claimed by the new runner: cancel them (`cb job cancel <id>`)
     and queue them again.

What each result means:

| Result | Meaning | Do |
|---|---|---|
| `error: push it first` | the commit is not on origin | push the branch, queue again |
| `error: not on a branch of origin` | the commit is only on a tag, a PR ref or nowhere | push it on a branch |
| `error: timed out after <N> min` | the recipe's timeout hit; the process tree was killed | read `cb job log <id>`; raise `timeout` only if the work is real |
| `error: Docker is not running` | a DB recipe, no Docker on the PC | start Docker Desktop, queue again |
| `error: runner restarted` | the runner stopped mid-job | queue again |
| `error: could not start <cmd>` | the program is missing or is a `.cmd` file | fix `runner.json` or the PC's PATH |
| `error: bad parameter <name>: <value>` | the runner's own check refused a value | fix the value; if it looks right, the recipe's pattern is too tight |
| `error: could not fetch from origin` | no network, or no access to the repo | check git credentials on the PC |
| `error: bad job row` | the job row is malformed | `cb job show <id>`; report it |
| `error: runner fault: see cb job log <id>` | the runner itself failed | read the log, then the runner's pane |
| `no tests ran: <summary>` | the command exited 0 but ran nothing | the file list or app is wrong |
| `summary withheld: see cb job log <id>` | the output looked sensitive, so none of it went to the board | read the log from the PC or the MacBook |

## Supervisor

`cb supervise` keeps each supervised project's squad sessions in line with its queues, and restarts the PC runner
when it stops. Card #3601; design: `docs/superpowers/specs/2026-11-23-supervisor-design.md`.

Start it by hand on the PC, in a herdr tab named `supervisor`, and leave it: `cb supervise`. After any change to
`cli/recipes.ts` or `runner.json`, restart BOTH `cb runner` and `cb supervise` (it validates runner.json with the code
it loaded at start). Only one runs at a time,
on any machine (a Postgres advisory lock); a second says `another supervisor is running` and exits. Check the plan
first with `cb supervise --dry-run` (prints `would start ...`, `would close ...`, acts on nothing); `cb supervise
--once` acts once and exits. Its log is `~/.claude-board/supervisor/<date>.log` (override the folder with
`CB_SUPERVISOR_HOME`), one file a day, kept 7 days. Every start, close, restore and runner start is also a board event by actor
`supervisor` (session names, roles and counts only).

A project is supervised only when its pipeline is on and its squad file says `"supervise": true` (`cb squad set`).
The squad `count` per role is then the most the supervisor keeps up. Every 60 s it:

- restores a squad session that is down but holds open cards, under the same name with `cb resume` (at most once
  per 30 minutes per name; a restore that failed to start is tried again after 10 minutes; down again within 30
  minutes of a restore that started: a `down_again` event, and no automatic restore until the name binds again:
  restore it by hand);
- starts sessions for waiting cards, like `cb squad up` (names, models, permission files), at most 3 a tick, 8 on
  the Mac in all; a name that failed to start waits 10 minutes;
- closes a squad session idle 20 minutes that holds nothing (no card, question, job or open dashboard ask), that herdr
  shows ready for input (`idle`, or `done` for a pane nobody looked at), when its role has no waiting work: it marks
  it closing, finds its pane, checks again (board and herdr), sends `/exit`, then closes the pane (not gone in 60 s: the pane stays and the mark lapses in 5 minutes);
- restarts the PC runner (herdr tab `runner`, `cb runner`) when `runner.json` exists and the runner has not beaten
  for 3 minutes, at most once per 10 minutes (first closing the runner tab it opened before, that pane only). A start that does not beat, or a log port still held by an old
  runner, is told to each supervised project's lead once an hour.
- skips a project whose squad puts its own machine (`"herdr": null`) on another machine than this one, saying so
  in its log once an hour.

It never:

- starts, closes or restores the lead (`orch@*`) or any name the squad file does not generate;
- answers a startup dialog (folder trust, the bypass warning): it logs `blocked` and tells the lead (the project's
  live session in the lead role; none live: the digest's blocked line) once per block, with the pane and the command to send
  the first prompt afterwards (the same when a session started but its first prompt was not sent);
- frees a card held by a down session, or runs anything heavy itself.

## Squad file: herdr workspace

A machine may name the herdr workspace its squad sessions open in: `"macbook": {"herdr": "macbook", "board": "...",
"workspace": "iHop Squad"}` (the workspace's label, 1 to 64 characters). `cb squad up` and the supervisor then open each
new session as a tab there (two per tab, as before), and make the workspace when herdr has none by that label; its first
pane takes the first session. Without `workspace` a session opens in whichever workspace is focused on that machine.
Sessions already running stay where they are: move them with `herdr pane move <pane> --new-tab --workspace <id>`.
Card #3719.

## Squad file: protected branches

A squad may list the branches its sessions must never push to: `"protected": ["development", "staging",
"releases/*", "athena-production"]` (branch names, or globs where `*` is any run of characters, `/` included; at most
30, each 1 to 100 characters of letters, digits and `. _ / * -`, not starting with `-`). Give each branch as git shows
it: `cb squad set` refuses an entry starting with `refs/`, `heads/` or `origin/`, or ending with `/`, since the hook
could never match it. `cb squad up` and the supervisor then create each new session's pane with
`CB_PROTECTED_BRANCHES=<the list, comma-joined>` (herdr `--env`), and the guard blocks a `git push`
whose destination is on it: `git push origin development`, `x:development`, `HEAD:refs/heads/development`,
`x:heads/development`, `+x:development`, `--delete origin development`. Plain `git push` and `git push origin` stay
denied by the role permission files. Card #3746.

- The block says what to do instead: push your own branch and open a PR; the lead merges it.
- While the list is set, a push whose remote or branch the shell fills in (`$B`, `$(git branch --show-current)`,
  backticks) is blocked too, since the hook cannot see the branch: name it literally.
- While the list is set, a wildcard destination (`refs/heads/*:refs/heads/*`, `develop*`) is blocked too: it can write
  a protected branch. Push one branch by name.
- Sessions already running have no such variable: the fence holds only after each is restarted (closed, then started
  by `cb squad up` or the supervisor).
- A lead started by hand (not by `cb squad up`) never gets the variable that way: squad up skips a lead-role session
  of the project (a live one with no line; one seen in the last day but not live is named in a `skip lead:` line),
  and the supervisor never starts a lead. Close it and restart it by hand in a pane that carries the variable, quoted so no shell expands the `*`
  (zsh refuses an unmatched glob):
  - a new herdr tab: `herdr tab create --cwd <repo> --label <name> --env 'CB_PROTECTED_BRANCHES=development,releases/*'`
    (`herdr --machine <label> tab create ...` on another machine), then start `claude` in that pane;
  - or set it in the shell that starts `claude`: `export CB_PROTECTED_BRANCHES='development,releases/*'` (bash, zsh),
    `$env:CB_PROTECTED_BRANCHES = 'development,releases/*'` (PowerShell).

  Then bind it as before (`cb iam <name> <project> --role lead`). From the session, `echo $CB_PROTECTED_BRANCHES`
  prints the list.
- The fence is the hook installed on each machine: after a release that changed it, copy it there (Upgrade, above).

## Squad file: several repos

One board project can hold several git repos. QHS is four: `api`, `dashboard`, `app`, `bot`. Add a `repos` key to the
squad file (`cb squad set <project> -f <file>`):

```json
"repos": {
  "api":       { "home": true, "paths": { "shaltoot": "F:/Work/QHS/api", "macbook": "/Users/ahmedshaltoot/Work/QHS/api" } },
  "dashboard": { "paths": { "shaltoot": "F:/Work/QHS/dashboard", "macbook": "/Users/ahmedshaltoot/Work/QHS/dashboard" } }
}
```

- A repo name is a slug: lower-case letters, digits and dashes, starting with a letter, 32 characters at most.
- Exactly one repo is `home`; lead, architect, qa and investigator start there.
- Machines then give only `herdr` and `board`; each repo carries its own `paths`.
- Areas become `{"name": "api", "repo": "api"}`; builder and reviewer counts go per repo (`{"api": 2, "dashboard": 1}`).
- Every repo with builders needs a reviewer count for that repo (`repo X has builders but no reviewers`).
- The Mac cap of 8 counts all sessions on the Mac, across repos.
- An owner starts in its area's repo, so the owner's machine needs a path for that repo. Lead, architect, qa and investigator need a path for the home repo on their machine.
- No `repos` key: one repo named `main`, as before. A `cb run` for a repo the PC runner does not have is refused.

## Tests

Never on the VPS. The suite truncates whatever database it is given and expects the PC's layout (127.0.0.1:5434);
run it on the PC or the Mac against their own test databases (`CB_TEST_DB=claude_board_test`). Changing the code is
in [CLAUDE.md](../../CLAUDE.md).
