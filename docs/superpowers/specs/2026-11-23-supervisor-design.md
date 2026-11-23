# Squad piece 4: the supervisor (design)

Card #3601. Follows `2026-11-22-squad-design.md` ("Piece 4: the supervisor (outline)"); the decisions there
(Q2308, Q2324, "Models per role", "Agent-native board") and the kit design (`cb squad up`, Q2356, Q2362) bind this.

## Why

Today a squad session exists only because someone ran `cb squad up` or started it by hand, and it stays until
someone closes it. So cards wait when every builder is busy, idle sessions hold Mac memory and quota for hours, and
the PC runner stays down after a reboot until Ahmed notices. The supervisor makes "how many sessions of each role are
up" follow the board's queues, inside caps Ahmed sets, without an LLM deciding it (Q2308).

## What it is

### 1. `cb supervise` on the PC

- A small loop (`node cli/supervise.ts`, started with `cb supervise` in a herdr tab named `supervisor` on the PC, by
  hand, like the runner). Every 60 s it runs one **tick**.
- **One at a time, anywhere:** it holds a Postgres session advisory lock on its board connection (the server's poller
  already does this). A second `cb supervise`, on any machine, says `another supervisor is running` and exits. A crash
  frees the lock with the connection.
- `cb supervise --dry-run` runs one tick and prints the plan without acting. `cb supervise --once` acts once and exits.
- Only light work: board queries and herdr commands. Nothing heavy runs on the Mac or in the supervisor.

### 2. Which projects

A project is supervised only when its pipeline is on, it has a squad file, and the squad file says
`"supervise": true` (a new optional key, default false; Ahmed or the lead sets it with `cb squad set`). That key is
Ahmed's on/off switch per project. My call: no new dashboard setting.

The squad file's `count` per role becomes the **most** sessions of that role the supervisor keeps up. `cb squad up`
still starts the full count by hand, as today.

### 3. One tick, per supervised project

The board computes the facts in one SQL function (`cb.supervise_state(project)`: board rules stay in SQL). The
supervisor plans from them with a pure function (`planTick`, unit-tested like `planSquad`) and then acts through
herdr, reusing `squad-up.ts`'s launch code.

**Waiting work per role** (cards nobody holds):

| Role | Waiting means |
|---|---|
| builder | stage `build`, status `next`, no assignee |
| reviewer | stage `review`, status `next`, no assignee |
| qa | stage `qa`, status `next`, no assignee |
| owner of area X | stage `design`, `next`, no assignee, tagged X |
| architect | stage `design`, `next`, no assignee, and either the squad file names no owner for any of its tags, or it has waited 15 min at `design` |
| investigator | type `research`, status `next`, no assignee |
| lead | never started or closed by the supervisor |

A card held for a session that is down (Q2324) is not waiting work: it waits for its own session (section 4).
One design card is never demand for both roles at once: while the squad names an owner for its area, only that
owner is started; the architect counts it only after 15 minutes (my call: no churn of a session started for nothing).

**Who counts:** "live sessions of a role" and "idle sessions of a role" are every live session bound to the project
with that board role, including ones Ahmed started by hand: they take work, so they cancel waiting work. A name that
is down but still holds cards does not count as live, and its number is never reused (section 4). My call.

**Start:** for each role, `start = min(waiting − idle sessions of that role, role count − live sessions of that role,
room left under the Mac cap)`. Names, models, permission files and the first prompt are exactly `cb squad up`'s
(`<project>-B<n>@<machine>`, `--model`, `--settings`, bypass mode, then `cb iam … --role … --model …`, `cb role`,
`cb next`). The lowest free number is used; a number whose name holds any open card is not free.

**Close:** a session is closed when all of these hold:
- its name is one the squad file generates for this project (never `orch@*`, never any other name). In a project
  with `supervise: true` this includes sessions `cb squad up` started: there the squad counts are maxima, and idle
  sessions go. My call;
- it holds no card that is not done or cancelled, has no open question, and no queued or running job;
- the board has seen no event from it for 20 minutes;
- its role has no waiting work.

**No card lands on a closing session:** the supervisor first marks the session `closing` on the board (a new
`sessions.closing_at`); `cb next`, `task_claim` and the relay's next-work push refuse a closing session. It then checks
again that the session holds nothing (a claim that won the race clears the mark and the close is skipped). A mark
older than 5 minutes lapses. Closing is herdr `agent prompt <name> /exit`, then `pane close` once herdr shows no agent in the pane (at most 60 s;
otherwise it reports and leaves the pane). The board drops the session when its heartbeat stops.

**Caps:** the Mac's hard cap of 8 counts every live session on the Mac, all projects (as `squad up`). At most 3
starts per tick across all projects. A name that fails to start is not tried again for 10 minutes.

### 4. A down session that still holds cards

Q2324 says no card is freed because its session is down. **Decided by Ahmed (Q2381): the supervisor restores it.**
A squad name of the project that is down (not live on the board, no herdr agent) and holds open cards is started
again under the same name, with `cb resume` in its first prompt instead of `cb next`, at most once per 30 minutes per
name. If it is down again within 30 minutes of a restore, the supervisor does not retry: the lead's digest names it
for a person. Restores count toward the Mac cap and the 3 starts per tick, and go before new starts.

### 5. Startup dialogs are Ahmed's

A new Claude Code session can stop on a startup dialog (folder trust, the bypass warning). The supervisor never
answers it (anti-goal: no agent clears another's safety stop). It tells the lead once per name, with the pane and
the herdr command to send the first prompt afterwards, and counts that name as started until its pane is gone.

### 6. The PC runner

If `runner.json` exists on the PC and the board has seen no runner beat for 3 minutes, the supervisor opens a herdr
tab `runner` on the PC and runs `cb runner` there. If the runner's log port is still held (an old runner alive but
not beating), `cb runner` exits by itself, and the supervisor reports it to the lead once an hour instead of
retrying every tick. My call.

### 7. What the board and the lead see

- Every start, close, restore and runner start is a board event (actor `supervisor`, the project, the session name
  and role; no card text). `cb sessions` shows supervised sessions as today.
- The lead's digest gets one line per 15 minutes when anything happened: `supervisor: started 2, closed 1 (cb
  events --actor supervisor)`.
- The supervisor's own log stays on the PC (`~/.claude-board/supervisor/supervisor.log`, kept 7 days).

## Tests

- `planTick` (pure): start up to the role count; idle sessions of the role cancel waiting work; the Mac cap counts
  other projects; at most 3 starts per tick; a recently failed name is skipped; close only squad names, never one
  holding a card, an open question or a job, never within 20 minutes of its last event, never when its role has
  waiting work; owners per area; lead never touched; `supervise: false` → nothing.
- `cb.supervise_state` against the test Postgres: waiting counts per role (held, down-held and unstaged cards don't
  count), busy and idle flags, last event time.
- `closing_at`: a closing session can't claim or be pushed work; a mark that lost the race is cleared; a stale mark lapses.
- `squad_set` accepts `supervise` true/false and refuses anything else.
- The advisory lock: a second supervisor exits with its message.
- One live check by hand before release on the throwaway `kitlive` project: two `build` cards with no builder → the
  supervisor starts builders up to the count; the cards are taken; after 20 idle minutes they are closed; a session
  holding a card is never closed; the runner is restarted after it is stopped.

## Not in this piece

Starting the supervisor itself at Windows log-on; a dashboard switch for `supervise`; scaling the PC runner's slots;
closing or starting the lead.
