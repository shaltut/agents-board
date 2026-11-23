// The PC job runner daemon end to end: a real runner child against the test DB and a local bare git repo.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const WIN = process.platform === 'win32';
const NAME = 'pc-test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code !== 'ESRCH'; } };
const killTree = (pid: number | undefined) => {
  if (!pid) return;
  if (WIN) { try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  else { try { process.kill(pid, 'SIGKILL'); } catch {} }
};
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });

const kids: ChildProcess[] = [];
const pids: number[] = []; // slow.mjs processes: on POSIX they outlive a killed runner
const clients: any[] = [];
after(async () => {
  for (const k of kids) killTree(k.pid);
  for (const p of pids) try { process.kill(p, 'SIGKILL'); } catch {}
  await Promise.all(clients.map((c) => c.end()));
});

// --- setup, once for the file (freshDb truncates the recipes a runner published: never after a runner starts)
const sql = await freshDb(); clients.push(sql);
await sql`select cb.ensure_project('demo'), cb.ensure_project('lost')`;
await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p2','B1@mac','demo','builder')`;
const session = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'claude-session' } }); clients.push(session);

const TMP = mkdtempSync(join(tmpdir(), 'cbr-'));
const ORIGIN = join(TMP, 'origin.git'), WORK = join(TMP, 'work'), HOME = join(TMP, 'home');
writeFileSync(join(TMP, 'gitconfig'), '');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(TMP, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (...args: string[]) => execFileSync('git', args, { cwd: WORK, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (msg: string, files: Record<string, string> = {}) => {
  for (const [f, body] of Object.entries(files)) writeFileSync(join(WORK, f), body);
  git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg);
  return git('rev-parse', 'HEAD');
};
execFileSync('git', ['init', '-q', '--bare', ORIGIN], { env: gitEnv });
mkdirSync(WORK); git('init', '-q', '-b', 'main');
git('remote', 'add', 'origin', ORIGIN);
const MAIN = commit('main', {
  'ok.mjs': "console.log('ok');\n",
  'fail.mjs': "console.log('failing'); process.exitCode = 3;\n",
  'slow.mjs': "console.log('pid ' + process.pid); setTimeout(() => {}, 60000);\n",
  'env.mjs': "const n = ['CB_DATABASE_URL', 'DATABASE_URL', 'RUNNER_MARKER'].filter((k) => process.env[k]); console.log('CB=' + (n.join(',') || 'none'));\n",
  // 3 MB, no newline; masking lengthens each address, so only a cut applied last keeps the summary short
  'big.mjs': "process.stdout.write('a@b.co '.repeat(450000)); process.exitCode = 1;\n",
  'lock.txt': 'v1\n',
});
git('push', '-q', 'origin', 'main');
const PR_ONLY = commit('pr'); git('push', '-q', 'origin', 'HEAD:refs/pull/1/head');
const UNPUSHED = commit('never pushed');
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
  cleanup: { steps: [node('slow.mjs')], timeout: 2, finally: [node('-e', "require('fs').writeFileSync('done.txt','1')")] },
  pick: { params: { files: { pattern: '^ok\\.mjs$', max: 3 } }, steps: [node('{files}')], timeout: 60 },
  zero: { steps: [node('-e', "console.log('ℹ pass 0'); console.log('ℹ fail 0')")], timeout: 60 },
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
    env: { ...process.env, CB_RUNNER_CONFIG: config, CB_RUNNER_HOME: home, CB_DATABASE_URL: TEST_URL, RUNNER_MARKER: '1' },
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
  if (m) { pids.push(Number(m[1])); return Number(m[1]); }
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
  const msg = await sql`select summary from cb.events where kind = 'message' and data->>'to' = 'B1@mac' and summary like ${`job #${id} %`}`;
  assert.equal(msg.length, 1);
});

test('a failing job ends failed with its exit code', async () => {
  const j = await ended(await add('fail'));
  assert.equal(j.state, 'failed');
  assert.equal(j.exit_code, 3);
});

test('the job env is clean', async () => {
  const id = await add('env');
  assert.equal((await ended(id)).state, 'passed');
  assert.match(logOf(id), /^CB=none$/m);
});

test('a sha nobody pushed, or only on a pull-request ref, is refused', async () => {
  assert.equal((await ended(await add('ok', UNPUSHED))).summary, 'error: push it first');
  assert.equal((await ended(await add('ok', PR_ONLY))).summary, 'error: push it first');
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

test('bad parameters end the job before any git work', async () => {
  const id = await add('pick', MAIN, { files: ['ok.mjs', 'fail.mjs'] });
  const j = await ended(id);
  assert.equal(j.summary, 'error: bad parameter files: fail.mjs');
  assert.doesNotMatch(logOf(id), /git/);
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

  // another runner (own name, port, home; a recipe nobody queues) whose peers list is empty
  const port2 = await freePort();
  const cfg2 = join(TMP, 'runner-nopeers.json');
  writeFileSync(cfg2, JSON.stringify({ name: 'pc-nopeers', slots: 1, log: { host: '127.0.0.1', port: port2, peers: [] }, projects: { demo: project(ORIGIN, { idle: recipes.ok }) } }));
  const other = startRunner(cfg2, join(TMP, 'home2'));
  await up(other);
  const denied = await fetch(`http://127.0.0.1:${port2}/jobs/${id}/log`);
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /this machine may not read job logs/);
  killTree(other.child.pid);
  await other.exited;
});

test('a second runner refuses to start', async () => {
  const second = startRunner();
  assert.equal(await second.exited, 1);
  assert.match(second.out, /a runner is already running on this machine/);
});

test('a restarted runner ends its running job and runs the queue', async () => {
  const id = await add('slow');
  await pidOf(id);
  killTree(runner.child.pid);
  await runner.exited;
  const ok = await add('ok');
  runner = startRunner();
  await up(runner);
  const j = await ended(id);
  assert.equal(j.state, 'error');
  assert.equal(j.summary, 'error: runner restarted');
  const msg = await sql`select summary from cb.events where kind = 'message' and data->>'to' = 'B1@mac' and summary like ${`job #${id} %`}`;
  assert.match(msg[0]?.summary ?? '', /runner restarted/);
  assert.equal((await ended(ok)).state, 'passed');
});
