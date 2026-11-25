import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, checkParams, expand, jobCwd, jobEnv, published } from '../cli/recipes.ts';

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
  assert.throws(() => jobCwd(slot, { ...r, cwd: 'C:/elsewhere' }, {}), /outside/);
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
