// #4610: a non-Claude seat's relay. Its prestart starts it before herdr starts the agent, so the watchdog gives a seat
// whose agent is not up yet a grace period, and the relay finds the seat's herdr agent name by its pane (codex and agy
// deliver and read liveness through herdr by that name). The prestart starts it only when the seat is ready. Pure: no DB.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { herdrNameForPane, namelessDead, watchdogStep, START_GRACE_MS } from '../cli/relay-seat.ts';
import { seatKey } from '../cli/bridge.ts';
import { freshDb, TEST_URL } from './helpers.ts';
import { main } from '../cli/agents/seat-prestart.ts';

test('herdrNameForPane: the herdr agent of this kind in this pane; another kind or none: null (review 98 M1)', () => {
  const list = { result: { agents: [{ name: 'demo-b1-pc', pane_id: 'w2:p3', agent: 'codex' }, { name: 'demo-r1-pc', pane_id: 'w2:p4', agent: 'codex' },
    { name: 'demo-l1-pc', pane_id: 'w2:p5', agent: 'claude' }] } };
  assert.equal(herdrNameForPane(list, 'w2:p4', 'codex'), 'demo-r1-pc');
  assert.equal(herdrNameForPane(list, 'w2:p4', 'agy'), null, 'a codex agent is not an agy seat');
  assert.equal(herdrNameForPane(list, 'w2:p5', 'codex'), null, 'a codex relay never takes a Claude agent');
  assert.equal(herdrNameForPane(list, 'w9:p9', 'codex'), null);
  assert.equal(herdrNameForPane(null, 'w2:p3', 'codex'), null);
  assert.equal(herdrNameForPane({ agents: [{ name: 7, pane_id: 'w2:p3', agent: 'codex' }] }, 'w2:p3', 'codex'), null);
});

test('namelessDead (review 98 I1): a codex or agy relay with no herdr name reads not alive; Claude and OpenCode never', () => {
  assert.equal(namelessDead('agy', undefined), true);
  assert.equal(namelessDead('codex', undefined), true);
  assert.equal(namelessDead('agy', 'demo-b1-pc'), false);
  assert.equal(namelessDead('claude', undefined), false);
  assert.equal(namelessDead('opencode', undefined), false);
});

test('watchdogStep: before the agent was ever alive, dead readings count only after the start grace', () => {
  const t0 = 1_000_000;
  let s = { dead: 0, seenAlive: false, startedAt: t0 };
  for (const dt of [2_000, 4_000, 60_000, START_GRACE_MS - 1]) {
    const r = watchdogStep(s, false, t0 + dt);
    assert.equal(r.leave, false, `at +${dt} ms`);
    s = r.state;
  }
  let r = watchdogStep(s, false, t0 + START_GRACE_MS + 1);
  assert.equal(r.leave, false, 'the first dead reading past the grace only counts');
  r = watchdogStep(r.state, false, t0 + START_GRACE_MS + 2001);
  assert.equal(r.leave, true);
});

test('watchdogStep: once alive, two dead readings in a row leave; an alive reading between resets', () => {
  const t0 = 5_000;
  let r = watchdogStep({ dead: 0, seenAlive: false, startedAt: t0 }, true, t0 + 2000);
  assert.deepEqual(r.state, { dead: 0, seenAlive: true, startedAt: t0 });
  r = watchdogStep(r.state, false, t0 + 4000);
  assert.equal(r.leave, false);
  r = watchdogStep(r.state, true, t0 + 6000);
  assert.equal(r.state.dead, 0);
  r = watchdogStep(r.state, false, t0 + 8000);
  r = watchdogStep(r.state, false, t0 + 10000);
  assert.equal(r.leave, true, 'a seat seen alive gets no grace: its agent quit');
});

test('seat prestart check: a ready seat starts its relay (pane and agent), a refused one does not', () => {
  const started: string[][] = [], out: string[] = [];
  const ok = main(['check', 'codex', 'pc', 'w2:p3', 'n0nce'], (s) => out.push(s), { refusal: () => null, startRelay: (a, p) => started.push([a, p]) });
  assert.equal(ok, 0);
  assert.deepEqual(started, [['codex', 'w2:p3']]);
  assert.equal(out.join(''), 'cb-seat-ready:n0nce\n');
  const no = main(['check', 'agy', 'pc', 'w2:p4', 'n0nce'], (s) => out.push(s), { refusal: () => 'no guard', startRelay: (a, p) => started.push([a, p]) });
  assert.equal(no, 1);
  assert.equal(started.length, 1);
  // a relay that cannot start never refuses the seat: the line still says ready (the lead runs cb relay by hand)
  const out2: string[] = [];
  assert.equal(main(['check', 'codex', 'pc', 'w2:p5', 'n1'], (s) => out2.push(s), { refusal: () => null, startRelay: () => { throw new Error('spawn failed'); } }), 0);
  assert.equal(out2.join(''), 'cb-seat-ready:n1\n');
});

// Review 98 I1 and L3: relay.ts itself, with a non-Claude agent whose seat never comes up in herdr (a pane no herdr agent
// is in). agy's own isAlive says alive with no herdr name, so before the fix this relay heartbeated forever. Now it
// leaves once the start grace (shortened here) ends, and never writes a row for its pane.
const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
test('relay.ts: an agy relay whose agent never registers leaves after the start grace, with no heartbeat row', { timeout: 60_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  const M = 'testbox', pane = `p-agy-ghost-${process.pid}`, key = seatKey(M, pane);
  const files = ['pid', 'log'].map((x) => join(tmpdir(), `cb-relay-${key}.${x}`));
  for (const f of files) fs.rmSync(f, { force: true });
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CB_DATABASE_URL: TEST_URL, CB_MACHINE: M, CB_MCP_GATE_OK: 'agy',
    CB_AGENT: '', PGAPPNAME: '', CB_RELAY_START_GRACE_MS: '1500', CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '' };
  delete env.HERDR_PANE_ID; delete env.CB_ACTOR;
  const relay = spawn('node', ['cli/relay.ts', '--child', '--pane', pane, '--agent', 'agy'], { stdio: 'ignore', env });
  try {
    const code = await Promise.race([new Promise((r) => relay.on('exit', r)), new Promise((r) => setTimeout(() => r('still running'), 45_000))]);
    const log = fs.existsSync(files[1]!) ? fs.readFileSync(files[1]!, 'utf8') : '';
    assert.notEqual(code, 'still running', log);
    assert.match(log, /agent gone; exiting/, log);
    assert.equal((await sql`select count(*)::int as n from cb.sessions where machine = ${M} and pane = ${pane}`)[0].n, 0, 'no ghost row');
  } finally {
    if (relay.exitCode === null) relay.kill();
    for (const f of files) fs.rmSync(f, { force: true });
  }
});
