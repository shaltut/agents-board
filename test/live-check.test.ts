// #4612: the live-check kit for Codex, agy and OpenCode seats. The scratch repo is synthetic and made in a temp folder,
// the squad file passes the board's own squad_set, and part A (the hook probes) runs against this checkout's guard
// without starting any agent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb } from './helpers.ts';
import { DEFAULT_MODELS, placeProblem, setup, squadFile } from '../kit/live-check/setup.mjs';
import { LIVE_STEPS, cases, installedFeatures, runProbes, stepsFromFile } from '../kit/live-check/check.mjs';

const BOARD = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(BOARD, 'kit', 'guard');
const root = mkdtempSync(join(tmpdir(), 'cb-live-check-'));
// a deny root no test folder is under (setup refuses to run with none set, PR 108 r2 R2)
const SAFE = { ...process.env, CB_SCRATCH_DENY: join(root, 'client-work'), CB_SCRATCH_ALLOW: '' };
after(() => rmSync(root, { recursive: true, force: true }));
const git = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

test('setup: a synthetic scratch repo with one commit, the decoy .env ignored, the squad file beside it (#4612)', () => {
  const dir = join(root, 'scratch');
  const r = setup({ dir, machine: 'box', board: BOARD, env: SAFE });
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
  assert.throws(() => setup({ dir: join(root, 'busy'), machine: 'box', board: BOARD, env: SAFE }), /not empty/);
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
  setup({ dir: seat, machine: 'box', board: BOARD, env: SAFE });
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

// PR 108 review K1: the scratch repo never lands in a client's folder: not inside any git repo (the nearest existing
// folder is asked), and not under a root named in CB_SCRATCH_DENY unless under one in CB_SCRATCH_ALLOW (the names stay
// out of the repo: the paste block on the card sets them)
test('K1: a scratch folder inside a git repo, or under a denied root and no allowed one, is refused (#4612)', () => {
  const host = join(root, 'host-repo');
  mkdirSync(join(host, 'sub'), { recursive: true });
  git(host, 'init', '-q');
  const env = { ...process.env, CB_SCRATCH_DENY: join(root, 'client-work'), CB_SCRATCH_ALLOW: '' };
  assert.match(placeProblem(join(host, 'scratch'), env) ?? '', /inside the git repo/);
  assert.match(placeProblem(join(host, 'sub', 'new', 'deeper'), env) ?? '', /inside the git repo/, 'a folder that does not exist yet: its nearest existing parent is asked');
  assert.throws(() => setup({ dir: join(host, 'scratch'), machine: 'box', board: BOARD, env }), /inside the git repo/);
  assert.ok(!existsSync(join(host, 'scratch')), 'nothing is made');
  const work = join(root, 'work'), sep = process.platform === 'win32' ? ';' : ':';
  mkdirSync(join(work, 'ours'), { recursive: true });
  const denied = { ...env, CB_SCRATCH_DENY: work, CB_SCRATCH_ALLOW: [join(work, 'ours'), join(root, 'elsewhere')].join(sep) };
  assert.match(placeProblem(join(work, 'client-a', 'scratch'), denied) ?? '', /CB_SCRATCH_DENY/);
  assert.match(placeProblem(work, denied) ?? '', /CB_SCRATCH_DENY/);
  assert.equal(placeProblem(join(work, 'ours', 'scratch'), denied), null, 'an allowed root under a denied one');
  assert.equal(placeProblem(join(root, 'free', 'scratch'), denied), null);
  assert.equal(placeProblem(join(root, 'workshop', 'scratch'), denied), null, 'a sibling whose name starts the same is not under it');
});

// PR 108 r2 R2: with no deny list set, setup cannot know where client work is, so it refuses (the card's paste block sets
// it); R3/R4: a git answer other than "not a git repository" (dubious ownership, inside .git, git missing) refuses too;
// R6: a deny root is compared through real paths, so a link to it (a junction on Windows) is under it
test('K1 r2: an unset CB_SCRATCH_DENY refuses; a git error refuses; a link into a denied root is under it (#4612)', () => {
  const plain = { ...process.env };
  delete plain.CB_SCRATCH_DENY;
  assert.match(placeProblem(join(root, 'free2', 'scratch'), plain) ?? '', /CB_SCRATCH_DENY is not set/);
  assert.match(placeProblem(join(root, 'free2', 'scratch'), { ...plain, CB_SCRATCH_DENY: ' ' }) ?? '', /CB_SCRATCH_DENY is not set/);
  assert.throws(() => setup({ dir: join(root, 'free2', 'scratch'), machine: 'box', board: BOARD, env: plain }), /CB_SCRATCH_DENY is not set/);
  const env = { ...process.env, CB_SCRATCH_DENY: join(root, 'client-work'), CB_SCRATCH_ALLOW: '' };
  const host = join(root, 'host-r3');
  mkdirSync(host);
  git(host, 'init', '-q');
  assert.match(placeProblem(join(host, '.git', 'scratch'), env) ?? '', /git/, 'inside .git is inside the repo');
  assert.match(placeProblem(join(root, 'free3'), env, process.platform, 'git-that-does-not-exist') ?? '', /could not ask git/);
  const work = join(root, 'work-r6');
  mkdirSync(work);
  const link = join(root, 'link-r6');
  symlinkSync(work, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(placeProblem(join(link, 'scratch'), { ...env, CB_SCRATCH_DENY: work }) ?? '', /CB_SCRATCH_DENY/);
  assert.match(placeProblem(join(work, 'scratch'), { ...env, CB_SCRATCH_DENY: link }) ?? '', /CB_SCRATCH_DENY/);
});

// PR 108 r2 R7: the parents setup made for a new folder go too when it fails
test('K5 r2: a failed setup removes the parent folders it made, and only those (#4612)', () => {
  const env = { ...process.env, CB_SCRATCH_DENY: join(root, 'client-work'), CB_SCRATCH_ALLOW: '' };
  const kept = join(root, 'r7');
  mkdirSync(kept);
  assert.throws(() => setup({ dir: join(kept, 'a', 'b', 'scratch'), machine: 'box', board: BOARD, env, gitBin: 'git-that-does-not-exist' }), /git/);
  assert.ok(existsSync(kept), 'a folder that was there stays');
  assert.deepEqual(readdirSync(kept), [], 'a and a/b, which setup made, are gone');
});

// K5: an existing squad file is never overwritten, and a setup that fails removes only what it made
test('K5: an existing squad file is refused; a failed setup leaves no half-made folder (#4612)', () => {
  const env = { ...process.env, CB_SCRATCH_DENY: join(root, 'client-work'), CB_SCRATCH_ALLOW: '' };
  const dir = join(root, 'k5');
  writeFileSync(`${dir}.squad.json`, '{"keep":true}\n');
  assert.throws(() => setup({ dir, machine: 'box', board: BOARD, env }), /squad\.json already exists/);
  assert.equal(readFileSync(`${dir}.squad.json`, 'utf8'), '{"keep":true}\n');
  assert.ok(!existsSync(dir));
  const fresh = join(root, 'k5-fail');
  assert.throws(() => setup({ dir: fresh, machine: 'box', board: BOARD, env, gitBin: 'git-that-does-not-exist' }), /git/);
  assert.ok(!existsSync(fresh) && !existsSync(`${fresh}.squad.json`), 'the folder it made is gone');
  const empty = join(root, 'k5-empty');
  mkdirSync(empty);
  assert.throws(() => setup({ dir: empty, machine: 'box', board: BOARD, env, gitBin: 'git-that-does-not-exist' }), /git/);
  assert.ok(existsSync(empty) && readdirSync(empty).length === 0, 'a folder that was there stays, emptied of what setup wrote');
});

// K3: which PRs the installed guard has is asked of the guard itself (a probe through shim-codex), never read from its text
test('K3: installedFeatures probes the installed Codex shim: own tools outside a seat (PR 96), interactive sessions (PR 104) (#4612)', () => {
  assert.deepEqual(installedFeatures(join(root, 'no-such-guard')), { 'PR 96': false, 'PR 104': false });
  const fake = join(root, 'fake-guard');
  mkdirSync(fake);
  // a stand-in that answers as both PRs would, and mentions neither marker the old text check looked for
  writeFileSync(join(fake, 'shim-codex.mjs'), `let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const i = JSON.parse(s), seat = !!(process.env.CB_ROLE || process.env.CB_AGENT);
  const deny = (r) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r } }));
  if (i.tool_name !== 'Bash') return seat ? deny('no') : process.stdout.write('{}');
  return i.tool_input.command === 'python' && seat ? deny('python opens a session that Codex write_stdin types into') : process.stdout.write('{}');
});\n`);
  assert.deepEqual(installedFeatures(fake), { 'PR 96': true, 'PR 104': true });
  // and one that answers as a guard from before both: every tool denied in or out of a seat, python allowed
  const old = join(root, 'old-guard');
  mkdirSync(old);
  writeFileSync(join(old, 'shim-codex.mjs'), `let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const i = JSON.parse(s);
  if (i.tool_name !== 'Bash') return process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'unrecognized tool' } }));
  return process.stdout.write('{}');
});\n`);
  assert.deepEqual(installedFeatures(old), { 'PR 96': false, 'PR 104': false });
  // PR 108 r2 R5: this checkout's own guard is asked too, but only for an answer: which PRs it has changes as they merge
  const mine = installedFeatures(GUARD);
  assert.deepEqual(Object.keys(mine), ['PR 96', 'PR 104']);
  for (const v of Object.values(mine)) assert.equal(typeof v, 'boolean');
});

// #4683 (PR 108 r3 R8): git variables exported in the operator's terminal point git at another repo; setup's own git
// calls run without them, so that repo is never touched and the scratch repo is made where asked
test('setup: an exported GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE never reaches setup\'s git calls (#4683)', () => {
  const other = join(root, 'other-repo');
  mkdirSync(other);
  assert.equal(git(other, 'init', '-q', '-b', 'main').status, 0);
  const before = readFileSync(join(other, '.git', 'config'), 'utf8');
  const env = { ...SAFE, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: join(other, '.git', 'objects'), GIT_COMMON_DIR: join(other, '.git'), GIT_NAMESPACE: 'x' };
  const dir = join(root, 'scratch-env');
  setup({ dir, machine: 'box', board: BOARD, env });
  assert.equal(readFileSync(join(other, '.git', 'config'), 'utf8'), before, 'the other repo\'s config is untouched');
  assert.notEqual(git(other, 'rev-parse', '--verify', '-q', 'HEAD').status, 0, 'no commit landed in the other repo');
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD').stdout.trim(), '1', 'the scratch repo got its commit');
});

// #4694 (PR 115 review I1): an exported GIT_CONFIG is git config's default --file, so setup's user.* writes went to that
// file and the scratch commit was authored with the machine's own identity
test('setup: an exported GIT_CONFIG never takes setup\'s scratch identity (#4694)', () => {
  const other = join(root, 'other-config');
  mkdirSync(other);
  assert.equal(git(other, 'init', '-q', '-b', 'main').status, 0);
  const before = readFileSync(join(other, '.git', 'config'), 'utf8');
  const dir = join(root, 'scratch-config');
  setup({ dir, machine: 'box', board: BOARD, env: { ...SAFE, GIT_CONFIG: join(other, '.git', 'config') } });
  assert.equal(readFileSync(join(other, '.git', 'config'), 'utf8'), before, 'the other config file is untouched');
  assert.equal(git(dir, 'config', '--local', 'user.email').stdout.trim(), 'live-check@example.invalid');
  assert.equal(git(dir, 'log', '-1', '--format=%an <%ae>').stdout.trim(), 'Live Check <live-check@example.invalid>');
});

// #4705 (PR 118/119 review): the operator's identity and config overrides in the environment never reach the scratch
// commit the third-party seats read: GIT_AUTHOR_*, GIT_COMMITTER_*, GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS
test('setup: the operator\'s GIT_AUTHOR_*, GIT_COMMITTER_* and git config env never reach the scratch commit (#4705)', () => {
  const env = { ...SAFE, GIT_AUTHOR_NAME: 'Operator Person', GIT_AUTHOR_EMAIL: 'op@private.example', GIT_COMMITTER_NAME: 'Operator Person',
    GIT_COMMITTER_EMAIL: 'op@private.example', GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Operator Person', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'op@private.example',
    GIT_CONFIG_PARAMETERS: "'user.name'='Operator Person'" };
  const dir = join(root, 'scratch-identity');
  setup({ dir, machine: 'box', board: BOARD, env });
  const who = git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%ad').stdout.trim();
  assert.match(who, /^Live Check <live-check@example\.invalid>\|Live Check <live-check@example\.invalid>\|/);
  assert.doesNotMatch(who, /Operator|private|2001/);
});
