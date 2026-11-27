import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, resolve } from 'node:path';
import { loadConfig, checkParams, expand, freeLane, jobCwd, jobEnv, published } from '../cli/recipes.ts';

const example = () => loadConfig(readFileSync('docs/ops/runner.example.json', 'utf8'));

// a minimal config with one recipe, for the loader-refusal tests
const cfgWith = (recipe: object, extra: object = {}) =>
  JSON.stringify({
    slots: 2, log: { host: '100.64.0.1', port: 7000, peers: [] },
    projects: { p: { git: 'g', base: 'C:/r', lockfile: 'l', install: ['x'], installTimeout: 10, recipes: { r: { timeout: 10, ...recipe } } } },
    ...extra,
  });

test('the iHop example loads and publishes names only', () => {
  const cfg = example();
  const all = published(cfg);
  const pub = all.filter((p) => p.project === 'ihop');
  assert.deepEqual(pub.map((p) => p.recipe).sort(), ['build', 'check', 'guards', 'install', 'itest', 'kbtest', 'lint', 'test', 'vitest']);
  assert.ok(pub.every((p) => p.repo === 'main'));
  assert.deepEqual(pub.find((p) => p.recipe === 'check'), { project: 'ihop', repo: 'main', recipe: 'check', params: { ws: { min: 1, max: 6 } }, db: false });
  // the second project is in the repos shape (#3703)
  assert.deepEqual(all.filter((p) => p.project === 'qhs').map((p) => `${p.repo}/${p.recipe}`), ['api/test', 'dashboard/build']);
  assert.equal(pub.find((p) => p.recipe === 'itest')!.db, true);
  const s = JSON.stringify(all);
  for (const bad of ['pnpm', 'node', 'pattern', 'TEST_STACK']) assert.ok(!s.includes(bad), bad);
});

// #4014 (Q2790, every pull request): guards runs the repo's script tests as its pre-push hook does
test('the example guards recipe runs the hook script tests on every job', () => {
  const guards = example().projects.ihop!.repos.main!.recipes.guards!;
  assert.deepEqual(guards.steps.at(-1), ['pnpm', 'exec', 'lefthook', 'run', 'pre-push', '--commands', 'program-script-tests', '--no-tty']);
});

test('loadConfig names the bad field', () => {
  assert.throws(() => loadConfig(cfgWith({ steps: [['a', '{nope}']] })), /steps\[0\].*nope/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a', '{x}{y}']], params: { x: { pattern: '.' }, y: { pattern: '.' } } })), /one slot/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], params: { x: { pattern: '(' } } })), /pattern/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']] }, { slots: 11 })), /slots/);
  assert.equal(loadConfig(cfgWith({ steps: [['a']] }, { slots: 10 })).slots, 10); // the PC runs up to 10 jobs at once
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], cwd: '{x}', params: { x: { pattern: '.', max: 2 } } })), /cwd/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], params: { X: { pattern: '.' } } })), /params/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], params: { x: { pattern: '.', max: 21 } } })), /max/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], timeout: 9999 })), /timeout/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], finally: [['b', '{zz}']] })), /finally\[0\].*zz/);
});

test('loadConfig refuses a misspelled key, an empty install and an optional cwd parameter', () => {
  const base = JSON.parse(cfgWith({ steps: [['a']] }));
  const withRecipe = (r: object) => { const c = structuredClone(base); Object.assign(c.projects.p.recipes.r, r); return JSON.stringify(c); };
  assert.throws(() => loadConfig(withRecipe({ finaly: [['b']] })), { message: 'projects.p.recipes.r: unknown key "finaly"' });
  assert.throws(() => loadConfig(withRecipe({ dbb: true })), /projects\.p\.recipes\.r: unknown key "dbb"/);
  assert.throws(() => loadConfig(withRecipe({ params: { x: { pattern: '.', mx: 2 } } })), /projects\.p\.recipes\.r\.params\.x: unknown key "mx"/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, slot: 2 })), /runner\.json: unknown key "slot"/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, log: { ...base.log, peer: [] } })), /log: unknown key "peer"/);
  const proj = (p: object) => { const c = structuredClone(base); Object.assign(c.projects.p, p); return JSON.stringify(c); };
  assert.throws(() => loadConfig(proj({ lockFile: 'x' })), /projects\.p: unknown key "lockFile"/);
  assert.throws(() => loadConfig(proj({ install: [] })), /projects\.p\.install: must be a non-empty list/);
  assert.throws(() => loadConfig(withRecipe({ cwd: '{x}', params: { x: { pattern: '.', min: 0 } } })), /cwd.*min 1/);
  assert.ok(loadConfig(withRecipe({ cwd: '{x}', params: { x: { pattern: '.' } } })));
  assert.ok(example());
});

test('checkParams refuses flag- and path-shaped values and the pattern', () => {
  const test_ = example().projects.ihop!.repos.main!.recipes.test!;
  const bad = (files: string[]) => checkParams(test_, { app: ['claims-api'], files });
  for (const v of ['-r', '../x', 'tests/../x.test.ts', 'C:/x', '/etc', 'a b', 'tests/a.ts', 'tests/a.integration.test.ts'])
    assert.match(bad([v])!, /^error: bad parameter files:/, v);
  assert.equal(bad(Array.from({ length: 21 }, () => 'tests/a.test.ts')), 'error: bad parameter files: at most 20');
  assert.equal(checkParams(test_, { app: ['claims-api'], files: ['tests/a.test.ts'] }), null);
  assert.equal(checkParams(test_, { app: ['claims-api'], files: ['tests/a.test.ts'], extra: ['x'] }), 'error: bad parameter extra: unknown');
  assert.equal(checkParams(test_, { app: ['claims-api'] }), 'error: bad parameter files: needs at least 1');
});

test('expand repeats an element per value and drops empty params', () => {
  assert.deepEqual(expand(['pnpm', '--filter={ws}', 'check'], { ws: ['@ihop/a', '@ihop/b'] }), ['pnpm', '--filter=@ihop/a', '--filter=@ihop/b', 'check']);
  assert.deepEqual(expand(['node', '{files}'], { files: [] }), ['node']);
});

test('jobCwd stays inside the slot', () => {
  const r = example().projects.ihop!.repos.main!.recipes.test!;
  const slot = resolve('C:/r/ihop-1');
  assert.equal(jobCwd(slot, r, { app: ['claims-api'] }), resolve(slot, 'apps/claims-api'));
  assert.throws(() => jobCwd(slot, { ...r, cwd: '../x' }, {}), /outside/);
  // an absolute path on this machine (C:/elsewhere is one only on Windows: #4401)
  assert.throws(() => jobCwd(slot, { ...r, cwd: parse(slot).root + 'elsewhere' }, {}), /outside/);
  assert.equal(jobCwd(slot, { ...r, cwd: '.' }, {}), slot);
});

test('jobEnv starts empty', () => {
  const cfg = example();
  const recipe = { ...cfg.projects.ihop!.repos.main!.recipes.guards!, env: { A: '1' } };
  const from = { PATH: 'p', CB_DATABASE_URL: 'x', DATABASE_URL: 'y', SECRET: 's', TEMP: 't' };
  // NoDefaultCurrentDirectoryInExePath: Windows must not run a program from the cwd (a committed git.exe) before PATH
  assert.deepEqual(jobEnv(from, cfg, recipe), { PATH: 'p', TEMP: 't', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', NoDefaultCurrentDirectoryInExePath: '1', A: '1' });
  assert.equal(jobEnv({ ...from, SECRET: 's' }, { ...cfg, passEnv: ['SECRET', 'ABSENT'] }, recipe).SECRET, 's');
});

test('prototype names are not parameters', () => {
  assert.throws(() => loadConfig(cfgWith({ steps: [['a', '{constructor}']] })), /steps\[0\].*constructor/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a', '{__proto__}']] })), /__proto__/);
  const r = example().projects.ihop!.repos.main!.recipes.check!;
  assert.equal(checkParams(r, { ws: ['@ihop/a'], constructor: ['x'] }), 'error: bad parameter constructor: unknown');
  assert.equal(checkParams(r, JSON.parse('{"ws":["@ihop/a"],"__proto__":["-rf"]}')), 'error: bad parameter __proto__: unknown');
  assert.deepEqual(expand(['a', '{toString}'], {}), ['a']);
  assert.deepEqual(expand(['a', '{ws}'], JSON.parse('{"__proto__":["x"]}')), ['a']);
});

// DB lanes: dbLanes DB jobs at once, each with its own test stack (the lane fills {lane} in its recipe's env)
const laneEnv = ['TEST_STACK_PROJECT', 'TEST_STACK_PG_PORT'];
const dbEnv = { TEST_STACK_PROJECT: 'cb-runner-it-{lane}', TEST_STACK_PG_PORT: '5544{lane}', DB_SSL_DISABLE: 'true' };
const lanes = (dbLanes: number, extra: object = {}) => ({ dbLanes, laneEnv, ...extra });
test('the example keeps every lane port, lanes 1-9, below 32768: out of the range the Docker VM hands to outgoing connections (#4417)', () => {
  const cfg = example();
  const recipes = Object.values(cfg.projects.ihop!.repos.main!.recipes).filter((r) => r.db);
  assert.equal(recipes.length, 2);
  for (const r of recipes) for (let lane = 1; lane <= 9; lane++) {
    const env = jobEnv({}, cfg, r, lane);
    const ports = cfg.laneEnv.filter((n) => /PORT/.test(n)).map((n) => Number(env[n]));
    assert.equal(ports.length, 3);
    for (const p of ports) assert.ok(Number.isInteger(p) && p >= 1024 && p < 32768, `lane ${lane}: port ${p}`);
  }
});
test('dbLanes: 1 by default, 1-9, never above slots', () => {
  assert.equal(loadConfig(cfgWith({ steps: [['a']] })).dbLanes, 1);
  assert.equal(example().dbLanes, 2);
  assert.equal(loadConfig(cfgWith({ steps: [['a']], db: true, env: dbEnv }, lanes(9, { slots: 10 }))).dbLanes, 9);
  for (const dbLanes of [0, 10, 1.5, '2']) assert.throws(() => loadConfig(cfgWith({ steps: [['a']] }, { slots: 10, dbLanes, laneEnv })), /dbLanes/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']] }, lanes(3, { slots: 2 }))), /dbLanes: is above slots/);
});
test('dbLanes above 1 needs laneEnv, and each DB recipe holds {lane} in every laneEnv value', () => {
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], db: true, env: dbEnv }, { dbLanes: 2 })), /^Error: laneEnv: must name/);
  // review I2: the ports set apart but the stack name shared: lane 2's up would take down lane 1's stack
  const nameShared = { ...dbEnv, TEST_STACK_PROJECT: 'cb-runner-it' };
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], db: true, env: nameShared }, lanes(2))), /recipes\.r\.env\.TEST_STACK_PROJECT: needs \{lane\}/);
  const { TEST_STACK_PG_PORT: _gone, ...noPort } = dbEnv;
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], db: true, env: noPort }, lanes(2))), /recipes\.r\.env\.TEST_STACK_PG_PORT: needs \{lane\}/);
  const shared = { TEST_STACK_PROJECT: 'cb-runner-it', TEST_STACK_PG_PORT: '55432' };
  assert.equal(loadConfig(cfgWith({ steps: [['a']], db: true, env: shared }, { dbLanes: 1 })).dbLanes, 1); // one at a time, as before
  assert.ok(loadConfig(cfgWith({ steps: [['a']], db: true, env: dbEnv }, lanes(2))));
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], env: { PORT: '300{lane}' } })), /recipes\.r\.env: \{lane\} is for DB recipes only/);
});
test('dbLanes above 1: every DB recipe writes each laneEnv value the same way (lane n is one stack)', () => {
  const two = (env2: object) => {
    const raw = JSON.parse(cfgWith({ steps: [['a']], db: true, env: dbEnv }, lanes(2)));
    raw.projects.p.recipes.r2 = { steps: [['b']], timeout: 10, db: true, env: env2 };
    return JSON.stringify(raw);
  };
  assert.ok(loadConfig(two(dbEnv)));
  assert.throws(() => loadConfig(two({ ...dbEnv, TEST_STACK_PG_PORT: '5545{lane}' })),
    /projects\.p\.recipes\.r2\.env\.TEST_STACK_PG_PORT: is "5545\{lane\}" but projects\.p\.recipes\.r has "5544\{lane\}"/);
  assert.ok(loadConfig(two({ ...dbEnv, DB_SSL_DISABLE: 'false' }))); // a value outside laneEnv may differ
});
test("jobEnv fills every {lane} with the job's lane; no lane leaves the env as written", () => {
  const cfg = loadConfig(cfgWith({ steps: [['a']], db: true, env: { ...dbEnv, BOTH: '{lane}-{lane}' } }, lanes(2)));
  const recipe = cfg.projects.p!.repos.main!.recipes.r!;
  const env = jobEnv({}, cfg, recipe, 2);
  assert.deepEqual([env.TEST_STACK_PROJECT, env.TEST_STACK_PG_PORT, env.BOTH, env.DB_SSL_DISABLE], ['cb-runner-it-2', '55442', '2-2', 'true']);
  assert.equal(jobEnv({}, cfg, recipe).TEST_STACK_PROJECT, 'cb-runner-it-{lane}');
  assert.equal(recipe.env.TEST_STACK_PROJECT, 'cb-runner-it-{lane}'); // the recipe itself is untouched
});
test('freeLane: the lowest lane no running job holds, none when all are taken', () => {
  assert.equal(freeLane([], 4), 1);
  assert.equal(freeLane([1, 2, 4], 4), 3);
  assert.equal(freeLane([2, 1, 3, 4], 4), undefined);
  assert.equal(freeLane([], 1), 1);
  assert.equal(freeLane([1], 1), undefined);
});
