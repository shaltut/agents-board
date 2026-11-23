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
  const pub = published(cfg);
  assert.deepEqual(pub.map((p) => p.recipe).sort(), ['build', 'check', 'guards', 'install', 'itest', 'kbtest', 'lint', 'test', 'vitest']);
  assert.ok(pub.every((p) => p.project === 'ihop'));
  assert.deepEqual(pub.find((p) => p.recipe === 'check'), { project: 'ihop', recipe: 'check', params: { ws: { min: 1, max: 6 } }, db: false });
  assert.equal(pub.find((p) => p.recipe === 'itest')!.db, true);
  const s = JSON.stringify(pub);
  for (const bad of ['pnpm', 'node', 'pattern', 'TEST_STACK']) assert.ok(!s.includes(bad), bad);
});

test('loadConfig names the bad field', () => {
  assert.throws(() => loadConfig(cfgWith({ steps: [['a', '{nope}']] })), /steps\[0\].*nope/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a', '{x}{y}']], params: { x: { pattern: '.' }, y: { pattern: '.' } } })), /one slot/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], params: { x: { pattern: '(' } } })), /pattern/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']] }, { slots: 9 })), /slots/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], cwd: '{x}', params: { x: { pattern: '.', max: 2 } } })), /cwd/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], params: { X: { pattern: '.' } } })), /params/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], params: { x: { pattern: '.', max: 21 } } })), /max/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], timeout: 9999 })), /timeout/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], finally: [['b', '{zz}']] })), /finally\[0\].*zz/);
});

test('checkParams refuses flag- and path-shaped values and the pattern', () => {
  const test_ = example().projects.ihop!.recipes.test!;
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
  const r = example().projects.ihop!.recipes.test!;
  const slot = resolve('C:/r/ihop-1');
  assert.equal(jobCwd(slot, r, { app: ['claims-api'] }), resolve(slot, 'apps/claims-api'));
  assert.throws(() => jobCwd(slot, { ...r, cwd: '../x' }, {}), /outside/);
  assert.throws(() => jobCwd(slot, { ...r, cwd: 'C:/elsewhere' }, {}), /outside/);
  assert.equal(jobCwd(slot, { ...r, cwd: '.' }, {}), slot);
});

test('jobEnv starts empty', () => {
  const cfg = example();
  const recipe = { ...cfg.projects.ihop!.recipes.guards!, env: { A: '1' } };
  const from = { PATH: 'p', CB_DATABASE_URL: 'x', DATABASE_URL: 'y', SECRET: 's', TEMP: 't' };
  assert.deepEqual(jobEnv(from, cfg, recipe), { PATH: 'p', TEMP: 't', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', A: '1' });
  assert.equal(jobEnv({ ...from, SECRET: 's' }, { ...cfg, passEnv: ['SECRET', 'ABSENT'] }, recipe).SECRET, 's');
});
