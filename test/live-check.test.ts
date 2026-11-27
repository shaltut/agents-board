// #4612: the live-check kit for Codex, agy and OpenCode seats. The scratch repo is synthetic and made in a temp folder,
// the squad file passes the board's own squad_set, and part A (the hook probes) runs against this checkout's guard
// without starting any agent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb } from './helpers.ts';
import { DEFAULT_MODELS, setup, squadFile } from '../kit/live-check/setup.mjs';
import { LIVE_STEPS, cases, runProbes, stepsFromFile } from '../kit/live-check/check.mjs';

const BOARD = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(BOARD, 'kit', 'guard');
const root = mkdtempSync(join(tmpdir(), 'cb-live-check-'));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

test('setup: a synthetic scratch repo with one commit, the decoy .env ignored, the squad file beside it (#4612)', () => {
  const dir = join(root, 'scratch');
  const r = setup({ dir, machine: 'box', board: BOARD });
  assert.equal(r.squadPath, `${dir}.squad.json`);
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD').stdout.trim(), '1');
  assert.equal(git(dir, 'status', '--porcelain').stdout, '', 'clean: .env is ignored');
  assert.equal(git(dir, 'config', 'user.email').stdout.trim(), 'live-check@example.invalid');
  assert.ok(!git(dir, 'ls-files').stdout.includes('.env'));
  const sq = JSON.parse(readFileSync(r.squadPath, 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.entries(sq.roles.builder.seats).map(([k, v]: [string, any]) => [k, v.agent])), { 1: 'codex', 2: 'agy', 3: 'opencode' });
  assert.equal(sq.roles.reviewer.seats['1'].agent, 'agy');
  assert.equal(sq.roles.builder.seats['1'].model, DEFAULT_MODELS.codex);
  // a folder that is not empty is refused, and nothing is written into it
  mkdirSync(join(root, 'busy'));
  writeFileSync(join(root, 'busy', 'x.txt'), 'x');
  assert.throws(() => setup({ dir: join(root, 'busy'), machine: 'box', board: BOARD }), /not empty/);
  assert.ok(!existsSync(join(root, 'busy', '.git')));
});

test('the squad file passes the board\'s own squad_set (agents and models included) (#4612)', async () => {
  const sql = await freshDb();
  try {
    const sq = squadFile({ machine: 'box', repo: '/w/live-check', board: '/w/board', herdr: null, workspace: 'Live Check', models: { codex: 'gpt-6.1-sol' } });
    await sql`select cb.task_add(project => 'live-check', title => 'live check', actor => 'orch')`;
    await sql`select cb.squad_set('live-check', ${sql.json(sq)}, 'ahmed')`;
    const [{ squad }] = await sql`select cb.squad_get('live-check') as squad`;
    assert.equal(squad.roles.builder.seats['3'].agent, 'opencode');
  } finally { await sql.end(); }
});

test('part A against this checkout\'s guard: every probe passes or names the PR it needs (#4612)', () => {
  const seat = join(root, 'probe-seat');
  setup({ dir: seat, machine: 'box', board: BOARD });
  const rows = runProbes({ guard: GUARD, seat, agents: ['codex', 'agy', 'opencode'] });
  assert.equal(rows.length, cases().length);
  // #4652: agy's edit tool is not fenced yet; the checklist reports it as a fail until that fix lands
  const known = (s: string) => /^agy builder: fence: the edit tool/.test(s);
  const bad = rows.filter((r) => r.status === 'fail' && !known(r.step));
  assert.deepEqual(bad, [], bad.map((r) => `${r.step}: ${r.detail}`).join('\n'));
  for (const r of rows.filter((x) => x.status === 'skip')) assert.match(r.detail, /^needs PR (96|104)/, r.step);
  // a guard folder without the agent shims fails by name, never passes
  const empty = join(root, 'no-guard');
  mkdirSync(empty);
  assert.ok(runProbes({ guard: empty, seat, agents: ['opencode'] }).every((r) => r.status === 'fail' || r.status === 'skip'));
});

test('part B: the PR 98 live check\'s 14 steps and the per-agent live steps are all there (#4612)', () => {
  const steps = stepsFromFile(join(BOARD, 'kit', 'live-check', 'pr98-steps.txt'));
  assert.equal(steps.length, 14);
  assert.match(steps[0], /^PR 98: squad up prints the seat started/);
  assert.match(steps[13], /^PR 98: Restart in the same pane/);
  for (const a of ['codex', 'agy', 'opencode']) assert.ok(LIVE_STEPS.some((s) => s.startsWith(`${a} `)), a);
  assert.ok(LIVE_STEPS.some((s) => /write_stdin/.test(s)) && LIVE_STEPS.some((s) => /subagent/.test(s)));
});
