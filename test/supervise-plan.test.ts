import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTick, type State, type Session, type TickInput } from '../cli/supervise-plan.ts';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const mach = (herdr: string | null) => ({ herdr, repo: '/r/sv', board: '/b' });
const squad = {
  machines: { shaltoot: mach(null), macbook: mach('macbook') },
  roles: {
    lead: { count: 1, model: 'opus', machine: 'shaltoot' },
    architect: { count: 1, model: 'opus', machine: 'macbook' },
    owner: { model: 'sonnet', machine: 'macbook' },
    builder: { count: 2, model: 'sonnet', machine: 'macbook' },
    reviewer: { count: 1, model: 'opus', machine: 'macbook' },
  },
  areas: ['claims', 'kb'], supervise: true,
};
const sess = (actor: string, role: string, o: Partial<Session> = {}): Session => ({ actor, role, area: null, machine: 'macbook', pane: 'p', live: true, repo: 'main',
  holds: 0, questions: 0, jobs: 0, asks: 0, last_event: ago(1), closing: false, last_restore: null, last_restore_failed: false, down_again_logged: false, down_again_since_bind: false, ...o });
const state = (o: { waiting?: Record<string, any>; sessions?: Session[]; supervised?: boolean } = {}): State => ({ project: 'sv', squad, supervised: o.supervised ?? true,
  waiting: { builder: { main: 0 }, reviewer: { main: 0 }, qa: 0, investigator: 0, architect: 0, owner: { claims: 0, kb: 0 }, ...o.waiting }, sessions: o.sessions ?? [] });
const tick = (st: State, o: Partial<TickInput> = {}) => planTick({ state: st, herdrLive: new Set(), herdrStatus: {}, herdrDown: new Set(), launched: new Set(), macLive: 0, startsLeft: 3, failedAt: new Map(), now: NOW, ...o });
const names = (l: { name: string }[]) => l.map((x) => x.name);

test('not supervised: empty plan', () => {
  assert.deepEqual(tick(state({ supervised: false, waiting: { builder: { main: 5 } } })), { restore: [], start: [], close: [], notes: [] });
});

test('starts up to the count', () => {
  const p = tick(state({ waiting: { builder: { main: 5 } } }));
  assert.deepEqual(names(p.start), ['sv-B1@macbook', 'sv-B2@macbook']);
  assert.ok(p.start[0].prompt.endsWith('then cb next'));
  assert.equal(p.start[0].model, 'sonnet');
  assert.equal(p.start[0].settings, '/b/kit/permissions/builder.json');
});

test('idle sessions cancel waiting work; a closing one does not', () => {
  const idle = sess('sv-B1@macbook', 'builder');
  assert.equal(tick(state({ waiting: { builder: { main: 1 } }, sessions: [idle] })).start.length, 0);
  const p = tick(state({ waiting: { builder: { main: 1 } }, sessions: [{ ...idle, closing: true }] }));
  assert.deepEqual(names(p.start), ['sv-B2@macbook']);
});

test('a hand-started session counts and is never closed', () => {
  const foo = sess('foo@macbook', 'builder', { last_event: ago(30) });
  assert.equal(tick(state({ waiting: { builder: { main: 1 } }, sessions: [foo] })).start.length, 0);
  assert.deepEqual(tick(state({ sessions: [foo] })).close, []);
});

test('the Mac cap counts other projects', () => {
  assert.equal(tick(state({ waiting: { builder: { main: 5 } } }), { macLive: 7 }).start.length, 1);
});

test('3 starts per tick', () => {
  const p = tick(state({ waiting: { builder: { main: 5 }, reviewer: { main: 3 }, architect: 2 } }), { startsLeft: 3 });
  assert.equal(p.start.length, 3);
});

test('a name this run launched and the board does not see yet counts as started; any other herdr name does not', () => {
  const live = new Set(['sv-b1-macbook']); // in herdr, not live on the board
  const launched = new Set(['sv-B1@macbook']); // this supervisor started it last tick (still binding, or on a dialog)
  assert.equal(tick(state({ waiting: { builder: { main: 1 } } }), { herdrLive: live, launched }).start.length, 0);
  assert.deepEqual(names(tick(state({ waiting: { builder: { main: 2 } } }), { herdrLive: live, launched }).start), ['sv-B2@macbook']);
  const old = sess('sv-B1@macbook', 'builder', { live: false }); // an old board row, not live
  assert.equal(tick(state({ waiting: { builder: { main: 1 } }, sessions: [old] }), { herdrLive: live, launched }).start.length, 0);
  // not launched by this run: it cancels no waiting work, and the next number starts
  assert.deepEqual(names(tick(state({ waiting: { builder: { main: 1 } } }), { herdrLive: live }).start), ['sv-B2@macbook']);
});

test('a recently failed name is skipped, the next number is used', () => {
  const p = tick(state({ waiting: { builder: { main: 1 } } }), { failedAt: new Map([['sv-B1@macbook', NOW - 5 * 60_000]]) });
  assert.deepEqual(names(p.start), ['sv-B2@macbook']);
  assert.deepEqual(names(tick(state({ waiting: { builder: { main: 1 } } }), { failedAt: new Map([['sv-B1@macbook', NOW - 11 * 60_000]]) }).start), ['sv-B1@macbook']);
});

test('close rules', () => {
  const c = (s: Session, w = {}) => tick(state({ sessions: [s], waiting: w }), { herdrStatus: { 'sv-b1-macbook': 'idle' } }).close;
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21) })), ['sv-B1@macbook']);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(19) })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21), holds: 1 })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21), questions: 1 })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21), jobs: 1 })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21), asks: 1 })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21), closing: true })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21) }), { builder: { main: 1 } }), []);
  assert.deepEqual(c(sess('orch@shaltoot', 'lead', { last_event: ago(90) })), []);
});

test('owners per area; architect only from waiting.architect', () => {
  const p = tick(state({ waiting: { owner: { claims: 0, kb: 2 }, architect: 0 } }));
  assert.deepEqual(names(p.start), ['sv-O-kb@macbook']);
  assert.equal(p.start[0].area, 'kb');
  assert.deepEqual(names(tick(state({ waiting: { architect: 1 } })).start), ['sv-A1@macbook']);
});

test('restore, down_again, herdr down, and no reuse of a holding name', () => {
  const down = sess('sv-B1@macbook', 'builder', { live: false, holds: 1 });
  const p = tick(state({ sessions: [down] }));
  assert.deepEqual(names(p.restore), ['sv-B1@macbook']);
  assert.ok(p.restore[0].prompt.endsWith('then cb resume'));
  const again = tick(state({ sessions: [{ ...down, last_restore: ago(10) }] }));
  assert.deepEqual([again.restore, again.notes], [[], [{ what: 'down_again', session: 'sv-B1@macbook' }]]);
  assert.deepEqual(tick(state({ sessions: [{ ...down, last_restore: ago(10), down_again_logged: true }] })).notes, []);
  assert.equal(tick(state({ sessions: [{ ...down, last_restore: ago(31) }] })).restore.length, 1);
  assert.deepEqual(tick(state({ sessions: [down] }), { herdrDown: new Set(['macbook']) }), { restore: [], start: [], close: [], notes: [] });
  const quiet = sess('sv-B2@macbook', 'builder', { last_event: ago(21) });
  const idleB2 = { herdrStatus: { 'sv-b2-macbook': 'idle' } };
  assert.deepEqual(tick(state({ sessions: [quiet] }), { ...idleB2, herdrDown: new Set(['macbook']) }).close, []);
  assert.deepEqual(tick(state({ sessions: [quiet] }), idleB2).close, ['sv-B2@macbook']);
  assert.equal(tick(state({ sessions: [down] }), { herdrLive: new Set(['sv-b1-macbook']) }).restore.length, 0);
  assert.deepEqual(names(tick(state({ sessions: [down], waiting: { builder: { main: 2 } } })).start), ['sv-B2@macbook']);
});

test('a holding name is not reused for a start even when its restore is held back', () => {
  const down = sess('sv-B1@macbook', 'builder', { live: false, holds: 1, last_restore: ago(10), down_again_logged: true });
  assert.deepEqual(names(tick(state({ sessions: [down], waiting: { builder: { main: 2 } } })).start), ['sv-B2@macbook']);
});

test('restores use up startsLeft', () => {
  const down = sess('sv-R1@macbook', 'reviewer', { live: false, holds: 1 });
  const p = tick(state({ sessions: [down], waiting: { builder: { main: 5 } } }), { startsLeft: 2 });
  assert.equal(p.restore.length, 1);
  assert.equal(p.start.length, 1);
});

test('close only when herdr reports the agent ready for input (idle, or done: unfocused panes stay done)', () => {
  const quiet = state({ sessions: [sess('sv-B1@macbook', 'builder', { last_event: ago(21) })] });
  for (const st of ['idle', 'done']) assert.deepEqual(tick(quiet, { herdrStatus: { 'sv-b1-macbook': st } }).close, ['sv-B1@macbook'], st);
  for (const st of ['working', 'blocked', 'unknown']) assert.deepEqual(tick(quiet, { herdrStatus: { 'sv-b1-macbook': st } }).close, [], st);
  assert.deepEqual(tick(quiet).close, [], 'not in herdr: no close');
});

test('a session with an open ask is not idle: it cancels no waiting work', () => {
  const asked = sess('sv-B1@macbook', 'builder', { asks: 1 });
  assert.deepEqual(names(tick(state({ waiting: { builder: { main: 1 } }, sessions: [asked] })).start), ['sv-B2@macbook']);
});

test('down again since it last bound: never restored again until it binds', () => {
  const down = sess('sv-B1@macbook', 'builder', { live: false, holds: 1, last_restore: ago(31), down_again_logged: true, down_again_since_bind: true });
  const p = tick(state({ sessions: [down] }));
  assert.deepEqual([p.restore, p.notes], [[], []]);
  assert.equal(tick(state({ sessions: [{ ...down, down_again_since_bind: false }] })).restore.length, 1);
});

test('a restore that did not start is tried again after 10 minutes and is never down again', () => {
  const down = sess('sv-B1@macbook', 'builder', { live: false, holds: 1, last_restore_failed: true });
  const soon = tick(state({ sessions: [{ ...down, last_restore: ago(5) }] }));
  assert.deepEqual([soon.restore, soon.notes], [[], []]);
  assert.deepEqual(names(tick(state({ sessions: [{ ...down, last_restore: ago(11) }] })).restore), ['sv-B1@macbook']);
  // this run's own memory of the failure holds it back too
  assert.equal(tick(state({ sessions: [{ ...down, last_restore: ago(11) }] }), { failedAt: new Map([['sv-B1@macbook', NOW - 5 * 60_000]]) }).restore.length, 0);
});

// several repos (#3703): builders and reviewers start, count and close per repo, each in its repo's folder
const QHS: any = {
  machines: { shaltoot: { herdr: null, board: '/b' }, macbook: { herdr: 'macbook', board: '/b' } },
  repos: { api: { home: true, paths: { shaltoot: '/q/api', macbook: '/m/api' } }, dashboard: { home: false, paths: { shaltoot: '/q/dash', macbook: '/m/dash' } } },
  areas: [{ name: 'api', repo: 'api' }, { name: 'dashboard', repo: 'dashboard' }],
  roles: { lead: { count: 1, model: 'opus', machine: 'shaltoot' }, owner: { model: 'opus', machine: 'shaltoot' },
           builder: { count: { api: 2, dashboard: 1 }, model: 'sonnet', machine: 'macbook' },
           reviewer: { count: { api: 1, dashboard: 1 }, model: 'opus', machine: 'macbook' } },
  supervise: true,
};
const qhs = (builder: Record<string, number>, sessions: Session[] = []): State => ({ project: 'qhs', squad: QHS, supervised: true, sessions,
  waiting: { builder, reviewer: { api: 0, dashboard: 0 }, qa: 0, investigator: 0, architect: 0, owner: { api: 0, dashboard: 0 } } });

test('starts per repo', () => {
  const p = tick(qhs({ api: 0, dashboard: 2 }));
  assert.deepEqual(names(p.start), ['qhs-dashboard-B1@macbook']); // the dashboard count is 1; never an api builder
  assert.equal(p.start[0].cwd, '/m/dash');
  assert.ok(p.start[0].prompt.includes('--repo dashboard'));
  // an idle api builder does not cancel dashboard work; an idle dashboard builder does
  const apiIdle = sess('qhs-B1@macbook', 'builder', { repo: 'api' });
  assert.deepEqual(names(tick(qhs({ api: 0, dashboard: 1 }, [apiIdle])).start), ['qhs-dashboard-B1@macbook']);
  assert.deepEqual(names(tick(qhs({ api: 1, dashboard: 0 }, [apiIdle])).start), []);
  assert.deepEqual(names(tick(qhs({ api: 2, dashboard: 0 }, [apiIdle])).start), ['qhs-B2@macbook']);
  // close rules apply per repo group: the api builder closes while dashboard work waits, never the dashboard one
  const quiet = (n: string, repo: string) => sess(n, 'builder', { repo, last_event: ago(21) });
  const ready = { herdrStatus: { 'qhs-b1-macbook': 'idle', 'qhs-dashboard-b1-macbook': 'idle' } };
  const both = [quiet('qhs-B1@macbook', 'api'), quiet('qhs-dashboard-B1@macbook', 'dashboard')];
  assert.deepEqual(tick(qhs({ api: 0, dashboard: 1 }, both), ready).close, ['qhs-B1@macbook']);
  assert.deepEqual(tick(qhs({ api: 1, dashboard: 0 }, both), ready).close, ['qhs-dashboard-B1@macbook']);
});
