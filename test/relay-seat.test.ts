// #4610: a non-Claude seat's relay. Its prestart starts it before herdr starts the agent, so the watchdog gives a seat
// whose agent is not up yet a grace period, and the relay finds the seat's herdr agent name by its pane (codex and agy
// deliver and read liveness through herdr by that name). The prestart starts it only when the seat is ready. Pure: no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { herdrNameForPane, watchdogStep, START_GRACE_MS } from '../cli/relay-seat.ts';
import { main } from '../cli/agents/seat-prestart.ts';

test('herdrNameForPane: the herdr agent in this pane, by pane id; none: null', () => {
  const list = { result: { agents: [{ name: 'demo-b1-pc', pane_id: 'w2:p3' }, { name: 'demo-r1-pc', pane_id: 'w2:p4' }] } };
  assert.equal(herdrNameForPane(list, 'w2:p4'), 'demo-r1-pc');
  assert.equal(herdrNameForPane(list, 'w9:p9'), null);
  assert.equal(herdrNameForPane(null, 'w2:p3'), null);
  assert.equal(herdrNameForPane({ agents: [{ name: 7, pane_id: 'w2:p3' }] }, 'w2:p3'), null);
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
