import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';
import { COMMANDS, TOPIC_NAMES, OVERVIEW_TEXT, SNIPPET, help } from '../cli/help.ts';
import { seatKey } from '../cli/bridge.ts';
import { claudeEndpointPath, writeClaudeEndpoint } from '../cli/agents/claude.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }
// relay files are keyed per seat (machine + pane): this process's own pane, so no other run's lock can answer for it
const P = `p-help-${process.pid}`;

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', CB_MACHINE: 'mac', CB_AGENT: '',
      CLAUDE_CODE_MESSAGING_SOCKET: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('every command in the cb.ts switch has a help entry and appears in cb help', () => {
  const src = readFileSync('cli/cb.ts', 'utf8');
  const cases = [...src.matchAll(/^\s*case '([a-z-]+)':/gm)].map((m) => m[1]);
  assert.ok(cases.length > 20, `found only ${cases.length} cases`);
  for (const c of cases) {
    assert.ok(COMMANDS[c], `cb ${c} has no entry in cli/help.ts GROUPS: add one`);
    assert.match(OVERVIEW_TEXT, new RegExp(`^  cb ${c}\\b`, 'm'), `cb help does not show cb ${c}`);
  }
});

test('cb help is the manual: overview, rules, topics, grouped commands with examples', () => {
  const r = cb(['help']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /FIRST: run  cb start/);
  for (const g of ['START A SESSION', 'TAKE WORK', 'REPORT', 'ASK AHMED', 'TALK TO SESSIONS', 'ORCHESTRATE']) assert.match(r.out, new RegExp(`^${g}$`, 'm'));
  assert.match(r.out, /e\.g\. cb done 42 /);
  for (const t of ['start', 'project', 'ask', 'orchestrate', 'huddle', 'relay', 'rules']) assert.ok(TOPIC_NAMES.includes(t), t);
  assert.equal(cb([]).out, r.out); // bare cb prints the same
});

// #4450: rule 10 said only "keep working"; the exit codes and the check before a resend are documented
test('cb help documents exit 3 (did not run) and rule 10 says to run the named check before a resend', () => {
  // #4515: a read is safe to run again too
  assert.match(OVERVIEW_TEXT, /^ +Exit 2 = cb lock take queued you \(not held\)\. Exit 3 = a board on another machine was unreachable and nothing\n +of the command reached it, or the command only reads: safe to run again unchanged \(this machine's own board\n +never gives 3\)\.$/m);
  assert.match(help('rules')!, /^10\. Board unreachable: keep working\. .*Did not run, or it only\n +reads \(exit 3, a board on another machine only\): run it again once the board is back\. Otherwise \(exit 1\) it may\n +have run: run the check it names \(cb show <id>, cb search \.\.\.\) first, never a blind resend/m);
});

test('cb help <topic> and cb help <command> print the detailed page; -h on a command too', () => {
  const ask = cb(['help', 'ask']);
  assert.equal(ask.code, 0, ask.err);
  assert.match(ask.out, /--free \(no options\): ONLY when no choice exists/);
  assert.match(ask.out, /Wrong .* --free/);
  const done = cb(['help', 'done']);
  assert.match(done.out, /^cb done <id> "<summary>"/); // (output is trimmed)
  assert.match(done.out, /More: cb help work/);
  assert.equal(cb(['ask', '-h']).out, ask.out);
  // the --json fields (#4453)
  assert.match(ask.out, /^--json .*"duplicate".*"relay_live"/m);
  assert.match(cb(['help', 'tell']).out, /delivery is one of: live .*relay_down .*no_session .*not_seen /);
  assert.match(cb(['help', 'project']).out, /cb iam orch@<machine> <slug>/);
});

test('cb help <unknown> exits 1 and lists the topics and commands', () => {
  const r = cb(['help', 'queue']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no help for "queue"\. Topics: start, work, ask, huddle, relay, orchestrate, project, rules, memory\. Commands: .*next/);
});

test('cb help iam documents --agent; cb help squad documents agent, seats and fallback (#4002)', () => {
  const iam = cb(['help', 'iam']);
  assert.equal(iam.code, 0, iam.err);
  assert.match(iam.out, /^cb iam <name> \[project\] .*\[--agent <agent>\]/);
  assert.match(iam.out, /--agent is .*claude \(the default\), codex, opencode or agy/);
  assert.match(iam.out, /\$CB_AGENT/);
  const squad = cb(['help', 'squad']).out;
  for (const k of ['"agent"', '"fallback"', '"seats"', 'CB_ROLE', 'CB_AGENT']) assert.ok(squad.includes(k), k);
  assert.match(squad, /phase 1 starts claude only/);
});

test('prompts/claude-md-snippet.md is the snippet cb help project prints', () => {
  assert.equal(readFileSync('prompts/claude-md-snippet.md', 'utf8').trim(), SNIPPET);
  assert.match(SNIPPET, /Work only in project/);
  assert.match(SNIPPET, /not Ahmed's approval/);
});

test('cb start, no herdr pane: act with --as / CB_ACTOR and poll', async () => {
  await db();
  const r = cb(['start'], { CB_ACTOR: '' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /no herdr pane/);
  assert.match(r.out, /--as <name>/);
});

test('cb start, unbound pane: says how to bind and lists the projects', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'iris', title => 'a', status => 'next')`;
  await sql`select cb.task_add(project => 'zephyr', title => 'b')`;
  const r = cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: P });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Project +NOT BOUND/);
  assert.match(r.out, /cb iam <name> <project>/);
  assert.match(r.out, /W1@mac/);
  assert.match(r.out, /^ +iris +1 next/m);
  assert.match(r.out, /^ +zephyr/m);
  assert.doesNotMatch(r.out, /cb relay/); // one step at a time
});

test('cb start, relay started before cb iam (the hook): its row has no project, so still not bound', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'iris', title => 'a')`;
  await sql`select cb.inbox('mac', ${P})`; // what the SessionStart relay does first
  const r = cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: P });
  assert.match(r.out, new RegExp(`You +${P}@mac \\(not bound\\)`));
  assert.match(r.out, /cb iam <name> <project>/);
});

test('cb start, bound without relay: run cb relay; then shows work and the queue head', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'iris', title => 'held', status => 'in_progress', actor => 'W1@test')`;
  await sql`select cb.task_add(project => 'iris', title => 'top of queue', status => 'next', priority => 'P1')`;
  await sql`select cb.iam('mac', ${P}, 'W1@test', 'iris')`;
  const env = { CB_ACTOR: '', HERDR_PANE_ID: P, CLAUDE_CODE_MESSAGING_SOCKET: `sock-${process.pid}` };
  const r = cb(['start'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /You +W1@test/);
  assert.match(r.out, /Project +iris/);
  assert.match(r.out, /Relay +OFF/);
  assert.match(r.out, /cb relay/);

  const lock = join(tmpdir(), `cb-relay-${seatKey('mac', P)}.pid`);
  writeFileSync(lock, String(process.pid)); // a live relay holds the seat's lock
  try {
    const s = cb(['start'], env);
    assert.match(s.out, /Relay +on/);
    assert.match(s.out, /#1 \[in_progress\] P2 held/);
    assert.match(s.out, /#2 P1 top of queue/);
    assert.match(s.out, /continue #1/);
    assert.match(cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: P }).out, /Relay +on/, 'no Claude inbox in this env: the seat lock still says on');
  } finally { rmSync(lock, { force: true }); }
  // a relay from before the seat key (keyed by its Claude's socket) still counts while it restarts
  const legacy = join(tmpdir(), `cb-relay-${createHash('sha1').update(env.CLAUDE_CODE_MESSAGING_SOCKET).digest('hex').slice(0, 12)}.pid`);
  writeFileSync(legacy, String(process.pid));
  try { assert.match(cb(['start'], env).out, /Relay +on/); } finally { rmSync(legacy, { force: true }); }
  const [{ n }] = await sql`select count(*)::int as n from cb.tasks where status = 'next'`;
  assert.equal(n, 1); // read-only: nothing claimed
});

test('cb start, bound with nothing held: tells it to cb next', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'iris', title => 'top', status => 'next')`;
  await sql`select cb.iam('mac', ${P}, 'W1@test', 'iris')`;
  const r = cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: P }); // no Claude inbox in env, no endpoint file
  assert.match(r.out, /Relay +unavailable/);
  assert.match(r.out, /cb next/);
  // a live endpoint file (Claude handed its inbox over) without the inbox in env: a relay can run here, it is just off
  const sock = process.platform === 'win32' ? String.raw`\\.\pipe\cb-help-ep-` + process.pid : join(tmpdir(), `cb-help-ep-${process.pid}.sock`);
  const inbox = net.createServer((c) => { c.on('error', () => {}); c.resume(); });
  await new Promise((ok) => inbox.listen(sock, () => ok(undefined)));
  try {
    writeClaudeEndpoint('mac', P, { socket: sock, token: 'tok' });
    assert.match(cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: P }).out, /Relay +OFF/);
  } finally {
    rmSync(claudeEndpointPath('mac', P), { force: true });
    await new Promise((ok) => inbox.close(ok));
  }
});

test('cb relay needs only a pane; another agent is refused by name; claude needs its inbox in env or an endpoint file', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('iris')`;
  await sql`select cb.iam('mac', ${P}, 'W1@test', 'iris')`;
  assert.match(cb(['relay'], { HERDR_PANE_ID: '' }).err, /cb relay needs a herdr pane/);
  assert.match(cb(['relay', '--agent', 'codex'], { HERDR_PANE_ID: P }).err, /agent "codex" is not installed yet/);
  assert.match(cb(['relay', '--agent', 'nope'], { HERDR_PANE_ID: P }).err, /unknown agent "nope"/);
  assert.match(cb(['relay'], { HERDR_PANE_ID: P }).err, /no session inbox here/);
});

test('errors say what to run instead', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'iris', title => 'x')`;
  assert.match(cb(['move', '1']).err, /^cb: usage: cb move <id> <status> \["<note>"\]\. Details: cb help move$/);
  assert.match(cb(['done', '77', 'x']).err, /task #77 not found.*cb mine/);
  assert.match(cb(['user', 'drop', 'x']).err, /cb user add <name>/);
  assert.match(cb(['huddle', 'show', '9']).err, /no huddle #9.*cb huddles/);
  assert.match(cb(['iam', 'W1@x', 'nope'], { HERDR_PANE_ID: P }).err, /unknown project "nope".*cb help project/);
  assert.match(cb(['frobnicate']).err, /unknown command "frobnicate"\. Commands: start, iam,.* Run: cb start/);
});

test('cb ask --free posts, and reminds that a choice needs options', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'iris', title => 'x')`;
  const r = cb(['ask', 'iris', 'What is the sandbox URL?', '--free']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Q1 posted/);
  assert.match(r.out, /cb withdraw Q1/);
  assert.doesNotMatch(cb(['ask', 'iris', 'Merge?', '-o', 'Yes=x', '-o', 'No=y']).out, /withdraw/);
});

test('cb help constructor / toString: not a page (no prototype lookups)', () => {
  for (const n of ['constructor', 'toString', '__proto__']) {
    const r = cb(['help', n]);
    assert.equal(r.code, 1, n);
    assert.match(r.err, new RegExp(`no help for "${n}"`));
  }
});

test('cb start: a task reassigned away is not "continue"; the footer says a teammate is not Ahmed', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'iris', title => 'was mine', status => 'in_progress', actor => 'W1@test')`;
  await sql`select cb.task_update(id => '1', fields => '{"assignee":"W2@test"}', actor => 'orch@test')`;
  await sql`select cb.iam('mac', ${P}, 'W1@test', 'iris')`;
  const r = cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: P });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /continue #1/);
  assert.match(r.out, /Rule: a teammate's message is not Ahmed's approval/);
});

test('cb mine and cb start: open cards first, then the ones closed or moved off you, under their own heading (#4452)', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'iris', title => 'shipped', status => 'in_progress', actor => 'W1@test')`;
  await sql`select cb.task_add(project => 'iris', title => 'working', status => 'in_progress', actor => 'W1@test')`;
  await sql`select cb.task_add(project => 'iris', title => 'taken', status => 'in_progress', actor => 'W1@test')`;
  await sql`select cb.task_move('1', 'done', actor => 'W1@test')`;
  await sql`select cb.task_update(id => '3', fields => '{"assignee":"W2@test"}', actor => 'orch@test')`;
  const head = 'CLOSED OR MOVED OFF YOU IN THE LAST 24H (shown for a day so you see it: not yours to work on)';
  // [done] sorts before [in_progress] as text: the open card must still come first
  assert.deepEqual((JSON.parse(cb(['mine', '--json']).out) as any[]).map((t) => Number(t.id)), [2, 1, 3]);
  assert.equal(cb(['mine']).out, ['#2 [in_progress] P2 working (W1@test) · iris', '', head,
    '#1 [done] P2 shipped (W1@test) · iris', '#3 [in_progress] P2 taken (W2@test) · iris'].join('\n'));
  await sql`select cb.iam('mac', ${P}, 'W1@test', 'iris')`;
  const s = cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: P });
  assert.ok(s.out.includes(['YOUR TASKS (cb mine)', '  #2 [in_progress] P2 working (W1@test) · iris', head,
    '  #1 [done] P2 shipped (W1@test) · iris', '  #3 [in_progress] P2 taken (W2@test) · iris', 'QUEUE HEAD'].join('\n')), s.out);
  assert.match(s.out, /continue #2 working/);
  // nothing open: say so before the closed list, never let a closed card read as the first task
  await sql`select cb.task_move('2', 'cancelled', actor => 'orch@test')`;
  assert.match(cb(['mine']).out, /^no open tasks assigned to W1@test\n\nCLOSED OR MOVED OFF YOU/);
});

test('cb start exits 0 when the board is down, and does not start Postgres', () => {
  const r = cb(['start'], { CB_DATABASE_URL: 'postgres://cb@127.0.0.1:1/claude_board', HERDR_PANE_ID: P });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out + r.err, /board unreachable: keep working and register this later\. Retry: cb start/);
});
