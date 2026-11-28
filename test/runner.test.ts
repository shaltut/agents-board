// The PC job runner daemon end to end: a real runner child against the test DB and a local bare git repo.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { runJob, servesFolder } from '../cli/runner-job.ts';
import { ensurePg } from '../db/pg.ts';
import { loadConfig } from '../cli/recipes.ts';

const WIN = process.platform === 'win32';
const NAME = 'pc-test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code !== 'ESRCH'; } };
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });

const kids: ChildProcess[] = [];
const clients: any[] = [];
after(async () => {
  // #4922: nothing here is ended by a process number, which can be anyone's once its process has ended. A slow job step
  // still running (on POSIX it outlives a killed runner) leaves when it sees the stop file; this file's own children are
  // ended through their handles, which does nothing for one that has ended.
  writeFileSync(STOP, '');
  for (const k of kids) k.kill('SIGKILL');
  await sleep(1000); // a slow step looks every 200 ms, and holds its slot's folder until it has left
  await Promise.all(clients.map((c) => c.end()));
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); // the repos, slot clones, homes
});

// --- setup, once for the file (freshDb truncates the recipes a runner published: never after a runner starts)
const sql = await freshDb(); clients.push(sql);
await sql`select cb.ensure_project('demo'), cb.ensure_project('lost')`;
await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p2','B1@mac','demo','builder')`;
const session = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'claude-session' } }); clients.push(session);

const TMP = mkdtempSync(join(tmpdir(), 'cbr-'));
const STOP = join(TMP, 'stop'); // test/fixtures/slow.mjs ends when this file is there
const ORIGIN = join(TMP, 'origin.git'), WORK = join(TMP, 'work'), HOME = join(TMP, 'home');
writeFileSync(join(TMP, 'gitconfig'), '');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(TMP, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (...args: string[]) => execFileSync('git', args, { cwd: WORK, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (msg: string, files: Record<string, string> = {}) => {
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(WORK, f)), { recursive: true }); writeFileSync(join(WORK, f), body); }
  git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg);
  return git('rev-parse', 'HEAD');
};
execFileSync('git', ['init', '-q', '--bare', ORIGIN], { env: gitEnv });
mkdirSync(WORK); git('init', '-q', '-b', 'main');
git('remote', 'add', 'origin', ORIGIN);
const MAIN = commit('main', {
  'ok.mjs': "console.log('ok');\n",
  'fail.mjs': "console.log('failing'); process.exitCode = 3;\n",
  'slow.mjs': readFileSync('test/fixtures/slow.mjs', 'utf8').replace("'__STOP__'", () => JSON.stringify(STOP)),
  'env.mjs': "const n = ['CB_DATABASE_URL', 'DATABASE_URL', 'RUNNER_MARKER'].filter((k) => process.env[k]); console.log('CB=' + (n.join(',') || 'none'));\n",
  // 3 MB, no newline; masking lengthens each address, so only a cut applied last keeps the summary short
  'big.mjs': "process.stdout.write('a@b.co '.repeat(450000)); process.exitCode = 1;\n",
  'lock.txt': 'v1\n',
  'sub/ok.mjs': "console.log('ok in sub');\n",
  'sub/pkg/t.mjs': '\n',
  'sub/pkg/package.json': '{}\n',
  'sub/deep/t2.mjs': '\n',
});
git('push', '-q', 'origin', 'main');
const PR_ONLY = commit('pr'); git('push', '-q', 'origin', 'HEAD:refs/pull/1/head');
const UNPUSHED = commit('never pushed');
git('checkout', '-q', 'main');
const TAG_ONLY = commit('tag only'); git('tag', 'only-a-tag'); git('push', '-q', 'origin', 'only-a-tag'); // before the first clone
git('checkout', '-q', 'main');

const PORT = await freePort();
const node = (...a: string[]) => ['node', ...a];
const recipes = {
  ok: { steps: [node('ok.mjs')], timeout: 60 },
  fail: { steps: [node('fail.mjs')], timeout: 60 },
  slow: { steps: [node('slow.mjs')], timeout: 3 },
  env: { steps: [node('env.mjs')], timeout: 60 },
  big: { steps: [node('big.mjs')], timeout: 60 },
  nocmd: { steps: [['no-such-program-xyz']], timeout: 60 },
  cmdfile: { steps: [['tool.cmd']], timeout: 60 },
  crash: { steps: [node('-e', 'process.exit(3221226505)')], timeout: 60 }, // 0xC0000409 on Windows: over the board's int
  cleanup: { steps: [node('slow.mjs')], timeout: 2, finally: [node('-e', "require('fs').writeFileSync('done.txt','1')")] },
  pick: { params: { files: { pattern: '^ok\\.mjs$', max: 3 } }, steps: [node('{files}')], timeout: 60 },
  named: { params: { files: { pattern: '^[\\w.-]+\\.mjs$', max: 3 } }, steps: [node('ok.mjs')], timeout: 60 },
  insub: { cwd: 'sub', params: { files: { pattern: '^[\\w./-]+\\.mjs$', max: 4 } }, steps: [node('ok.mjs')], timeout: 60 },
  twice: { steps: [node('ok.mjs'), node('ok.mjs')], timeout: 60 },
  multi: { steps: [node('ok.mjs'), node('ok.mjs'), node('slow.mjs')], timeout: 60 },
  // through an intermediary that is not libuv (as the pnpm shim, git.exe, docker.exe are): its child outlives it
  wrapped: { steps: [WIN ? ['cmd.exe', '/c', 'node', 'slow.mjs'] : ['sh', '-c', 'node slow.mjs']], timeout: 60 },
  zero: { steps: [node('-e', "console.log('ℹ pass 0'); console.log('ℹ fail 0')")], timeout: 60 },
  // #4417: counts with nothing failing, then a non-zero exit (lefthook's program-script-tests: 542 passed, 0 failed, exit 1)
  quiet: { steps: [node('ok.mjs'), node('-e', "console.log('ℹ pass 3'); console.log('ℹ fail 0'); console.error('worker crashed after the run'); process.exit(1)")], timeout: 60 },
  plant: { steps: [node('plant.mjs')], timeout: 60 },
  swap: { steps: [node('swap.mjs')], timeout: 60 },
  nmswap: { steps: [node('nmswap.mjs')], timeout: 60 },
  nulplant: { steps: [node('folder.mjs')], timeout: 60 },
  junkref: { steps: [node('junk.mjs')], timeout: 60 },
  leavepg: { steps: [node('leavepg.mjs')], timeout: 180 },
  headless: { steps: [node('-e', "require('fs').writeFileSync('.git/HEAD', '')")], timeout: 60 },
};
const project = (gitUrl: string, rs: object) => ({ git: gitUrl, base: join(TMP, 'r'), lockfile: 'lock.txt', install: node('-e', "console.log('installed')"), installTimeout: 60, recipes: rs });
const CFG = join(TMP, 'runner.json');
writeFileSync(CFG, JSON.stringify({
  name: NAME, slots: 2, log: { host: '127.0.0.1', port: PORT, peers: ['127.0.0.1'] },
  projects: { demo: project(ORIGIN, recipes), lost: project(join(TMP, 'missing.git'), { ok: recipes.ok }) },
}));

type Runner = { child: ChildProcess; out: string; exited: Promise<number | null> };
function startRunner(config = CFG, home = HOME): Runner {
  const child = spawn(process.execPath, ['cli/runner.ts'], {
    // without NoDefaultCurrentDirectoryInExePath, as in a plain terminal (an agent's shell may set it): the runner sets it
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: undefined, CB_RUNNER_CONFIG: config, CB_RUNNER_HOME: home, CB_DATABASE_URL: TEST_URL, RUNNER_MARKER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  kids.push(child);
  const r: Runner = { child, out: '', exited: new Promise((ok) => child.on('exit', (c) => ok(c))) };
  child.stdout!.on('data', (b) => { r.out += b; });
  child.stderr!.on('data', (b) => { r.out += b; });
  return r;
}
async function until<T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 60_000, every = 100): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}; runner said:\n${runner.out}`);
    await sleep(every);
  }
}
const up = (r: Runner) => until('the runner to come up', () => {
  if (r.child.exitCode !== null) throw new Error(`the runner exited ${r.child.exitCode}:\n${r.out}`);
  return / up\b/.test(r.out) ? true : undefined;
});

let runner = startRunner();
await up(runner);

const add = async (recipe: string, sha = MAIN, params: object = {}) =>
  Number((await session`select cb.job_add('demo', ${recipe}, ${sha}, ${session.json(params as any)}, null, 'B1@mac') as r`)[0]!.r.id);
const get = async (id: number) => (await sql`select cb.job_get(${id}) as j`)[0]!.j;
const ended = (id: number, ms = 60_000) => until(`job #${id} to end`, async () => {
  const j = await get(id);
  return ['queued', 'running'].includes(j.state) ? undefined : j;
}, ms, 200);
const logOf = (id: number) => { try { return readFileSync(join(HOME, 'logs', `${id}.log`), 'utf8'); } catch { return ''; } };
const pidOf = (id: number) => until(`job #${id} to print its pid`, () => {
  const m = /pid (\d+)/.exec(logOf(id));
  if (m) return Number(m[1]);
}, 20_000, 50);
const raw = async (project: string, recipe: string, sha: string, params: object = {}) => {
  const [row] = await sql`insert into cb.jobs (project, recipe, params, sha, requester) values (${project}, ${recipe}, ${sql.json(params as any)}, ${sha}, 'B1@mac') returning id`;
  return Number(row!.id);
};
const poke = () => sql`select pg_notify('cb_jobs', '0')`; // raw rows send no notice

test('a passing job ends passed with its log and a message', async () => {
  const id = await add('ok');
  const j = await ended(id);
  assert.equal(j.state, 'passed', j.summary);
  assert.equal(j.exit_code, 0);
  assert.match(logOf(id), /^ok$/m);
  assert.equal(j.summary, 'ok'); // the log's `$ argv` lines never reach the board
  const msg = await sql`select summary from cb.events where kind = 'message' and data->>'to' = 'B1@mac' and summary like ${`job #${id} %`}`;
  assert.equal(msg.length, 1);
});

test('a failing job ends failed with its exit code', async () => {
  const j = await ended(await add('fail'));
  assert.equal(j.state, 'failed');
  assert.equal(j.exit_code, 3);
});

test('a step that exits non-zero while no test failed names the step and its own last lines (#4417)', async () => {
  const j = await ended(await add('quiet'));
  assert.equal(j.state, 'failed');
  assert.equal(j.exit_code, 1);
  assert.equal(j.summary, 'step 2 of 2 (node) exited 1, but no test failed. Its last lines:\nworker crashed after the run\n3 passed, 0 failed, 0 skipped.');
});

test('the job env is clean', async () => {
  const id = await add('env');
  assert.equal((await ended(id)).state, 'passed');
  assert.match(logOf(id), /^CB=none$/m);
});

test('a sha nobody pushed, or only on a pull-request ref, is refused', async () => {
  assert.equal((await ended(await add('ok', UNPUSHED))).summary, 'error: push it first');
  assert.equal((await ended(await add('ok', PR_ONLY))).summary, 'error: push it first');
  assert.equal((await ended(await add('ok', TAG_ONLY))).summary, 'error: push it first'); // heads only: no tags
  git('checkout', '-q', '-b', 'gone', 'main');
  const GONE = commit('gone', { 'gone.txt': 'x\n' });
  git('push', '-q', 'origin', 'gone');
  git('checkout', '-q', 'main');
  assert.equal((await ended(await add('ok', GONE))).state, 'passed'); // the slot clone now holds the commit
  git('push', '-q', 'origin', '--delete', 'gone');
  const j = await ended(await add('ok', GONE));
  assert.equal(j.state, 'error');
  assert.equal(j.summary, 'error: not on a branch of origin');
});

test('a job over its timeout is killed', async () => {
  const t = Date.now();
  const id = await add('slow');
  const pid = await pidOf(id);
  const j = await ended(id, 20_000);
  assert.equal(j.summary, 'error: timed out after 1 min');
  assert.ok(Date.now() - t < 20_000);
  await until('the slow process to go', () => !alive(pid), 10_000);
});

test('finally runs after a timeout', async () => {
  const j = await ended(await add('cleanup'), 20_000);
  assert.equal(j.summary, 'error: timed out after 1 min');
  assert.ok([1, 2].some((s) => existsSync(join(TMP, 'r', `demo-${s}`, 'done.txt'))));
});

test('a command that cannot start is an error and the runner goes on', async () => {
  const bad = await add('nocmd');
  const cmd = await add('cmdfile'); // a .cmd without a shell: EINVAL on Windows
  const ok = await add('ok');
  assert.equal((await ended(bad)).summary, 'error: could not start no-such-program-xyz');
  assert.equal((await ended(cmd)).summary, 'error: could not start tool.cmd');
  assert.equal((await ended(ok)).state, 'passed');
});

test('a crash exit code too big for the board still ends the job', async () => {
  const crash = await add('crash');
  const ok = await add('ok');
  const j = await ended(crash);
  assert.equal(j.state, 'failed');
  assert.notEqual(j.exit_code, 0);
  assert.equal((await ended(ok)).state, 'passed');
});

test('huge output keeps the summary short', async () => {
  const id = await add('big');
  const j = await ended(id);
  assert.equal(j.state, 'failed');
  assert.equal(j.exit_code, 1);
  assert.ok(j.summary.length <= 1000, `summary is ${j.summary.length} chars`);
  assert.match(j.summary, /\[masked\]/);
  assert.ok(statSync(join(HOME, 'logs', `${id}.log`)).size >= 3_000_000, 'the full log stays on disk');
});

test('the lockfile install runs once per slot', async () => {
  git('checkout', '-q', '-b', 'lock2', 'main');
  const LOCK2 = commit('lock v2', { 'lock.txt': 'v2\n' });
  git('push', '-q', 'origin', 'lock2');
  git('checkout', '-q', 'main');
  const a = await add('ok', LOCK2);
  assert.equal((await ended(a)).state, 'passed');
  const b = await add('ok', LOCK2);
  assert.equal((await ended(b)).state, 'passed');
  assert.match(logOf(a), /^installed$/m);
  assert.doesNotMatch(logOf(b), /installed/);
});

test('cancel stops a running job', async () => {
  const id = await add('slow');
  const pid = await pidOf(id);
  await session`select cb.job_cancel(${id}, 'B1@mac')`;
  await until('the slow process to go', () => !alive(pid), 10_000, 50);
  await until('the runner to drop the job', () => runner.out.includes(`job #${id} cancelled`), 10_000);
  assert.equal((await get(id)).state, 'cancelled');
});

test('the pid record holds only live roots and goes with the job', async () => {
  const records = () => readdirSync(join(HOME, 'state')).filter((f) => f.endsWith('.pids'));
  assert.equal((await ended(await add('twice'))).state, 'passed');
  assert.deepEqual(records(), []);
  const id = await add('multi');
  await pidOf(id); // slow.mjs runs, after two steps that ended
  const [file, ...more] = records();
  assert.equal(more.length, 0);
  const lines = readFileSync(join(HOME, 'state', file!), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, lines.join(' | '));
  assert.ok(alive(Number(lines[0]!.split(' ')[0])), 'the recorded root is live');
  await session`select cb.job_cancel(${id}, 'B1@mac')`;
  await until('the runner to drop the job', () => runner.out.includes(`job #${id} cancelled`), 10_000);
  assert.deepEqual(records(), []);
});

test('bad parameters end the job before any git work', async () => {
  const id = await add('pick', MAIN, { files: ['ok.mjs', 'fail.mjs'] });
  const j = await ended(id);
  assert.equal(j.summary, 'error: bad parameter files: fail.mjs');
  assert.doesNotMatch(logOf(id), /git/);
});

// #4338: a made-up name in --files used to be dropped by the test tool, and the job passed on the other tests
test('a file named in a path parameter that is not there at the sha fails the job, naming it', async () => {
  const id = await add('named', MAIN, { files: ['ok.mjs', 'made-up.mjs'] });
  const j = await ended(id);
  assert.equal(j.state, 'error');
  assert.match(j.summary, new RegExp(`^error: not in the repo at ${MAIN.slice(0, 12)}: made-up\\.mjs \\(paths are relative to the recipe's folder, \\.\\)$`));
  assert.equal((await ended(await add('named', MAIN, { files: ['ok.mjs'] }))).state, 'passed');
});

// #4338 review: in a recipe whose folder is sub, a name is read from sub (sub/x from the repo root is taken too) or from a
// package folder under it (sub/pkg has a package.json, as pnpm --filter ... exec runs there); a tail of a deeper path
// is not the file (node --test drops it when another name matches, and the job would pass), nor is a file outside sub
test('a path parameter is checked in the recipe folder at the sha: from the folder, from the root, or from a package folder', async () => {
  for (const files of [['sub/ok.mjs'], ['ok.mjs'], ['pkg/t.mjs', 't.mjs'], ['deep/t2.mjs']])
    assert.equal((await ended(await add('insub', MAIN, { files }))).state, 'passed', files.join(' '));
  const j = await ended(await add('insub', MAIN, { files: ['sub/nope.mjs', 'fail.mjs', 't2.mjs', 'ok.mjs'] }));
  assert.equal(j.summary, `error: not in the repo at ${MAIN.slice(0, 12)}: nope.mjs, fail.mjs, t2.mjs (paths are relative to the recipe's folder, sub)`);
});

test('a row written around job_add is refused', async () => {
  // forged recipe rows, so this runner claims them: the fence under test is its own config check
  await sql`insert into cb.runner_recipes (runner, project, recipe) values (${NAME}, 'demo', 'ghost'), (${NAME}, 'demo', 'constructor')`;
  const ids = [
    await raw('demo', 'ok', ';rm'),
    await raw('demo', 'ghost', MAIN),
    await raw('demo', 'constructor', MAIN),
    await raw('demo', 'ok', MAIN, { files: 'ok.mjs' }),
  ];
  assert.equal((await get(ids[3]!)).params.files, 'ok.mjs'); // stored as an object holding a string, not a JSON string
  await poke();
  for (const id of ids) assert.equal((await ended(id)).summary, 'error: bad job row', `job #${id}`);
  assert.equal((await ended(await add('ok'))).state, 'passed');
});

test('zero tests is not a pass', async () => {
  const j = await ended(await add('zero'));
  assert.equal(j.state, 'failed');
  assert.match(j.summary, /^no tests ran/);
});

test('an unreachable origin is an error, not a hang', async () => {
  const id = await raw('lost', 'ok', MAIN);
  await poke();
  assert.equal((await ended(id)).summary, 'error: could not fetch from origin');
});

test('the log server answers peers only', async () => {
  const id = await add('ok');
  assert.equal((await ended(id)).state, 'passed');
  const r = await fetch(`http://127.0.0.1:${PORT}/jobs/${id}/log?tail=1`);
  assert.equal(r.status, 200);
  assert.equal((await r.text()).trim(), 'ok');
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/jobs/${id}/x`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/jobs/999999/log`)).status, 404);
  // a malformed absolute-form target must not take the runner down
  await new Promise<void>((ok) => {
    const c = connect(PORT, '127.0.0.1', () => c.end('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'));
    c.on('data', () => {}); c.on('close', () => ok()); c.on('error', () => ok());
  });
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/jobs/${id}/log?tail=1`)).status, 200);

  // another runner (own name, port, home; a recipe nobody queues) whose peers list is empty
  const port2 = await freePort();
  const cfg2 = join(TMP, 'runner-nopeers.json');
  writeFileSync(cfg2, JSON.stringify({ name: 'pc-nopeers', slots: 1, log: { host: '127.0.0.1', port: port2, peers: [] }, projects: { demo: project(ORIGIN, { idle: recipes.ok }) } }));
  const other = startRunner(cfg2, join(TMP, 'home2'));
  await up(other);
  const denied = await fetch(`http://127.0.0.1:${port2}/jobs/${id}/log`);
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /this machine may not read job logs/);
  other.child.kill('SIGKILL');
  await other.exited;
});

test('a second runner refuses to start', async () => {
  const second = startRunner();
  assert.equal(await second.exited, 1);
  assert.match(second.out, /a runner is already running on this machine/);
});

test('a restarted runner ends its running job, kills what it left running and runs the queue', async () => {
  const id = await add('wrapped');
  const pid = await pidOf(id);
  // the runner alone dies (no tree kill), as in a crash: slow.mjs, under cmd.exe / sh, lives on in the slot
  runner.child.kill('SIGKILL'); // this process alone, by its handle: never a reused number
  await runner.exited;
  await sleep(500);
  assert.ok(alive(pid), 'the orphan is still running before the restart');
  // a decoy record whose pid was reused by another node.exe (an agent session, a relay): on Windows every recorded root
  // is node.exe (the launcher), so only the launcher's own mark (its slot's .nostart path) in the command line counts
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore', windowsHide: true });
  kids.push(decoy);
  writeFileSync(join(HOME, 'state', 'slot-2.pids'), `${decoy.pid} ${WIN ? 'node.exe' : 'node'}\n`);
  // a record from before the last boot is never acted on, even when its pid carries the mark
  const stale = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', join(HOME, 'state', 'slot-3.nostart')], { detached: true, stdio: 'ignore', windowsHide: true });
  kids.push(stale);
  writeFileSync(join(HOME, 'state', 'slot-3.pids'), `${stale.pid} ${WIN ? 'node.exe' : 'node'}\n`);
  utimesSync(join(HOME, 'state', 'slot-3.pids'), new Date('2000-01-01'), new Date('2000-01-01'));
  const ok = await add('ok');
  runner = startRunner();
  await up(runner);
  if (WIN) assert.ok(alive(decoy.pid!), 'a reused pid running another node.exe is left alone');
  assert.ok(alive(stale.pid!), 'a record older than the boot is left alone');
  const j = await ended(id);
  assert.equal(j.state, 'error');
  assert.equal(j.summary, 'error: runner restarted');
  const msg = await sql`select summary from cb.events where kind = 'message' and data->>'to' = 'B1@mac' and summary like ${`job #${id} %`}`;
  assert.match(msg[0]?.summary ?? '', /runner restarted/);
  await until('the orphan to go', () => !alive(pid), 10_000);
  assert.equal((await ended(ok)).state, 'passed'); // in the slot the orphan held
});

test('an over-long pid line does not switch reaping off', async () => {
  const id = await add('wrapped');
  const pid = await pidOf(id);
  runner.child.kill('SIGKILL'); // this process alone, by its handle: never a reused number
  await runner.exited;
  await sleep(500);
  const rec = readFileSync(join(HOME, 'state', 'slot-1.pids'), 'utf8');
  writeFileSync(join(HOME, 'state', 'slot-1.pids'), `9999999999 node\n${'9'.repeat(20)} node\n${rec}`);
  runner = startRunner();
  await up(runner);
  await until('the orphan to go', () => !alive(pid), 10_000);
  await ended(id);
});

// Jobs run one at a time below, so each lands in slot 1, the first free one.
test('a committed git.exe at the repo root is not the git the runner runs', { skip: !WIN && 'Windows exe search only' }, async () => {
  // whoami.exe refuses git's arguments, so a hijacked git call fails the job. Index only: a git.exe in WORK would
  // hijack this test's own git calls.
  const blob = git('hash-object', '-w', 'C:/Windows/System32/whoami.exe');
  git('checkout', '-q', '-b', 'exe', 'main');
  git('update-index', '--add', '--cacheinfo', `100755,${blob},git.exe`);
  git('commit', '-q', '-m', 'git.exe at the root');
  const EXE = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', 'exe');
  git('checkout', '-q', 'main');
  const a = await add('ok', EXE); // clean and the lockfile rev-parse run with git.exe in the cwd
  const ja = await ended(a);
  assert.equal(ja.state, 'passed', ja.summary);
  const b = await add('ok'); // the next job's fetch too
  const jb = await ended(b);
  assert.equal(jb.state, 'passed', jb.summary);
  assert.doesNotMatch(logOf(a) + logOf(b), /Invalid argument/);
});

test('hooks, config and git locks a job plants in the slot clone never run or stick', async () => {
  const hookMark = join(TMP, 'hook-ran').replaceAll('\\', '/'), filterMark = join(TMP, 'filter-ran').replaceAll('\\', '/');
  // lock-named links, and a link to a folder holding a lock: the lock clearing removes the links, never what they reach
  // (the folder behind the kept link holds only a lock: git refuses any other non-ref file it finds under refs)
  const outside = join(TMP, 'outside').replaceAll('\\', '/'), inside = join(TMP, 'outside-in').replaceAll('\\', '/');
  mkdirSync(outside, { recursive: true }); mkdirSync(inside, { recursive: true });
  writeFileSync(join(inside, 'keep'), '1'); writeFileSync(join(outside, 'y.lock'), '1');
  // a post-checkout hook, and a smudge filter set in .git/config for x.txt (.git/info/attributes)
  const plant = [
    "import { appendFileSync, chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';",
    "mkdirSync('.git/hooks', { recursive: true }); mkdirSync('.git/info', { recursive: true });",
    `writeFileSync('.git/hooks/post-checkout', '#!/bin/sh\\necho hit > "${hookMark}"\\n'); chmodSync('.git/hooks/post-checkout', 0o755);`,
    `appendFileSync('.git/config', '\\n[filter "x"]\\n\\tsmudge = echo hit > ${filterMark} && cat\\n');`,
    "writeFileSync('.git/info/attributes', 'x.txt filter=x\\n');",
    "writeFileSync('.git/config.lock', '');", // would fail the next job's git config call
    // would fail the next job's checkout and fetch
    "mkdirSync('.git/refs/remotes/origin', { recursive: true }); writeFileSync('.git/index.lock', ''); writeFileSync('.git/HEAD.lock', ''); writeFileSync('.git/refs/remotes/origin/plant.lock', '');",
    `symlinkSync('${inside}', '.git/refs/x.lock', 'junction'); symlinkSync('${outside}', '.git/refs/linked', 'junction');`,
    "console.log('planted');",
  ].join('\n');
  git('checkout', '-q', '-b', 'plant', 'main');
  const P = commit('plant', { 'plant.mjs': plant, 'x.txt': 'a\n' });
  const Q = commit('next', { 'x.txt': 'b\n' }); // checking it out rewrites x.txt: the filter would run
  git('push', '-q', 'origin', 'plant');
  git('checkout', '-q', 'main');
  const jp = await ended(await add('plant', P));
  assert.equal(jp.state, 'passed', jp.summary);
  const jq = await ended(await add('ok', Q));
  assert.equal(jq.state, 'passed', jq.summary);
  assert.equal(existsSync(hookMark), false, 'the planted hook ran');
  assert.equal(existsSync(filterMark), false, 'the planted filter ran');
  assert.ok(existsSync(join(inside, 'keep')) && existsSync(join(outside, 'y.lock')), 'the lock clearing went through a link');
});

// #3776: a link a job leaves where a tracked folder was survived checkout --force (a junction, on Windows), and the
// clean then deleted untracked files inside its target, outside the clone. The runner drops every link before checkout.
test('a link a job leaves over a tracked folder is removed before the checkout: nothing outside the slot is deleted', async () => {
  const outside = join(TMP, 'swap-target').replaceAll('\\', '/');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'package.json'), '{}\n'); // the same as the tracked one, as in the report
  writeFileSync(join(outside, 'victim.txt'), 'outside the slot');
  const swap = [
    "import { rmSync, symlinkSync } from 'node:fs';",
    `rmSync('pkg', { recursive: true, force: true }); symlinkSync('${outside}', 'pkg', 'junction');`,
    "console.log('planted');",
  ].join('\n');
  git('checkout', '-q', '-b', 'swap', 'main');
  mkdirSync(join(WORK, 'pkg'), { recursive: true });
  const P = commit('swap', { 'swap.mjs': swap, 'pkg/package.json': '{}\n' });
  git('push', '-q', 'origin', 'swap');
  git('checkout', '-q', 'main');
  const jp = await ended(await add('swap', P));
  assert.equal(jp.state, 'passed', jp.summary);
  const qid = await add('ok', P);
  const jq = await ended(qid);
  assert.equal(jq.state, 'passed', jq.summary);
  assert.ok(existsSync(join(outside, 'victim.txt')), 'the clean deleted a file outside the slot, through the link');
  assert.ok(existsSync(join(outside, 'package.json')));
  assert.match(logOf(qid), /removed 1 link\(s\) a job left in the slot: pkg/);
});

// review I1 of #3776: a link the runner drops may be the install itself (node_modules swapped for a link). The install
// record still matched the lockfile, so every later job on the slot ran with no install: dropping a link forces one.
test('a node_modules a job swaps for a link is removed and the next job installs again', async () => {
  const outside = join(TMP, 'nm-target').replaceAll('\\', '/');
  mkdirSync(outside, { recursive: true });
  const plant = [
    "import { rmSync, symlinkSync } from 'node:fs';",
    `rmSync('node_modules', { recursive: true, force: true }); symlinkSync('${outside}', 'node_modules', 'junction');`,
    "console.log('planted');",
  ].join('\n');
  git('checkout', '-q', '-b', 'nmswap', 'main');
  const P = commit('nm swap', { 'nmswap.mjs': plant });
  git('push', '-q', 'origin', 'nmswap');
  git('checkout', '-q', 'main');
  assert.equal((await ended(await add('ok', P))).state, 'passed'); // installed for this lockfile, or already was
  const jp = await ended(await add('nmswap', P));
  assert.equal(jp.state, 'passed', jp.summary);
  const qid = await add('ok', P);
  assert.equal((await ended(qid)).state, 'passed');
  assert.match(logOf(qid), /removed 1 link\(s\) a job left in the slot: node_modules/);
  assert.match(logOf(qid), /^installed$/m, 'the install record outlived the install');
  const rid = await add('ok', P);
  assert.equal((await ended(rid)).state, 'passed');
  assert.doesNotMatch(logOf(rid), /installed/, 'one reinstall, not one per job');
});

test('a NUL folder a job plants in the slot does not break the next job', { skip: !WIN && 'Windows only' }, async () => {
  git('checkout', '-q', '-b', 'folder', 'main');
  const P = commit('nul', { 'folder.mjs': String.raw`import { mkdirSync, writeFileSync } from 'node:fs'; import { resolve } from 'node:path'; const d = '\\\\?\\' + resolve('NUL'); mkdirSync(d, { recursive: true }); writeFileSync(d + '\\x', '1'); console.log('planted');` });
  git('push', '-q', 'origin', 'folder');
  git('checkout', '-q', 'main');
  const jp = await ended(await add('nulplant', P));
  assert.equal(jp.state, 'passed', jp.summary);
  const jq = await ended(await add('ok'));
  assert.equal(jq.state, 'passed', jq.summary);
});

// #4756: a Postgres a job leaves running is no child of the job (pg_ctl starts it outside the tree), and it holds
// .pgdata/server.log open: the next job's git clean deleted the cluster's other files under it, then failed on that one
const PG_BIN = process.env.CB_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin';
const pgUp = (dir: string) => { try { execFileSync(join(PG_BIN, 'pg_ctl.exe'), ['-D', dir, 'status'], { stdio: 'ignore' }); return true; } catch { return false; } };
const pgDown = (dir: string) => { try { execFileSync(join(PG_BIN, 'pg_ctl.exe'), ['-D', dir, 'stop', '-m', 'immediate', '-w'], { stdio: 'ignore' }); } catch {} };
const slotOf = (id: number) => new RegExp(`job #${id} started in slot (\\d+)`).exec(runner.out)?.[1];

test('a Postgres a job leaves running in the slot is stopped before the next job, and only that one', { skip: !WIN && 'Windows only', timeout: 300_000 }, async () => {
  const port = await freePort(), otherPort = await freePort();
  git('checkout', '-q', '-b', 'leavepg', 'main');
  const P = commit('leavepg', { 'leavepg.mjs': `import { spawnSync } from 'node:child_process';
const run = (exe, args) => { if (spawnSync(${JSON.stringify(PG_BIN)} + '/' + exe, args, { stdio: 'ignore' }).status !== 0) { console.log(exe + ' failed'); process.exit(1); } };
run('initdb.exe', ['-D', '.pgdata', '-U', 'cb', '--auth=trust', '-E', 'UTF8']);
run('pg_ctl.exe', ['-D', process.cwd() + '/.pgdata', '-o', '-p ${port} -c listen_addresses=127.0.0.1', '-l', '.pgdata/server.log', '-w', 'start']);
console.log('left one running');
` });
  git('push', '-q', 'origin', 'leavepg');
  git('checkout', '-q', 'main');
  const first = await add('leavepg', P);
  const j1 = await ended(first);
  assert.equal(j1.state, 'passed', j1.summary);
  const slot = slotOf(first)!, pgdata = join(TMP, 'r', `demo-${slot}`, '.pgdata'), other = join(TMP, 'other', '.pgdata');
  try {
    assert.ok(pgUp(pgdata), 'the job left its cluster running');
    const second = await add('ok');
    const j2 = await ended(second);
    assert.equal(slotOf(second), slot, 'the same slot');
    assert.equal(j2.state, 'passed', `${j2.summary}
${logOf(second)}`);
    assert.ok(!pgUp(pgdata), 'the leftover cluster is stopped');
    // a stale pid file whose pid now belongs to another cluster (reused after a crash) never stops that one
    ensurePg(other, otherPort);
    mkdirSync(pgdata, { recursive: true });
    writeFileSync(join(pgdata, 'postmaster.pid'), readFileSync(join(other, 'postmaster.pid')));
    const j3 = await ended(await add('ok'));
    assert.equal(j3.state, 'passed', j3.summary);
    assert.ok(pgUp(other), "another folder's cluster is left running");
  } finally {
    pgDown(pgdata);
    pgDown(other);
  }
});

test("servesFolder: only a postmaster whose -D is that very folder", () => {
  const cmd = '"C:/Program Files/PostgreSQL/16/bin/postgres.exe"  -D "C:/r/demo-1/.pgdata" -p 5434';
  const slot = String.raw`C:\r\demo-1\.pgdata`;
  assert.ok(servesFolder(cmd, slot));
  assert.ok(servesFolder(cmd, 'c:/R/Demo-1/.pgdata'), 'Windows paths ignore case');
  assert.ok(!servesFolder(cmd, String.raw`C:\r\demo-10\.pgdata`));
  assert.ok(!servesFolder(cmd.replace('demo-1', 'demo-10'), slot));
  assert.ok(!servesFolder('"C:/x/postgres.exe" -D "C:/main/.pgdata" -p 5434', slot));
  assert.ok(!servesFolder('', slot));
});

test('a non-ref file a job leaves under .git/refs starts the slot over, not a failed fetch', async () => {
  git('checkout', '-q', '-b', 'junk', 'main');
  const P = commit('junk', { 'junk.mjs': "import { writeFileSync } from 'node:fs'; writeFileSync('.git/refs/junk', 'not a ref'); console.log('planted');" });
  git('push', '-q', 'origin', 'junk');
  git('checkout', '-q', 'main');
  const jp = await ended(await add('junkref', P));
  assert.equal(jp.state, 'passed', jp.summary);
  const id = await add('ok');
  const jq = await ended(id);
  assert.equal(jq.state, 'passed', jq.summary);
  assert.match(logOf(id), /git clone/); // the fetch failed, the slot was cloned again
});

test('a job that empties .git/HEAD does not fault the slot: the next job starts it over', async () => {
  const jp = await ended(await add('headless'));
  assert.equal(jp.state, 'passed', jp.summary);
  const id = await add('ok');
  const jq = await ended(id);
  assert.equal(jq.state, 'passed', jq.summary);
  assert.match(logOf(id), /git clone/); // git could not read the clone: it was cloned again
});

test('the runner reports its slots, and at start runs Ahmed\'s board setting over runner.json, beyond the old cap (#4527)', async () => {
  const row = async () => ({ ...(await sql`select slots, db_lanes from cb.runners where name = ${NAME}`)[0] });
  assert.deepEqual(await row(), { slots: 2, db_lanes: 1 }, 'runner.json\'s counts, reported');
  await sql`select cb.runner_limits_set(${NAME}, 12, null, 'ahmed')`;
  runner.child.kill('SIGKILL'); // this process alone, by its handle: never a reused number
  await runner.exited;
  runner = startRunner();
  await up(runner);
  assert.deepEqual(await row(), { slots: 12, db_lanes: 1 });
  assert.match(runner.out, /12 slots and 1 DB lane\(s\) \(the board's setting\)/);
  const j = await ended(await add('ok'));
  assert.equal(j.state, 'passed', j.summary);
  // review M3: a setting runner.json cannot take (3 lanes on a file with no laneEnv) keeps the file's counts, and the
  // board learns why, so the page can say so
  await sql`select cb.runner_limits_set(${NAME}, null, 3, 'ahmed')`;
  runner.child.kill('SIGKILL'); // this process alone, by its handle: never a reused number
  await runner.exited;
  runner = startRunner();
  await up(runner);
  assert.deepEqual(await row(), { slots: 2, db_lanes: 1 });
  assert.match(runner.out, /the board's slot setting does not fit runner\.json/);
  assert.match((await sql`select setting_refused from cb.runners where name = ${NAME}`)[0]!.setting_refused, /does not fit runner\.json/);
  const q = (await sql`select cb.runner_queue() as q`)[0]!.q;
  assert.equal(q.runners.find((r: any) => r.name === NAME).setting_refused, true);
  await sql`select cb.runner_limits_set(${NAME}, null, null, 'ahmed', true, true)`;
});

// runJob in this process, with its own home and slot folders: no board, no daemon
const DHOME = join(TMP, 'dhome');
const direct = (name: string, gitUrl: string, id: number, sha = MAIN, lockfile = 'lock.txt') => {
  const cfg = loadConfig(JSON.stringify({ slots: 1, log: { host: '127.0.0.1', port: 1, peers: [] },
    projects: { [name]: { ...project(gitUrl, { ok: recipes.ok }), base: join(TMP, 'direct'), lockfile } } }));
  return runJob({ id, project: name, recipe: 'ok', sha, params: {} }, { cfg, home: DHOME, slot: 1, stop: new AbortController().signal });
};
const dlog = (id: number) => readFileSync(join(DHOME, 'logs', `${id}.log`), 'utf8');

test('a fresh slot installs even when the lockfile cannot be read at the sha', async () => {
  const r = await direct('nolock', ORIGIN, 900001, MAIN, 'no-such.lock');
  assert.equal(r?.state, 'passed', r?.summary);
  assert.match(dlog(900001), /^installed$/m);
});

test('a changed git URL in runner.json reaches an existing slot clone', async () => {
  const a = await direct('moved', ORIGIN, 900002);
  assert.equal(a?.state, 'passed', a?.summary);
  const ORIGIN2 = join(TMP, 'origin2.git');
  execFileSync('git', ['clone', '-q', '--bare', ORIGIN, ORIGIN2], { env: gitEnv });
  git('checkout', '-q', '-b', 'moved', 'main');
  const M = commit('only on the new origin');
  git('push', '-q', ORIGIN2, 'moved');
  git('checkout', '-q', 'main');
  const b = await direct('moved', ORIGIN2, 900003, M);
  assert.equal(b?.state, 'passed', b?.summary);
});

test('an origin that does not answer keeps the slot clone and what is in it', async () => {
  const ORIGIN3 = join(TMP, 'origin3.git');
  execFileSync('git', ['clone', '-q', '--bare', ORIGIN, ORIGIN3], { env: gitEnv });
  const a = await direct('kept', ORIGIN3, 900004);
  assert.equal(a?.state, 'passed', a?.summary);
  const marker = join(TMP, 'direct', 'kept-1', 'marker.txt');
  writeFileSync(marker, '1');
  rmSync(ORIGIN3, { recursive: true, force: true });
  const b = await direct('kept', ORIGIN3, 900005);
  assert.equal(b?.summary, 'error: could not fetch from origin');
  assert.ok(existsSync(marker), 'the slot was wiped for an outside problem');
});

// #4412: a junction a job left under .git/refs let the fetch's --prune delete the ref-shaped files in its target, outside
// the slot. The target holds only such a file: one non-ref file there and git refuses the whole prune.
test('a link a job leaves under .git starts the slot over: the fetch never prunes through it', async () => {
  const a = await direct('refslink', ORIGIN, 900006);
  assert.equal(a?.state, 'passed', a?.summary);
  const outside = join(TMP, 'refs-target');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'victim'), `${MAIN}\n`);
  const at = join(TMP, 'direct', 'refslink-1', '.git', 'refs', 'remotes', 'origin');
  mkdirSync(at, { recursive: true });
  symlinkSync(outside, join(at, 'x'), 'junction');
  const b = await direct('refslink', ORIGIN, 900007);
  assert.equal(b?.state, 'passed', b?.summary);
  assert.ok(existsSync(join(outside, 'victim')), 'the fetch pruned a file outside the slot, through the link');
  assert.match(dlog(900007), /a job left a link under \.git: the slot starts over/);
  assert.match(dlog(900007), /git clone/);
});

// #3703: a project may hold several repos, each with its own git, lockfile, install and recipes
const LOG = { host: '127.0.0.1', port: 1, peers: [] };
const repoOf = (gitUrl: string, rs: object = { ok: recipes.ok }) => { const { base: _b, ...r } = project(gitUrl, rs); return r; };

test('loadConfig: a project\'s repos', async () => {
  const { published } = await import('../cli/recipes.ts');
  const cfg = loadConfig(JSON.stringify({ slots: 1, log: LOG, projects: {
    zed: { base: join(TMP, 'direct'), repos: { api: repoOf(ORIGIN), dashboard: repoOf(ORIGIN, { ok: recipes.ok, fail: recipes.fail }) } },
    demo: project(ORIGIN, { ok: recipes.ok }),
  } }));
  assert.deepEqual(Object.keys(cfg.projects.zed!.repos), ['api', 'dashboard']);
  assert.equal(cfg.projects.zed!.base, join(TMP, 'direct'));
  assert.equal(cfg.projects.zed!.repos.dashboard!.git, ORIGIN);
  assert.deepEqual(Object.keys(cfg.projects.zed!.repos.dashboard!.recipes), ['ok', 'fail']);
  // a flat project is one repo, main, with the same fields
  assert.deepEqual(Object.keys(cfg.projects.demo!.repos), ['main']);
  assert.equal(cfg.projects.demo!.repos.main!.lockfile, 'lock.txt');
  assert.equal(cfg.projects.demo!.repos.main!.installTimeout, 60);
  assert.throws(() => loadConfig(JSON.stringify({ slots: 1, log: LOG, projects: { zed: { base: TMP, git: ORIGIN, repos: { api: repoOf(ORIGIN) } } } })),
    /projects\.zed: unknown key "git"/);
  assert.throws(() => loadConfig(JSON.stringify({ slots: 1, log: LOG, projects: { zed: { base: TMP, repos: { api: { ...repoOf(ORIGIN), base: TMP } } } } })),
    /projects\.zed\.repos\.api: unknown key "base"/);
  // a flat zed-api and zed's repo api would share slot clones and install records: refused
  assert.throws(() => loadConfig(JSON.stringify({ slots: 1, log: LOG, projects: { zed: { base: TMP, repos: { api: repoOf(ORIGIN) } }, 'zed-api': project(ORIGIN, { ok: recipes.ok }) } })),
    /projects: zed-api and zed repo api would share the slot clones zed-api-<slot>/);
  const pub = published(cfg);
  assert.ok(pub.every((r) => typeof r.repo === 'string'));
  assert.deepEqual(pub.map((r) => `${r.project}/${r.repo}/${r.recipe}`), ['zed/api/ok', 'zed/dashboard/ok', 'zed/dashboard/fail', 'demo/main/ok']);
});

test('slot clones per repo', async () => {
  const cfg = loadConfig(JSON.stringify({ slots: 1, log: LOG, projects: {
    zed: { base: join(TMP, 'direct'), repos: { api: repoOf(ORIGIN), dashboard: repoOf(ORIGIN) } },
    flat: { ...project(ORIGIN, { ok: recipes.ok }), base: join(TMP, 'direct') },
  } }));
  const one = (id: number, project: string, repo?: string) =>
    runJob({ id, project, ...(repo ? { repo } : {}), recipe: 'ok', sha: MAIN, params: {} }, { cfg, home: DHOME, slot: 1, stop: new AbortController().signal });
  const d = await one(900010, 'zed', 'dashboard');
  assert.equal(d?.state, 'passed', d?.summary);
  assert.ok(existsSync(join(TMP, 'direct', 'zed-dashboard-1', '.git')));
  assert.ok(existsSync(join(DHOME, 'state', 'zed-dashboard-1.lock')));
  assert.ok(existsSync(join(DHOME, 'state', 'zed-dashboard-1.gitconfig')));
  assert.ok(!existsSync(join(TMP, 'direct', 'zed-1')));
  const f = await one(900011, 'flat', 'main');
  assert.equal(f?.state, 'passed', f?.summary);
  assert.ok(existsSync(join(TMP, 'direct', 'flat-1', '.git')));
  assert.ok(existsSync(join(DHOME, 'state', 'flat-1.lock')));
  // a row without a repo (an older board) is main; a repo this PC does not have is refused, naming it
  assert.equal((await one(900012, 'flat'))?.state, 'passed');
  assert.equal((await one(900013, 'zed', 'bot'))?.summary, 'error: bad job row: no repo bot for zed on this PC');
  assert.equal((await one(900014, 'zed'))?.summary, 'error: bad job row: no repo main for zed on this PC');
});

// #3763: git clean keeps node_modules (the install) and so every build cache inside it. tsc's tsbuildinfo there
// described a dist the clean had just wiped, and the next build emitted nothing. The slot reset drops node_modules/.cache
// beside each tracked package.json; the install itself stays.
test('a slot reset drops each package\'s node_modules/.cache, keeps the install', async () => {
  git('checkout', '-q', '-b', 'caches', 'main');
  for (const d of ['a', 'b', 'c']) mkdirSync(join(WORK, 'pkg', d), { recursive: true });
  const C = commit('packages', { 'package.json': '{"name":"root"}\n', 'pkg/a/package.json': '{"name":"a"}\n', 'pkg/b/package.json': '{"name":"b"}\n',
    'pkg/c/package.json': '{"name":"c"}\n' });
  git('push', '-q', 'origin', 'caches');
  git('checkout', '-q', 'main');
  assert.equal((await direct('caches', ORIGIN, 900030, C))?.state, 'passed');
  const slot = join(TMP, 'direct', 'caches-1');
  const plant = (rel: string) => { mkdirSync(join(slot, rel, '..'), { recursive: true }); writeFileSync(join(slot, rel), '1'); };
  for (const f of ['node_modules/.cache/tsbuildinfo', 'pkg/a/node_modules/.cache/tsbuildinfo', 'node_modules/keep.txt', 'pkg/a/node_modules/dep/index.js', 'other/node_modules/.cache/x'])
    plant(f);
  // a node_modules a job linked outside the slot: what it points at is never touched
  const outside = join(TMP, 'outside-nm');
  mkdirSync(join(outside, '.cache'), { recursive: true }); writeFileSync(join(outside, '.cache', 'x'), '1');
  symlinkSync(outside, join(slot, 'pkg', 'b', 'node_modules'), 'junction');
  // a tracked package folder the job swapped for a link to a copy outside the slot: the copy's cache stays too
  const copy = join(TMP, 'outside-pkg');
  mkdirSync(join(copy, 'node_modules', '.cache'), { recursive: true });
  writeFileSync(join(copy, 'package.json'), '{"name":"c"}\n'); writeFileSync(join(copy, 'node_modules', '.cache', 'x'), '1');
  rmSync(join(slot, 'pkg', 'c'), { recursive: true, force: true });
  symlinkSync(copy, join(slot, 'pkg', 'c'), 'junction');
  assert.equal((await direct('caches', ORIGIN, 900031, C))?.state, 'passed');
  assert.ok(existsSync(join(outside, '.cache', 'x')), 'a linked node_modules is skipped');
  assert.ok(existsSync(join(copy, 'node_modules', '.cache', 'x')), 'a linked package folder is skipped');
  assert.ok(existsSync(join(slot, 'other', 'node_modules', '.cache', 'x')), 'a node_modules with no tracked package.json beside it is not touched');
  assert.ok(!existsSync(join(slot, 'node_modules', '.cache')), 'the root cache is gone');
  assert.ok(!existsSync(join(slot, 'pkg', 'a', 'node_modules', '.cache')), 'a package cache is gone');
  assert.ok(existsSync(join(slot, 'node_modules', 'keep.txt')) && existsSync(join(slot, 'pkg', 'a', 'node_modules', 'dep', 'index.js')), 'the install stays');
  // the two links were dropped before the checkout (#3776), and a dropped link forces one install (its review, I1)
  assert.match(dlog(900031), /^installed$/m, 'dropped links force one install');
  // a cache drop alone never reinstalls
  for (const f of ['node_modules/.cache/tsbuildinfo', 'pkg/a/node_modules/.cache/tsbuildinfo']) plant(f);
  assert.equal((await direct('caches', ORIGIN, 900032, C))?.state, 'passed');
  assert.ok(!existsSync(join(slot, 'node_modules', '.cache')), 'the root cache is gone');
  assert.doesNotMatch(dlog(900032), /^installed$/m, 'no reinstall');
});
