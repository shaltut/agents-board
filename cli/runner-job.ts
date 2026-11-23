// One runner job (#3600): re-check the row, bring the slot's clone to the sha, install when the lockfile changed, run
// the recipe's steps and finally steps, and build the board summary. The daemon (cli/runner.ts) claims and finishes.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { checkParams, expand, jobCwd, jobEnv, type RunnerConfig } from './recipes.ts';
import { cut, logTail, mask, summarize } from './summary.ts';

const WIN = process.platform === 'win32';
const SHA = /^[0-9a-f]{7,40}$/;
const GIT_MS = 600_000, FINALLY_MS = 300_000, DOCKER_MS = 60_000, TAIL = 1_048_576;

export type JobRow = { id: number; project: unknown; recipe: unknown; sha: unknown; params: unknown };
export type Result = { state: 'passed' | 'failed' | 'error'; exit_code: number | null; summary: string };
type Ran = { code: number | null; out: string; timedOut: boolean; startFailed: boolean; stopped: boolean };

/** Kills a process and everything it started. */
export function treeKill(pid: number | undefined) {
  if (!pid) return;
  if (WIN) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { process.kill(-pid, 'SIGKILL'); } catch {}
}

// One command, no shell, output appended to the job log (stdout captured instead when asked). Ends on exit, on its
// time cap or when `stop` fires; both kill the whole tree.
function run(argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; fd: number; ms: number; stop?: AbortSignal; capture?: boolean; show?: string }): Promise<Ran> {
  writeSync(o.fd, `$ ${o.show ?? argv.join(' ')}\n`);
  const r: Ran = { code: null, out: '', timedOut: false, startFailed: false, stopped: false };
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: o.cwd, env: o.env, shell: false, windowsHide: true, detached: !WIN,
        stdio: ['ignore', o.capture ? 'pipe' : o.fd, o.fd],
      });
    } catch { // a .cmd / .bat without a shell throws EINVAL here
      r.startFailed = true;
      return done(r);
    }
    let over = false;
    const timer = setTimeout(() => { r.timedOut = true; treeKill(child.pid); }, o.ms);
    const onStop = () => { r.stopped = true; treeKill(child.pid); };
    o.stop?.addEventListener('abort', onStop, { once: true });
    const end = () => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      o.stop?.removeEventListener('abort', onStop);
      done(r);
    };
    child.stdout?.on('data', (b) => { r.out += b; });
    child.on('error', () => { r.startFailed = true; end(); }); // ENOENT: missing program
    child.on('close', (code) => { r.code = code; end(); });
    if (o.stop?.aborted) onStop();
  });
}

const isLists = (v: unknown): v is Record<string, string[]> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'));

type Draft = { state: Result['state']; exit_code: number | null; text: string } | null; // null: cancelled
const err = (text: string): Draft => ({ state: 'error', exit_code: null, text });

/** Runs one claimed job. Returns its result, or null when it was cancelled (the board already holds its end). */
export async function runJob(j: JobRow, o: { cfg: RunnerConfig; home: string; slot: number; stop: AbortSignal }): Promise<Result | null> {
  const log = join(o.home, 'logs', `${j.id}.log`);
  const fd = openSync(log, 'a');
  try {
    const d = await steps(j, o, fd, log);
    // mask can lengthen the text and the board refuses over 1000: cut last
    return d && { state: d.state, exit_code: d.exit_code, summary: cut(mask(d.text)) };
  } catch (e: any) {
    try { writeSync(fd, `runner: ${e?.message ?? e}\n`); } catch {}
    return { state: 'error', exit_code: null, summary: `error: runner fault: see cb job log ${j.id}` };
  } finally {
    closeSync(fd);
  }
}

async function steps(j: JobRow, o: { cfg: RunnerConfig; home: string; slot: number; stop: AbortSignal }, fd: number, log: string): Promise<Draft> {
  const { cfg, home, slot, stop } = o;
  // 1. trust nothing in the row: sha shape, project and recipe from this PC's own config, params a map of string lists
  const p = typeof j.project === 'string' && Object.hasOwn(cfg.projects, j.project) ? cfg.projects[j.project]! : undefined;
  const recipe = p && typeof j.recipe === 'string' && Object.hasOwn(p.recipes, j.recipe) ? p.recipes[j.recipe]! : undefined;
  const params = j.params;
  if (typeof j.sha !== 'string' || !SHA.test(j.sha) || !p || !recipe || !isLists(params)) return err('error: bad job row');
  const bad = checkParams(recipe, params);
  if (bad) return err(bad);

  // the summary reads the log from `from` on (the commands that matter), at most its last 1 MB
  const tail = (from: number) => {
    try { return logTail(log, Math.min(TAIL, Math.max(0, statSync(log).size - from))); } catch { return ''; }
  };
  const summary = (from: number) => summarize(tail(from)).text;

  // 2. the slot clone at the sha. Git runs with the runner's own env (its credentials); recipe commands never do.
  const dir = join(p.base, `${j.project}-${slot}`);
  const lockState = join(home, 'state', `${j.project}-${slot}.lock`);
  const genv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const git = (args: string[], capture = false) => run(['git', ...args], { cwd: dir, env: genv, fd, ms: GIT_MS, stop, capture });
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(lockState, { force: true });
    mkdirSync(p.base, { recursive: true });
    // --no-local: a local-path origin would otherwise hand over every object it holds, not only what branches reach
    const c = await run(['git', 'clone', '--no-checkout', '--no-local', p.git, dir], { cwd: p.base, env: genv, fd, ms: GIT_MS, stop, show: 'git clone --no-checkout --no-local <origin>' });
    if (stop.aborted) return null;
    if (c.code !== 0) {
      rmSync(dir, { recursive: true, force: true });
      return err('error: could not fetch from origin');
    }
  }
  const f = await git(['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  if (stop.aborted) return null;
  if (f.code !== 0) return err('error: could not fetch from origin');
  const rv = await git(['rev-parse', '--verify', '--quiet', `${j.sha}^{commit}`], true);
  if (stop.aborted) return null;
  if (rv.code !== 0) return err('error: push it first');
  const full = rv.out.trim();
  const br = await git(['branch', '-r', '--contains', full], true);
  if (stop.aborted) return null;
  if (br.code !== 0 || !br.out.trim()) return err('error: not on a branch of origin');
  for (const args of [['checkout', '--force', '--detach', full], ['clean', '-ffdx', '-e', 'node_modules']]) {
    const r = await git(args);
    if (stop.aborted) return null;
    if (r.code !== 0) throw new Error(`git ${args[0]} exited ${r.code}`);
  }

  // 3. install when the lockfile's blob differs from this slot's last install (a lockfile missing at the sha reads as '')
  const env = jobEnv(process.env, cfg, recipe);
  const lb = await git(['rev-parse', `${full}:${p.lockfile}`], true);
  const blob = lb.code === 0 ? lb.out.trim() : '';
  if (stop.aborted) return null;
  if (blob !== (existsSync(lockState) ? readFileSync(lockState, 'utf8') : '')) {
    rmSync(lockState, { force: true }); // a half-done install must not count as the old one
    const from = fstatSync(fd).size;
    const r = await run(p.install, { cwd: dir, env, fd, ms: p.installTimeout * 1000, stop });
    if (r.stopped) return null;
    if (r.startFailed) return err(`error: could not start ${p.install[0]}`);
    if (r.timedOut) return err(`error: timed out after ${Math.ceil(p.installTimeout / 60)} min`);
    if (r.code !== 0) return { state: 'failed', exit_code: r.code, text: summary(from) };
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(lockState, blob);
  }

  // 4. DB recipes need Docker
  if (recipe.db) {
    const d = await run(['docker', 'info'], { cwd: dir, env: genv, fd, ms: DOCKER_MS, stop });
    if (stop.aborted) return null;
    if (d.startFailed || d.code !== 0) return err('error: Docker is not running');
  }

  // 5. steps under one deadline; 6. finally steps always run once steps have started
  const cwd = jobCwd(dir, recipe, params);
  const from = fstatSync(fd).size;
  const deadline = Date.now() + recipe.timeout * 1000;
  let out: Draft | undefined;
  for (const argv of recipe.steps) {
    const a = expand(argv, params);
    const r = await run(a, { cwd, env, fd, ms: Math.max(0, deadline - Date.now()), stop });
    if (r.stopped) { out = null; break; }
    if (r.startFailed) { out = err(`error: could not start ${a[0]}`); break; }
    if (r.timedOut) { out = err(`error: timed out after ${Math.ceil(recipe.timeout / 60)} min`); break; }
    if (r.code !== 0) { out = { state: 'failed', exit_code: r.code, text: summary(from) }; break; }
  }
  if (out === undefined) {
    const s = summarize(tail(from));
    out = s.ran === 0 ? { state: 'failed', exit_code: 0, text: `no tests ran: ${s.text}` } : { state: 'passed', exit_code: 0, text: s.text };
  }
  for (const argv of recipe.finally) await run(expand(argv, params), { cwd, env, fd, ms: FINALLY_MS });
  return stop.aborted ? null : out;
}

/** job_finish. A summary the board refuses (`looks like`) is sent again as a pointer to the log; a board that cannot be
 *  reached is retried every 30 s until the finish lands or the job is no longer this runner's running job (false). */
export async function finish(sql: any, runner: string, id: number, r: Result, say: (m: string) => void): Promise<boolean> {
  const withheld = `summary withheld: see cb job log ${id}`;
  let summary = r.summary;
  for (;;) {
    try {
      return (await sql`select cb.job_finish(${id}, ${runner}, ${r.state}, ${r.exit_code}, ${summary}) as ok`)[0].ok === true;
    } catch (e: any) {
      if (/looks like/.test(e?.message ?? '') && summary !== withheld) { summary = withheld; continue; }
      say(`job #${id}: could not finish on the board (${e?.message ?? e}); retrying in 30 s`);
      await new Promise((ok) => setTimeout(ok, 30_000));
    }
  }
}
