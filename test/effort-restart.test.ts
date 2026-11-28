// #4766: a session says the effort it was started with, and a seat whose squad effort changed is restarted once idle.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';
import { launchFor, seatSpec, wantList, type Squad } from '../cli/squad-up.ts';
import { planTick, type Session, type State } from '../cli/supervise-plan.ts';
import { seatNote, type Seat } from '../web/src/lib/squad.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); await s`select cb.ensure_project('demo')`; return s; }

const M = 'pc', PANE = `w766:p${process.pid}`, WHO = 'demo-B1@pc';
// a made-up one-machine squad (the repo is public: no real names or paths)
const SQUAD: any = {
  machines: { pc: { herdr: null, repo: 'C:/src/demo', board: 'C:/board' } },
  roles: { lead: { count: 1, model: 'opus', machine: 'pc' }, builder: { count: 3, model: 'sonnet', machine: 'pc' } },
  areas: [],
};
const mod = (f: (s: any) => void): any => { const s = structuredClone(SQUAD); f(s); return s; };
// seat 2 has an effort of its own; seat 3 runs another agent, so the role's effort is not its own
const MIXED = mod((s) => {
  s.roles.builder.effort = 'high';
  s.roles.builder.seats = { '2': { effort: 'low' }, '3': { agent: 'codex', model: 'gpt-6.1-sol' } };
});
const want = (sq: any, name: string) => wantList('demo', sq).find((w) => w.name === name)!;

const iam = (sql: any, who = WHO, agent: string | null = null) =>
  sql`select cb.iam(${M}, ${PANE}, ${who}, 'demo', 'builder', null, 'sonnet', null, ${agent})`;
const say = (sql: any, effort: string) => sql`select cb.seat_effort(${M}, ${PANE}, ${effort})`;
const stored = async (sql: any) => (await sql`select effort from cb.sessions where machine = ${M} and pane = ${PANE}`)[0]?.effort;

test('seat_effort keeps what the session says, and refuses a word its agent does not take', async () => {
  const sql = await db();
  await iam(sql);
  assert.equal(await stored(sql), null, 'said nothing: unknown');
  await say(sql, 'high');
  assert.equal(await stored(sql), 'high');
  await say(sql, 'default');
  assert.equal(await stored(sql), 'default');
  await assert.rejects(() => say(sql, 'ultra'), /effort for claude must be default or one of low, medium, high, xhigh, max \(got "ultra"\): use the --effort of the seat's first prompt, or leave it out/);
  await assert.rejects(() => say(sql, ''), /effort for claude must be default or one of/);
  await iam(sql, WHO, 'opencode');
  await assert.rejects(() => say(sql, 'high'), /effort for opencode must be default \(got "high"\)/);
  await sql`select cb.seat_effort(${M}, 'w766:none', 'high')`; // an unknown pane: nothing
});

test('the effort lasts as long as the model does: a re-bind keeps it, another name or session starts clean', async () => {
  const sql = await db();
  await iam(sql);
  await say(sql, 'high');
  await iam(sql);
  assert.equal(await stored(sql), 'high', 'the same name binding again (after a compaction, say) keeps it');
  await sql`select cb.inbox(${M}, ${PANE}, 0, 'sid-1')`;
  await sql`select cb.inbox(${M}, ${PANE}, 0, 'sid-2')`;
  assert.equal(await stored(sql), null, 'another agent session in the pane');
  await iam(sql);
  await say(sql, 'low');
  await iam(sql, 'demo-B2@pc');
  assert.equal(await stored(sql), null, 'another name took the pane');
});

test('the wanted effort is the one seatSpec starts the seat with', async () => {
  const sql = await db();
  await sql`select cb.squad_set('demo', ${sql.json(MIXED)}, 'ahmed')`;
  for (const w of wantList('demo', MIXED)) {
    const [{ w: got }] = await sql`select cb._seat_want('demo', ${w.name}, ${w.role}, null, null) as w`;
    assert.equal(got.effort ?? undefined, seatSpec(MIXED, w).effort, w.name);
  }
});

test('supervise_state and the settings page carry the effort, and the page judges it', async () => {
  const sql = await db();
  await sql`select cb.squad_set('demo', ${sql.json(mod((s) => { s.roles.builder.effort = 'high'; }))}, 'ahmed')`;
  await iam(sql);
  const seat = async () => (await sql`select cb.squad_page('demo') as r`)[0].r.seats.find((s: any) => s.actor === WHO);
  const judged = async () => { const s = await seat(); return [s.effort, s.want_effort, s.same]; };
  assert.deepEqual(await judged(), [null, 'high', true], 'a session that said nothing is not judged on its effort');
  await say(sql, 'default');
  assert.deepEqual(await judged(), ['default', 'high', false]);
  await say(sql, 'high');
  assert.deepEqual(await judged(), ['high', 'high', true]);
  const [{ r }] = await sql`select cb.supervise_state('demo') as r`;
  assert.equal(r.sessions.find((s: any) => s.actor === WHO).effort, 'high');
  await sql`select cb.squad_set('demo', ${sql.json(SQUAD)}, 'ahmed', null, true)`;
  assert.deepEqual(await judged(), ['high', null, false], 'the squad went back to the agent\'s default');
  await say(sql, 'default');
  assert.deepEqual(await judged(), ['default', null, true]);
});

test('cb iam --effort stores it; a board without cb.seat_effort still binds', async () => {
  const sql = await db();
  const cb = (args: string[]) => spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: '', CB_AGENT: '', CB_MACHINE: M, HERDR_PANE_ID: PANE } });
  const row = async () => (await sql`select actor, effort from cb.sessions where pane = ${PANE}`)[0];
  const bind = ['iam', WHO, 'demo', '--role', 'builder', '--model', 'sonnet'];
  const r = cb([...bind, '--effort', 'xhigh']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual({ ...(await row()) }, { actor: WHO, effort: 'xhigh' });
  assert.equal(cb(bind).status, 0);
  assert.equal((await row()).effort, 'xhigh', 'no --effort: what it said before stays');
  // a board rolled back past #4766 has no such function: the bind itself must still work
  await sql`alter function cb.seat_effort(text, text, text) rename to seat_effort_gone`;
  try {
    const old = cb([...bind, '--effort', 'low']);
    assert.equal(old.status, 0, old.stderr);
  } finally { await sql`alter function cb.seat_effort_gone(text, text, text) rename to seat_effort`; }
});

test('a launch tells the session its effort, for every agent that takes one', () => {
  const prompt = (name: string, sq: any = MIXED) => launchFor('demo', sq, want(sq, name)).prompt;
  assert.match(prompt('demo-B1@pc'), /^cb iam demo-B1@pc demo --role builder --model sonnet --effort high, then /);
  assert.match(prompt('demo-B2@pc'), / --effort low, then /);
  assert.match(prompt('demo-B3@pc'), / --model gpt-6\.1-sol --effort default --agent codex, then /);
  assert.match(prompt('demo-B1@pc', SQUAD), / --model sonnet --effort default, then /);
  const open = mod((s) => { s.roles.builder.agent = 'opencode'; s.roles.builder.model = 'anthropic/claude-opus-5-5'; });
  assert.doesNotMatch(prompt('demo-B1@pc', open), /--effort/, 'opencode takes none');
});

const NOW = Date.parse('2026-11-28T12:00:00Z');
const squad = (effort?: string): Squad => mod((s) => { s.roles.builder.count = 1; s.supervise = true; if (effort) s.roles.builder.effort = effort; });
const session = (o: Partial<Session>): Session => ({ actor: WHO, role: 'builder', area: null, repo: 'main', machine: 'pc', pane: 'p', live: true,
  holds: 0, questions: 0, jobs: 0, asks: 0, last_event: new Date(NOW - 6 * 60_000).toISOString(), closing: false, last_restore: null,
  last_restore_failed: false, down_again_logged: false, down_again_since_bind: false, model: 'sonnet', ...o });
const plan = (wanted: string | undefined, o: Partial<Session>, tried?: string) => planTick({
  state: { project: 'demo', squad: squad(wanted), supervised: true, sessions: [session(o)],
    waiting: { builder: { main: 0 }, reviewer: { main: 0 }, qa: 0, investigator: 0, architect: 0, owner: {} } } as State,
  herdrLive: new Set(), herdrStatus: { 'demo-b1-pc': 'idle' }, herdrDown: new Set(), launched: new Set(), macLive: 0, startsLeft: 3,
  failedAt: new Map(), now: NOW, ...(tried ? { restartTried: new Map([[WHO, tried]]) } : {}) });
const restart = (p: ReturnType<typeof planTick>) => p.restart.map((r) => [r.from, r.to]);

test('an idle seat restarts when the effort it was started with is not the squad\'s', () => {
  assert.deepEqual(restart(plan('high', { effort: 'default' })), [['sonnet effort default', 'sonnet effort high']]);
  assert.deepEqual(restart(plan('high', { effort: 'low' })), [['sonnet effort low', 'sonnet effort high']]);
  assert.deepEqual(restart(plan(undefined, { effort: 'max' })), [['sonnet effort max', 'sonnet effort default']]);
  assert.match(plan('high', { effort: 'low' }).restart[0]!.launch.prompt, / --effort high, /);
  for (const [w, e] of [['high', 'high'], [undefined, 'default'], ['high', null], ['high', undefined], [undefined, null]] as const)
    assert.deepEqual(restart(plan(w, { effort: e })), [], `${w} ${e}`);
  assert.deepEqual(restart(plan('high', { effort: 'low', holds: 1 })), [], 'busy: it waits');
});

test('an effort restart is tried once per wanted effort, and forgotten once the seat is on it', () => {
  assert.deepEqual(restart(plan('high', { effort: 'low' }, 'sonnet effort high')), []);
  // the squad's effort moved on: another setting, tried again
  assert.deepEqual(restart(plan('max', { effort: 'low' }, 'sonnet effort high')), [['sonnet effort low', 'sonnet effort max']]);
  assert.deepEqual(plan('high', { effort: 'high' }, 'sonnet effort high').settled, [WHO]);
});

test('the settings page note names both efforts when they differ, and neither when they do not', () => {
  const seat: Seat = { actor: WHO, machine: 'pc', role: 'builder', area: null, repo: 'main', agent: 'claude', model: 'sonnet', in_squad: true,
    want_agent: 'claude', want_model: 'sonnet', effort: 'default', want_effort: 'high', same: false, holds: 0, last_seen: '' };
  assert.match(seatNote(seat, squad(), true)!, /runs Claude Code, Sonnet, default effort; the squad says Claude Code, Sonnet, high effort\./);
  assert.match(seatNote({ ...seat, effort: 'max', want_effort: null }, squad(), true)!, /runs Claude Code, Sonnet, max effort; the squad says Claude Code, Sonnet, default effort\./);
  assert.match(seatNote({ ...seat, effort: 'high', want_model: 'opus' }, squad(), true)!, /runs Claude Code, Sonnet; the squad says Claude Code, Opus\./);
});
