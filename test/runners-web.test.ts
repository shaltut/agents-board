// The Runners page (#4527): its words and how it lines up with db/schema.sql and the page list. No database: pure
// functions and file reads, in the style of test/settings-web.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  actionError, capacity, duration, logCommand, modeWords, paramsLine, recipeLabel, result, STATE_WORDS, waitWords, who, type JobState, type Runner, type Why,
} from '../web/src/lib/runners.ts';
import { PAGES, visiblePages } from '../web/src/lib/route.ts';
import { NO_ACTOR } from '../web/src/lib/api.ts';

const root = join(import.meta.dirname, '..');
const schema = readFileSync(join(root, 'db', 'schema.sql'), 'utf8');
const at = () => '10:12';
const RAW = /\b(queued|passed|failed|error|cancelled|draining|no_runner|undefined|null|NaN|exit)\b|_/; // keys and state names; plain words like held or lane are fine

test('Runners is a built screen for every admin, in the Machines menu', () => {
  const page = PAGES.find((p) => p.view === 'runners');
  assert.equal(page?.group, 'machines');
  assert.ok(!page?.owner, 'every admin (Q2978)');
  const app = readFileSync(join(root, 'web', 'src', 'App.tsx'), 'utf8');
  const screens = app.match(/const SCREENS[^=]*= \{([^}]*)\}/)?.[1] ?? '';
  assert.match(screens, /\brunners: Runners\b/);
  assert.ok(visiblePages(false, (v) => v === 'runners').some((p) => p.view === 'runners'));
});

test('every action the page calls takes an actor in db/schema.sql (rpc() adds it) and is on the server\'s allowlist', () => {
  const rpcList = readFileSync(join(root, 'server', 'rpc.ts'), 'utf8');
  for (const fn of ['job_cancel', 'job_retry', 'job_move', 'job_hold', 'runner_set', 'runner_limits_set']) {
    const m = schema.match(new RegExp(`create function cb\\.${fn}\\(([^)]*)\\)`));
    assert.ok(m && /\bactor\b/.test(m[1]!), `cb.${fn} takes an actor`);
    assert.ok(!NO_ACTOR.has(fn));
    assert.ok(rpcList.includes(`'${fn}'`), `${fn} is in RPC_FUNCTIONS`);
  }
});

test('every reason cb.runner_queue gives reads as words, with no key, state name or number code', () => {
  const reasons = [...schema.matchAll(/jsonb_build_object\('reason', '(\w+)'/g)].map((m) => m[1]!);
  for (const r of ['next', 'no_runner', 'held', 'down', 'lane', 'slot']) assert.ok(reasons.includes(r), `the schema gives ${r}`);
  const whys: Why[] = [
    { reason: 'next' }, { reason: 'no_runner' }, { reason: 'held', by: 'L1@pc', at: '2026-01-01T10:12:00Z' },
    { reason: 'down', runner: 'pc', since: null }, { reason: 'paused', runner: 'pc', by: 'ahmed', at: '2026-01-01T10:12:00Z' },
    { reason: 'draining', runner: 'pc', by: 'ahmed', at: null }, { reason: 'lane', busy: 4, of: 4 }, { reason: 'slot', busy: 7, of: 10 },
  ];
  for (const w of whys) {
    const s = waitWords(w, at);
    assert.ok(s.length > 5 && !RAW.test(s), `${w.reason}: "${s}"`);
  }
  assert.equal(waitWords({ reason: 'lane', busy: 4, of: 4 }), 'Waiting for a database lane (4 of 4 busy)');
  assert.equal(waitWords({ reason: 'paused', runner: 'pc', by: 'ahmed', at: 'x' }, at), 'The runner is paused by Ahmed since 10:12');
  assert.equal(waitWords({ reason: 'mystery' } as any), 'Waiting', 'an unknown reason is never shown as its key');
});

test('every state and every summary the board or runner writes itself maps to plain words; job output stays apart', () => {
  for (const s of Object.keys(STATE_WORDS) as JobState[]) assert.ok(!RAW.test(STATE_WORDS[s]), s);
  const board: [JobState, string, RegExp][] = [
    ['cancelled', 'cancelled by ahmed', /^Stopped by Ahmed\.$/],
    ['error', 'error: push it first', /not on GitHub yet/],
    ['error', 'error: not on a branch of origin', /not on GitHub yet/],
    ['error', 'error: could not fetch from origin', /Could not download/],
    ['error', 'error: runner restarted', /runner restarted/],
    ['error', 'error: timed out after 20 min', /longer than 20 minutes/],
    ['error', 'error: Docker is not running', /Docker was not running/],
    ['error', "error: not in the repo at abcdef123456: a.ts, b.ts (paths are relative to the recipe's folder, apps/x)", /^A file it was asked to run is not in that commit: a\.ts, b\.ts$/],
    ['error', 'error: bad parameter files: no', /value given for files/],
    ['error', 'error: could not start pnpm', /Could not start pnpm/],
    ['error', 'error: the runner lost the board connection while claiming it', /lost its link/],
    ['error', 'error: runner fault: see cb job log 9', /log on the PC/],
  ];
  // the summaries cli/runner-job.ts and the schema write: each one above is still written somewhere
  const sources = schema + readFileSync(join(root, 'cli', 'runner-job.ts'), 'utf8') + readFileSync(join(root, 'cli', 'recipes.ts'), 'utf8');
  for (const s of ['error: push it first', 'error: could not fetch from origin', 'error: runner restarted', 'error: Docker is not running', 'error: not in the repo at', 'error: bad parameter', 'error: the runner lost the board connection', 'cancelled by ']) {
    assert.ok(sources.includes(s), `"${s}" is still written by the board or the runner`);
  }
  for (const [state, summary, want] of board) {
    const r = result({ state, summary });
    assert.match(r.said, want, summary);
    assert.equal(r.output, null, `${summary}: the board's own words are not shown as job output`);
    assert.ok(!/error:/.test(r.said));
  }
  const out = result({ state: 'failed', summary: '12 passed, 1 failed. Failing: limits <b>x</b>' });
  assert.deepEqual(out, { said: 'Failed.', output: '12 passed, 1 failed. Failing: limits <b>x</b>' }, 'output kept as text, never words of the board');
  assert.deepEqual(result({ state: 'error', summary: 'something new' }), { said: 'Could not run.', output: 'something new' });
  assert.deepEqual(result({ state: 'passed', summary: null }), { said: 'Passed.', output: null });
});

const runner = (o: Partial<Runner>): Runner => ({ name: 'pc', last_seen: '2026-01-01T10:00:00Z', started_at: null, alive: true, mode: 'on', mode_by: null, mode_at: null,
  slots: 10, db_lanes: 4, slots_set: null, lanes_set: null, set_by: null, set_at: null, busy: 0, busy_db: 0, cap: 10, lanes: 4, ...o });

test('the runner card: taking jobs, paused, draining then ready, not answering', () => {
  assert.deepEqual(modeWords(runner({}), at), { text: 'Taking jobs', tone: 'ok' });
  assert.equal(modeWords(runner({ mode: 'paused', mode_by: 'ahmed', mode_at: 'x' }), at).text, 'Paused by Ahmed at 10:12: takes no new jobs');
  assert.equal(modeWords(runner({ mode: 'draining', busy: 3 }), at).text, 'Finishing 3 jobs before a restart: takes no new jobs');
  assert.equal(modeWords(runner({ mode: 'draining', busy: 0 }), at).text, 'Ready to restart: nothing is running');
  assert.deepEqual(modeWords(runner({ alive: false }), at), { text: 'Not answering since 10:12', tone: 'bad' });
});

test('slots: in use of the lower count; a higher setting is planned until the runner restarts; a lower one applies now', () => {
  assert.deepEqual(capacity(7, 10, null, 'slot'), { used: '7 of 10 in use', of: 10, plan: null });
  assert.equal(capacity(3, 10, 14, 'slot').plan, 'Set to 14: takes effect when the runner restarts');
  assert.equal(capacity(3, 10, 14, 'slot').of, 10);
  assert.equal(capacity(7, 10, 5, 'slot').plan, 'Set to 5 on the board (the runner has 10). No new jobs start until 2 finish');
  assert.match(capacity(2, null, null, 'slot').used, /has not reported/);
  assert.equal(capacity(1, null, 3, 'lane').used, '1 of 3 in use');
  // review M3: the runner started after the setting and could not use it: no promise of a restart
  const refused = capacity(3, 10, 14, 'slot', true).plan!;
  assert.equal(refused, 'Set to 14, but the runner could not use this setting and kept 10 from its own file. Its log on the PC says why');
  assert.doesNotMatch(refused, /restarts/);
  assert.equal(capacity(7, 10, 5, 'slot', true).plan, 'Set to 5 on the board (the runner has 10). No new jobs start until 2 finish', 'a lower one still applies');
});

test('times, the log command, parameters and names', () => {
  assert.deepEqual([duration(48_000), duration(252_000), duration(240_000), duration(3_780_000)], ['48 s', '4 min 12 s', '4 min', '1 h 3 min']);
  assert.equal(logCommand({ id: 58123, started_at: '2026-01-01T10:00:00Z' }), 'cb job log 58123 --tail 80');
  assert.equal(logCommand({ id: 1, started_at: null }), null, 'no log before it started');
  assert.equal(paramsLine({ files: ['a', 'b', 'c', 'd', 'e'], app: [] }), 'Files: a, b, c and 2 more');
  // review minor 2: parameter names in words, never ws: as typed
  assert.equal(paramsLine({ ws: ['web'], app: ['api'] }), 'Workspaces: web · App: api');
  assert.equal(paramsLine({ test_name: ['x'], onlyThis: ['y'] }), 'Test name: x · Only this: y');
  assert.deepEqual([who('ahmed'), who('runner'), who('B1@mac'), who(null)], ['Ahmed', 'the runner', 'B1@mac', 'someone']);
  assert.deepEqual(recipeLabel('itest'), { text: 'Database tests', command: false });
  assert.deepEqual(recipeLabel('kbx'), { text: 'cb run kbx', command: true }, 'an unknown recipe shows as the word sessions type');
});

test('a refused action shows the board\'s own refusal or plain words, never a raw error', () => {
  assert.equal(actionError(new Error('Only Ahmed manages the runner queue on the board; a project\'s lead uses cb job.')), 'Only Ahmed manages the runner queue on the board; a project\'s lead uses cb job.');
  assert.equal(actionError(new Error('the same check is already waiting or running as job #12')), 'The same check is already waiting or running (job #12).');
  assert.match(actionError(new Error('job #4 is not waiting any more: it started or ended')), /moved on/);
  assert.equal(actionError(new Error('slots must be 1 to 64')), 'Slots must be 1 to 64.');
  for (const raw of ['connection terminated unexpectedly', 'relation "cb.jobs" does not exist', 'Failed to fetch', '']) {
    assert.equal(actionError(new Error(raw)), 'That did not go through. Try again in a moment.', raw);
  }
  assert.equal(actionError('x'), 'That did not go through. Try again in a moment.');
});
