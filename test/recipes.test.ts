import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, resolve } from 'node:path';
import { loadConfig, checkParams, expand, freeLane, jobCwd, jobEnv, missingPaths, published, relPaths, withBoard } from '../cli/recipes.ts';
import { boardHello } from '../cli/runner-board.ts';

const example = () => loadConfig(readFileSync('docs/ops/runner.example.json', 'utf8'));

// a minimal config with one recipe, for the loader-refusal tests
const cfgWith = (recipe: object, extra: object = {}) =>
  JSON.stringify({
    slots: 2, log: { host: '100.64.0.1', port: 7000, peers: [] },
    projects: { p: { git: 'g', base: 'C:/runs', lockfile: 'l', install: ['x'], installTimeout: 10, recipes: { r: { timeout: 10, ...recipe } } } },
    ...extra,
  });

test('the Iris example loads and publishes names only', () => {
  const cfg = example();
  const all = published(cfg);
  const pub = all.filter((p) => p.project === 'iris');
  assert.deepEqual(pub.map((p) => p.recipe).sort(), ['build', 'check', 'guards', 'install', 'itest', 'kbtest', 'lint', 'test', 'vitest']);
  assert.ok(pub.every((p) => p.repo === 'main'));
  assert.deepEqual(pub.find((p) => p.recipe === 'check'), { project: 'iris', repo: 'main', recipe: 'check', params: { ws: { min: 1, max: 6 } }, db: false });
  // the second project is in the repos shape (#3703)
  assert.deepEqual(all.filter((p) => p.project === 'zed').map((p) => `${p.repo}/${p.recipe}`), ['api/test', 'dashboard/build']);
  assert.equal(pub.find((p) => p.recipe === 'itest')!.db, true);
  const s = JSON.stringify(all);
  for (const bad of ['pnpm', 'node', 'pattern', 'TEST_STACK']) assert.ok(!s.includes(bad), bad);
});

// #4014 (Q2790, every pull request): guards runs the repo's script tests as its pre-push hook does
test('the example guards recipe runs the hook script tests on every job', () => {
  const guards = example().projects.iris!.repos.main!.recipes.guards!;
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
  const test_ = example().projects.iris!.repos.main!.recipes.test!;
  const bad = (files: string[]) => checkParams(test_, { app: ['claims-api'], files });
  for (const v of ['-r', '../x', 'tests/../x.test.ts', 'C:/x', '/etc', 'a b', 'tests/a.ts', 'tests/a.integration.test.ts'])
    assert.match(bad([v])!, /^error: bad parameter files:/, v);
  assert.equal(bad(Array.from({ length: 21 }, () => 'tests/a.test.ts')), 'error: bad parameter files: at most 20');
  assert.equal(checkParams(test_, { app: ['claims-api'], files: ['tests/a.test.ts'] }), null);
  assert.equal(checkParams(test_, { app: ['claims-api'], files: ['tests/a.test.ts'], extra: ['x'] }), 'error: bad parameter extra: unknown');
  assert.equal(checkParams(test_, { app: ['claims-api'] }), 'error: bad parameter files: needs at least 1');
});

// #4338: a file named in --files that is not there at the sha was dropped by the test tool and the job still passed,
// so a green job did not prove the named tests ran. A path parameter (files, unless the recipe says paths: false) is
// checked against the job's folder; a repo-relative path is taken too, as the folder-relative one.
test('relPaths takes a repo-relative path as relative to the job folder; other params are untouched', () => {
  const test_ = example().projects.iris!.repos.main!.recipes.test!; // cwd apps/{app}
  assert.equal(test_.params.files!.paths, true);
  assert.equal(test_.params.app!.paths, false);
  const out = relPaths(test_, { app: ['claims-api'], files: ['apps/claims-api/tests/a.test.ts', 'tests/b.test.ts', 'apps/other/tests/c.test.ts'] });
  assert.deepEqual(out, { app: ['claims-api'], files: ['tests/a.test.ts', 'tests/b.test.ts', 'apps/other/tests/c.test.ts'] });
  assert.equal(checkParams(test_, out), 'error: bad parameter files: apps/other/tests/c.test.ts', 'another app stays wrong');
  // no cwd parameter yet (a bad row): nothing is rewritten, checkParams names it
  assert.deepEqual(relPaths(test_, { files: ['apps/claims-api/tests/a.test.ts'] }), { files: ['apps/claims-api/tests/a.test.ts'] });
});

test('missingPaths: a name counts from the job folder or from a package folder under it, never as a bare tail; a path parameter can be turned off', () => {
  const r = { ...example().projects.iris!.repos.main!.recipes.test! };
  const tracked = ['tests/a.test.ts', 'tests/b.test.tsx', 'apps/web/package.json', 'apps/web/client/src/bell.test.ts', 'e2e/tests/x.test.ts', 'package.json'];
  const miss = (files: string[]) => missingPaths(tracked, r, { app: ['x'], files });
  // from the folder (a file or a folder), and from a package folder: vitest under pnpm --filter takes package-relative names
  assert.deepEqual(miss(['tests/a.test.ts', 'tests', 'tests/', './tests/a.test.ts', 'client/src/bell.test.ts', 'apps/web/client/src/bell.test.ts']), []);
  // review 2 (I1): a tail of a deeper path is not the file; node --test would drop it and pass on the rest
  assert.deepEqual(miss(['tests/x.test.ts', 'src/bell.test.ts', 'bell.test.ts', 'tests/made-up.test.ts']), ['tests/x.test.ts', 'src/bell.test.ts', 'bell.test.ts', 'tests/made-up.test.ts']);
  // whole names only: no partial name, and b.test.ts is not b.test.tsx
  assert.deepEqual(miss(['ests/a.test.ts', 'tests/b.test.ts', 'a.test']), ['ests/a.test.ts', 'tests/b.test.ts', 'a.test']);
  // review M1: node_modules is never tracked, and a wrong-case name is not the file
  assert.deepEqual(miss(['node_modules/x/index.js', 'tests/A.test.ts']), ['node_modules/x/index.js', 'tests/A.test.ts']);
  const off = { ...r, params: { ...r.params, files: { ...r.params.files!, paths: false } } };
  assert.deepEqual(missingPaths(tracked, off, { app: ['x'], files: ['tests/made-up.test.ts'] }), []);
  const withParam = (p: object) => loadConfig(cfgWith({ steps: [['a', '{files}', '{spec}']], params: { files: { pattern: '.', ...p }, spec: { pattern: '.', paths: true } } }));
  const params = withParam({ paths: false }).projects.p!.repos.main!.recipes.r!.params;
  assert.equal(params.files!.paths, false);
  assert.equal(params.spec!.paths, true);
  assert.throws(() => withParam({ paths: 'yes' }), /paths/);
});

test('expand repeats an element per value and drops empty params', () => {
  assert.deepEqual(expand(['pnpm', '--filter={ws}', 'check'], { ws: ['@iris/a', '@iris/b'] }), ['pnpm', '--filter=@iris/a', '--filter=@iris/b', 'check']);
  assert.deepEqual(expand(['node', '{files}'], { files: [] }), ['node']);
});

// #3773: {{ and }} escape literal braces in steps, finally and cwd; unescaped or unmatched braces are still refused
test('escaped braces ({{ and }}) pass through as literal braces in steps, finally and cwd', () => {
  const cfg = loadConfig(cfgWith({
    params: { ws: { pattern: '.' }, files: { pattern: '.', max: 4 } },
    cwd: 'apps/{{lit}}/{ws}',
    steps: [
      ['node', '-e', "fs.rmSync('dist', {{force:true}})"],
      ['node', '-e', 'const f = () => {{ return {{a: 1}}; }}; console.log({{}});'],
      ['tool', '--json={{"ws":"{{ws}}","file":"{files}"}}'],
      ['tool', '{{{ws}}}'],
    ],
    finally: [['node', '-e', "fs.rmSync('tmp', {{recursive:true, force:true}})"]],
  }));
  const r = cfg.projects.p!.repos.main!.recipes.r!;
  assert.deepEqual(expand(r.steps[0]!, {}), ['node', '-e', "fs.rmSync('dist', {force:true})"]);
  assert.deepEqual(expand(r.steps[1]!, {}), ['node', '-e', 'const f = () => { return {a: 1}; }; console.log({});']);
  assert.deepEqual(expand(r.steps[2]!, { files: ['a.ts', 'b.ts'] }), ['tool', '--json={"ws":"{ws}","file":"a.ts"}', '--json={"ws":"{ws}","file":"b.ts"}']);
  assert.deepEqual(expand(r.steps[3]!, { ws: ['@iris/a'] }), ['tool', '{@iris/a}']);
  assert.deepEqual(expand(r.finally[0]!, {}), ['node', '-e', "fs.rmSync('tmp', {recursive:true, force:true})"]);
  const slot = resolve('C:/runs/p-1');
  assert.equal(jobCwd(slot, r, { ws: ['web'] }), resolve(slot, 'apps/{lit}/web'));
  assert.deepEqual(relPaths(r, { ws: ['web'], files: ['apps/{lit}/web/a.ts'] }), { ws: ['web'], files: ['a.ts'] });
  // unescaped and unmatched braces stay refused, with a hint to double them
  assert.throws(() => loadConfig(cfgWith({ steps: [['node', '-e', "fs.rmSync('dist', {force:true})"]] })), /unknown parameter \{force:true\}.*\{\{.*\}\}/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['node', '-e', 'console.log({})']] })), /unknown parameter \{\}.*\{\{.*\}\}/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['node', '-e', 'fs.rmSync("dist", {{force:true})']] })), /unmatched "\}".*\{\{.*\}\}/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['pnpm', '--filter={ws']], params: { ws: { pattern: '.' } } })), /unmatched "\{".*\{\{.*\}\}/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a']], cwd: 'apps/{app' })), /cwd.*unmatched "\{"/);
});

test('jobCwd stays inside the slot', () => {
  const r = example().projects.iris!.repos.main!.recipes.test!;
  const slot = resolve('C:/runs/iris-1');
  assert.equal(jobCwd(slot, r, { app: ['claims-api'] }), resolve(slot, 'apps/claims-api'));
  assert.throws(() => jobCwd(slot, { ...r, cwd: '../x' }, {}), /outside/);
  // an absolute path on this machine (C:/elsewhere is one only on Windows: #4401)
  assert.throws(() => jobCwd(slot, { ...r, cwd: parse(slot).root + 'elsewhere' }, {}), /outside/);
  assert.equal(jobCwd(slot, { ...r, cwd: '.' }, {}), slot);
});

test('jobEnv starts empty', () => {
  const cfg = example();
  const recipe = { ...cfg.projects.iris!.repos.main!.recipes.guards!, env: { A: '1' } };
  const from = { PATH: 'p', CB_DATABASE_URL: 'x', DATABASE_URL: 'y', SECRET: 's', TEMP: 't' };
  // NoDefaultCurrentDirectoryInExePath: Windows must not run a program from the cwd (a committed git.exe) before PATH
  assert.deepEqual(jobEnv(from, cfg, recipe), { PATH: 'p', TEMP: 't', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', CB_RUNNER_JOB: '1', NoDefaultCurrentDirectoryInExePath: '1', A: '1' });
  assert.equal(jobEnv({ ...from, SECRET: 's' }, { ...cfg, passEnv: ['SECRET', 'ABSENT'] }, recipe).SECRET, 's');
});

test('prototype names are not parameters', () => {
  assert.throws(() => loadConfig(cfgWith({ steps: [['a', '{constructor}']] })), /steps\[0\].*constructor/);
  assert.throws(() => loadConfig(cfgWith({ steps: [['a', '{__proto__}']] })), /__proto__/);
  const r = example().projects.iris!.repos.main!.recipes.check!;
  assert.equal(checkParams(r, { ws: ['@iris/a'], constructor: ['x'] }), 'error: bad parameter constructor: unknown');
  assert.equal(checkParams(r, JSON.parse('{"ws":["@iris/a"],"__proto__":["-rf"]}')), 'error: bad parameter __proto__: unknown');
  assert.deepEqual(expand(['a', '{toString}'], {}), ['a']);
  assert.deepEqual(expand(['a', '{ws}'], JSON.parse('{"__proto__":["x"]}')), ['a']);
});

// DB lanes: dbLanes DB jobs at once, each with its own test stack (the lane fills {lane} in its recipe's env)
const laneEnv = ['TEST_STACK_PROJECT', 'TEST_STACK_PG_PORT'];
const dbEnv = { TEST_STACK_PROJECT: 'cb-runner-it-{lane}', TEST_STACK_PG_PORT: '5544{lane}', DB_SSL_DISABLE: 'true' };
const lanes = (dbLanes: number, extra: object = {}) => ({ dbLanes, laneEnv, ...extra });
test('the example keeps every lane port, lanes 1-9, below 32768: out of the range the Docker VM hands to outgoing connections (#4417)', () => {
  const cfg = example();
  const recipes = Object.values(cfg.projects.iris!.repos.main!.recipes).filter((r) => r.db);
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
test('the board\'s slot setting (#4527): over runner.json, past the old cap of 10; lanes 1-9; a setting the file cannot take keeps the file\'s', () => {
  const text = cfgWith({ steps: [['a']], db: true, env: dbEnv }, lanes(2, { slots: 4 }));
  const file = loadConfig(text), said: string[] = [], say = (m: string) => said.push(m);
  assert.equal(withBoard(text, file, {}, say), file, 'no setting: runner.json as it is');
  assert.deepEqual([withBoard(text, file, { slots: 24 }, say).slots, withBoard(text, file, { slots: 24 }, say).dbLanes], [24, 2]);
  assert.deepEqual([withBoard(text, file, { slots: 1 }, say).slots, withBoard(text, file, { slots: 1 }, say).dbLanes], [1, 1], 'lanes cut to the slots');
  assert.equal(withBoard(text, file, { slots: 12, dbLanes: 6 }, say).dbLanes, 6);
  assert.deepEqual(said, []);
  assert.equal(withBoard(text, file, { slots: 64 }, say).slots, 64);
  assert.equal(withBoard(text, file, { slots: 65 }, say), file, 'review M1: the board\'s columns cap at 64, and so does the runner');
  assert.match(said.pop()!, /the board's slots: must be an integer 1-64/);
  assert.equal(withBoard(text, file, { slots: 4, dbLanes: 10 }, say), file);
  assert.match(said.pop()!, /DB lanes: must be an integer 1-9.*running 4 slots and 2 DB lane\(s\) from runner\.json/);
  // more lanes on a file written for one shared stack: two DB jobs would share it, so the file's count is kept
  const shared = cfgWith({ steps: [['a']], db: true, env: { TEST_STACK_PROJECT: 'it', TEST_STACK_PG_PORT: '55432' } }, { slots: 4 });
  assert.equal(withBoard(shared, loadConfig(shared), { dbLanes: 2 }, say).dbLanes, 1);
  assert.match(said.pop()!, /laneEnv: must name/);
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

// review M2/M3 (#4527): the runner's start against the board, with a stand-in for the database (no board needed)
test('boardHello: a board older than the runner keeps runner.json and the 3-argument hello; a refused setting goes back to the board', async () => {
  const text = cfgWith({ steps: [['a']], db: true, env: dbEnv }, lanes(2, { slots: 4 }));
  const file = loadConfig(text);
  // a stand-in for the board: records each call, answers cb.runner_hello with 3 ended jobs and cb.runner_settings with row
  const fake = (row: object | undefined, fail: { read?: string; hello6?: string } = {}) => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const board = async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'runner_settings' && fail.read) throw Object.assign(new Error('x'), { code: fail.read });
      if (fn === 'runner_hello' && Object.keys(args).length === 6 && fail.hello6) throw Object.assign(new Error('x'), { code: fail.hello6 });
      return fn === 'runner_hello' ? 3 : row ?? null;
    };
    return { board, calls };
  };
  const said: string[] = [], say = (m: string) => said.push(m);
  // the board's setting fits: run it, report it, no refusal
  let f = fake({ slots_set: 12, lanes_set: null });
  let r = await boardHello(f.board, 'pc', 'http://h:1', text, file, say);
  assert.deepEqual([r.cfg.slots, r.cfg.dbLanes, r.ended, r.fromBoard], [12, 2, 3, true]);
  const sent = f.calls[1]!.args;
  assert.deepEqual([sent.slots, sent.db_lanes, sent.setting_refused], [12, 2, null]);
  // a setting runner.json cannot take (9 lanes on a file with one shared stack): runner.json's counts, and the reason
  // in the hello for the page
  const shared = cfgWith({ steps: [['a']], db: true, env: { TEST_STACK_PROJECT: 'it', TEST_STACK_PG_PORT: '55432' } }, { slots: 4 });
  f = fake({ slots_set: null, lanes_set: 2 });
  r = await boardHello(f.board, 'pc', 'http://h:1', shared, loadConfig(shared), say);
  assert.deepEqual([r.cfg.dbLanes, r.fromBoard], [1, false]);
  assert.match(String(f.calls[1]!.args.setting_refused), /does not fit runner\.json/);
  // a board without the setting's read (undefined function): one line, runner.json, the old hello with 3 arguments
  said.length = 0;
  f = fake(undefined, { read: '42883' });
  r = await boardHello(f.board, 'pc', 'http://h:1', text, file, say);
  assert.deepEqual([r.cfg, r.ended, r.fromBoard, Object.keys(f.calls[1]!.args).length], [file, 3, false, 3]);
  assert.equal(said.length, 1);
  assert.match(said[0]!, /board is older than this runner.*4 slots and 2 DB lane/);
  // the read there but the hello still the old one (undefined function): the same
  f = fake({ slots_set: 12, lanes_set: null }, { hello6: '42883' });
  r = await boardHello(f.board, 'pc', 'http://h:1', text, file, say);
  assert.deepEqual([r.cfg.slots, f.calls.length, Object.keys(f.calls[2]!.args).length], [4, 3, 3]);
  // anything else still stops the start
  f = fake(undefined, { read: '28P01' });
  await assert.rejects(boardHello(f.board, 'pc', 'http://h:1', text, file, say));
});
