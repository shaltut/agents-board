// One runner job (#3600): re-check the row, bring the slot's clone to the sha, install when the lockfile changed, run
// the recipe's steps and finally steps, and build the board summary. The daemon (cli/runner.ts) claims and finishes.
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { checkParams, expand, jobCwd, jobEnv, type RunnerConfig } from './recipes.ts';
import { cut, logTail, mask, summarize } from './summary.ts';

const WIN = process.platform === 'win32';
const SHA = /^[0-9a-f]{7,40}$/;
const GIT_MS = 600_000, FINALLY_MS = 300_000, DOCKER_MS = 60_000, TAIL = 1_048_576;

export type JobRow = { id: number; project: unknown; recipe: unknown; sha: unknown; params: unknown };
export type Result = { state: 'passed' | 'failed' | 'error'; exit_code: number | null; summary: string };
type Ran = { code: number | null; out: string; timedOut: boolean; startFailed: boolean; stopped: boolean };
// a job's log fd, its slot's pid record (<home>/state/slot-<n>.pids: the commands running now, pid → program) and the
// `$ argv` lines written to its log
type Io = { fd: number; pids: string; nostart: string; live: Map<number, string>; headers: Set<string> };

// The record holds only live roots: rewritten on every spawn and exit, gone when none runs (one job per slot).
function record(io: Io) {
  try {
    if (io.live.size) writeFileSync(io.pids, [...io.live].map(([pid, img]) => `${pid} ${img}\n`).join(''));
    else rmSync(io.pids, { force: true });
  } catch {}
}

/** Kills a process and everything it started. */
export function treeKill(pid: number | undefined) {
  if (!pid) return;
  if (WIN) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { process.kill(-pid, 'SIGKILL'); } catch {}
}

const image = (cmd: string) => { const b = basename(cmd); return WIN && !extname(b) ? `${b}.exe` : b; };

/** Kills what a runner that died left running: every pid recorded in <stateDir>/*.pids, then forgets the records.
 *  On Windows only while that pid still runs the recorded program, so a reused pid is left alone. Synchronous. */
export function reap(stateDir: string): number {
  let n = 0;
  let files: string[] = [];
  try { files = readdirSync(stateDir).filter((f) => f.endsWith('.pids')); } catch {}
  for (const f of files) {
    const file = join(stateDir, f);
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch {}
    for (const line of text.split('\n')) {
      const m = /^(\d+) (.+)$/.exec(line.trim());
      if (!m) continue;
      try {
        if (WIN) {
          const row = execFileSync('tasklist', ['/FI', `PID eq ${m[1]}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
          if (row.split(',')[0]!.replaceAll('"', '').trim().toLowerCase() !== m[2]!.toLowerCase()) continue;
          execFileSync('taskkill', ['/pid', m[1]!, '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
        } else {
          process.kill(-Number(m[1]), 'SIGKILL'); // its own process group (spawned detached)
        }
        n++;
      } catch {}
    }
    try { rmSync(file, { force: true }); } catch {}
  }
  return n;
}

// A `$ argv` line, always on a line of its own (the last command may have ended without a newline).
function header(io: Io, text: string) {
  const size = fstatSync(io.fd).size;
  const last = Buffer.alloc(1);
  if (size && readSync(io.fd, last, 0, 1, size - 1) === 1 && last[0] !== 10) writeSync(io.fd, '\n');
  const line = `$ ${text}`;
  io.headers.add(line);
  writeSync(io.fd, `${line}\n`);
}

// Windows launcher, `node -e LAUNCH -- <nostart file> <argv...>`: starts the command without a shell, hidden, with the
// launcher's handles, forwards its exit code, and marks a command that cannot start (ENOENT, EINVAL for a .cmd) by
// creating the nostart file (an exit code cannot say it: a real one may be anything).
const LAUNCH = "const{spawn}=require('child_process'),fs=require('fs');const[mark,cmd,...args]=process.argv.slice(1);"
  + "const no=()=>{fs.writeFileSync(mark,'');process.exit(1)};let c;"
  + "try{c=spawn(cmd,args,{stdio:'inherit',windowsHide:true})}catch{no()}"
  + "c.on('error',no);c.on('exit',(code)=>process.exit(code??1))";

// One command, no shell, output appended to the job log (stdout captured instead when asked). Ends on exit, on its
// time cap or when `stop` fires; both kill the whole tree. The recorded root must outlive a runner crash, so the next
// runner's reap can walk its live tree. POSIX: the command itself, detached (its own process group). Windows: a
// non-detached child sits in libuv's kill-on-close job and dies with the runner, while what it started through a
// non-libuv program (cmd, the pnpm shim, git, docker) lives on under a dead parent no tree kill reaches; a detached
// command has no console, so such grandchildren get a console of their own and their output never reaches the log.
// So Windows runs a detached launcher (the root) that starts the command non-detached and hidden.
function run(argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; io: Io; ms: number; stop?: AbortSignal; capture?: boolean; show?: string }): Promise<Ran> {
  header(o.io, o.show ?? argv.join(' '));
  const r: Ran = { code: null, out: '', timedOut: false, startFailed: false, stopped: false };
  const [file, args] = WIN ? [process.execPath, ['-e', LAUNCH, '--', o.io.nostart, ...argv]] : [argv[0]!, argv.slice(1)];
  if (WIN) rmSync(o.io.nostart, { force: true });
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: o.cwd, env: o.env, shell: false, windowsHide: true, detached: true,
        stdio: ['ignore', o.capture ? 'pipe' : o.io.fd, o.io.fd],
      });
    } catch { // a .cmd / .bat without a shell throws EINVAL here (POSIX: never; Windows: inside the launcher)
      r.startFailed = true;
      return done(r);
    }
    // the record a restarted runner kills from, should this runner die first
    const pid = child.pid;
    if (pid) { o.io.live.set(pid, image(file)); record(o.io); }
    let over = false;
    const timer = setTimeout(() => { r.timedOut = true; treeKill(child.pid); }, o.ms);
    const onStop = () => { r.stopped = true; treeKill(child.pid); };
    o.stop?.addEventListener('abort', onStop, { once: true });
    const end = () => {
      if (over) return;
      over = true;
      if (pid && o.io.live.delete(pid)) record(o.io);
      clearTimeout(timer);
      o.stop?.removeEventListener('abort', onStop);
      done(r);
    };
    child.stdout?.on('data', (b) => { r.out += b; });
    child.on('error', () => { r.startFailed = true; end(); }); // ENOENT: missing program
    child.on('close', (code) => {
      if (WIN && existsSync(o.io.nostart)) { r.startFailed = true; rmSync(o.io.nostart, { force: true }); }
      r.code = code === null ? null : code | 0; // | 0: a Windows crash code (0xC0000409) fits the board's int
      end();
    });
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
  const io: Io = { fd: -1, pids: join(o.home, 'state', `slot-${o.slot}.pids`), nostart: join(o.home, 'state', `slot-${o.slot}.nostart`), live: new Map(), headers: new Set() };
  try {
    mkdirSync(join(o.home, 'logs'), { recursive: true });
    mkdirSync(join(o.home, 'state'), { recursive: true });
    io.fd = openSync(log, 'a+');
    const d = await steps(j, o, io, log);
    // mask can lengthen the text and the board refuses over 1000: cut last
    return d && { state: d.state, exit_code: d.exit_code, summary: cut(mask(d.text.replaceAll('\0', ''))) }; // Postgres text refuses NUL
  } catch (e: any) {
    if (io.fd >= 0) try { writeSync(io.fd, `runner: ${e?.message ?? e}\n`); } catch {}
    return { state: 'error', exit_code: null, summary: `error: runner fault: see cb job log ${j.id}` };
  } finally {
    if (io.fd >= 0) try { closeSync(io.fd); } catch {}
    try { rmSync(io.pids, { force: true }); } catch {}
  }
}

async function steps(j: JobRow, o: { cfg: RunnerConfig; home: string; slot: number; stop: AbortSignal }, io: Io, log: string): Promise<Draft> {
  const { cfg, home, slot, stop } = o;
  // 1. trust nothing in the row: sha shape, project and recipe from this PC's own config, params a map of string lists
  const p = typeof j.project === 'string' && Object.hasOwn(cfg.projects, j.project) ? cfg.projects[j.project]! : undefined;
  const recipe = p && typeof j.recipe === 'string' && Object.hasOwn(p.recipes, j.recipe) ? p.recipes[j.recipe]! : undefined;
  const params = j.params;
  if (typeof j.sha !== 'string' || !SHA.test(j.sha) || !p || !recipe || !isLists(params)) return err('error: bad job row');
  const bad = checkParams(recipe, params);
  if (bad) return err(bad);

  // the summary reads the log from `from` on (the commands that matter), at most its last 1 MB, without the `$ argv`
  // lines: the commands never leave the PC
  const tail = (from: number) => {
    try {
      const text = logTail(log, Math.min(TAIL, Math.max(0, statSync(log).size - from)));
      return text.split('\n').filter((l) => !io.headers.has(l.replace(/\r$/, ''))).join('\n');
    } catch { return ''; }
  };
  const summary = (from: number) => summarize(tail(from)).text;

  // 2. the slot clone at the sha. Git runs with the runner's own env (its credentials); recipe commands never do.
  const dir = join(p.base, `${j.project}-${slot}`);
  const lockState = join(home, 'state', `${j.project}-${slot}.lock`);
  const genv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const git = (args: string[], capture = false) => run(['git', ...args], { cwd: dir, env: genv, io, ms: GIT_MS, stop, capture });
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(lockState, { force: true });
    mkdirSync(p.base, { recursive: true });
    // --no-local: a local-path origin would otherwise hand over every object it holds, not only what branches reach;
    // --no-tags: branches only, never a tag-only commit
    const c = await run(['git', 'clone', '--no-checkout', '--no-local', '--no-tags', p.git, dir], { cwd: p.base, env: genv, io, ms: GIT_MS, stop, show: 'git clone --no-checkout --no-local --no-tags <origin>' });
    if (stop.aborted) return null;
    if (c.code !== 0) {
      rmSync(dir, { recursive: true, force: true });
      return err('error: could not fetch from origin');
    }
  }
  const f = await git(['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
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
    const from = fstatSync(io.fd).size;
    const r = await run(p.install, { cwd: dir, env, io, ms: p.installTimeout * 1000, stop });
    if (r.stopped) return null;
    if (r.startFailed) return err(`error: could not start ${p.install[0]}`);
    if (r.timedOut) return err(`error: timed out after ${Math.ceil(p.installTimeout / 60)} min`);
    if (r.code !== 0) return { state: 'failed', exit_code: r.code, text: summary(from) };
    writeFileSync(lockState, blob);
  }

  // 4. DB recipes need Docker
  if (recipe.db) {
    const d = await run(['docker', 'info'], { cwd: dir, env: genv, io, ms: DOCKER_MS, stop });
    if (stop.aborted) return null;
    if (d.startFailed || d.code !== 0) return err('error: Docker is not running');
  }

  // 5. steps under one deadline; 6. finally steps always run once steps have started, even after a throw
  const cwd = jobCwd(dir, recipe, params);
  const from = fstatSync(io.fd).size;
  const deadline = Date.now() + recipe.timeout * 1000;
  let out: Draft | undefined;
  try {
    for (const argv of recipe.steps) {
      const a = expand(argv, params);
      const r = await run(a, { cwd, env, io, ms: Math.max(0, deadline - Date.now()), stop });
      if (r.stopped) { out = null; break; }
      if (r.startFailed) { out = err(`error: could not start ${a[0]}`); break; }
      if (r.timedOut) { out = err(`error: timed out after ${Math.ceil(recipe.timeout / 60)} min`); break; }
      if (r.code !== 0) { out = { state: 'failed', exit_code: r.code, text: summary(from) }; break; }
    }
    if (out === undefined) {
      const s = summarize(tail(from));
      out = s.ran === 0 ? { state: 'failed', exit_code: 0, text: `no tests ran: ${s.text}` } : { state: 'passed', exit_code: 0, text: s.text };
    }
  } finally {
    for (const argv of recipe.finally) {
      try { await run(expand(argv, params), { cwd, env, io, ms: FINALLY_MS }); } catch {}
    }
  }
  return stop.aborted ? null : out;
}

/** job_finish. A board that cannot be reached is retried every 30 s until the finish lands or the job is no longer this
 *  runner's running job (false). A board that answers with a refusal gets one resend: the summary becomes a pointer to
 *  the log (and the exit code is dropped unless the refusal was the summary's `looks like`); a second refusal is logged
 *  and given up, so the slot frees. */
export async function finish(sql: any, runner: string, id: number, r: Result, say: (m: string) => void): Promise<boolean> {
  const withheld = `summary withheld: see cb job log ${id}`;
  let { exit_code, summary } = r;
  for (;;) {
    try {
      return (await sql`select cb.job_finish(${id}, ${runner}, ${r.state}, ${exit_code}, ${summary}) as ok`)[0].ok === true;
    } catch (e: any) {
      if (e?.name !== 'PostgresError') {
        say(`job #${id}: could not reach the board (${e?.message ?? e}); retrying in 30 s`);
        await new Promise((ok) => setTimeout(ok, 30_000));
        continue;
      }
      if (summary === withheld) {
        say(`job #${id}: the board refused its end (${e.message}); giving up, it stays running until the next runner start`);
        return false;
      }
      if (!/looks like/.test(e.message)) {
        say(`job #${id}: the board refused its end (${e.message}); sending it again without the summary`);
        exit_code = null;
      }
      summary = withheld;
    }
  }
}
