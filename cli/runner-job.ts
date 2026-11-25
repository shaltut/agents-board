// One runner job (#3600): re-check the row, bring the slot's clone to the sha, install when the lockfile changed, run
// the recipe's steps and finally steps, and build the board summary. The daemon (cli/runner.ts) claims and finishes.
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { checkParams, expand, jobCwd, jobEnv, type RunnerConfig } from './recipes.ts';
import { cut, logTail, mask, summarize } from './summary.ts';

const WIN = process.platform === 'win32';
const SHA = /^[0-9a-f]{7,40}$/;
const GIT_MS = 600_000, FINALLY_MS = 300_000, DOCKER_MS = 60_000, TAIL = 1_048_576;

export type JobRow = { id: number; project: unknown; repo?: unknown; recipe: unknown; sha: unknown; params: unknown };
export type Result = { state: 'passed' | 'failed' | 'error'; exit_code: number | null; summary: string };
type Ran = { code: number | null; out: string; timedOut: boolean; startFailed: boolean; stopped: boolean };
// a job's log fd, its slot's pid record (<home>/state/slot-<n>.pids: the commands running now, pid → program) and the
// `$ argv` lines written to its log; reset puts the slot clone's .git/config back
type Io = { fd: number; pids: string; nostart: string; live: Map<number, string>; headers: Set<string>; reset?: () => void };

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

// pid → command line, for the pids still running; null when they cannot be read. Windows: one CIM query
// ((Get-Process).CommandLine comes back empty on the PC). POSIX: /proc, else ps.
function commandLines(pids: string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  try {
    if (WIN) {
      const q = `Get-CimInstance Win32_Process -Filter "${pids.map((p) => `ProcessId=${p}`).join(' OR ')}" -ErrorAction Stop | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`;
      const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], { windowsHide: true, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const m of text.matchAll(/^(\d+)\t(.*)$/gm)) out.set(m[1]!, m[2]!.trim());
    } else {
      for (const p of pids) {
        try { out.set(p, readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').join(' ').trim()); } catch {
          try { out.set(p, execFileSync('ps', ['-o', 'args=', '-p', p], { encoding: 'utf8', timeout: 10_000 }).trim()); } catch {}
        }
      }
    }
  } catch { return null; }
  return out;
}

/** POSIX: whether a command line is the recorded program, as the first word or, behind a shebang (`node /x/pnpm i`), the second. */
export const rootMatches = (cmd: string, img: string) => {
  const [a = '', b = ''] = cmd.split(' ');
  return basename(a) === img || (['node', 'sh', 'bash', 'env'].includes(basename(a)) && basename(b) === img);
};

/** Kills what a runner that died left running: every pid recorded in <stateDir>/*.pids, then forgets the records. A pid
 *  may have been reused since, so a record is acted on only when written since the last boot and while the pid still
 *  runs that root: on Windows, a launcher whose argv holds the slot's .nostart path (every root there is node.exe, as
 *  are agent sessions and relays); on POSIX, the recorded program. Synchronous. */
export function reap(stateDir: string, say: (m: string) => void = () => {}): number {
  const boot = Date.now() - uptime() * 1000;
  const recs: { pid: string; img: string; mark: string }[] = [];
  let files: string[] = [];
  try { files = readdirSync(stateDir).filter((f) => f.endsWith('.pids')); } catch {}
  for (const f of files) {
    const file = join(stateDir, f);
    try {
      if (statSync(file).mtimeMs >= boot) {
        // a pid over uint32 (or 0) would make the CIM query below fail for every record
        for (const m of readFileSync(file, 'utf8').matchAll(/^(\d{1,10}) (.+)$/gm)) if (Number(m[1]) > 0 && Number(m[1]) <= 4294967295) recs.push({ pid: m[1]!, img: m[2]!.trim(), mark: file.replace(/\.pids$/, '.nostart').toLowerCase() });
      }
    } catch {}
    try { rmSync(file, { force: true }); } catch {}
  }
  if (!recs.length) return 0;
  const cmds = commandLines(recs.map((r) => r.pid));
  if (!cmds) {
    say(`could not read the command lines of ${recs.length} recorded process(es); left them running`);
    return 0;
  }
  let n = 0;
  for (const r of recs) {
    const cmd = cmds.get(r.pid);
    if (cmd === undefined || !(WIN ? cmd.toLowerCase().includes(r.mark) : rootMatches(cmd, r.img))) continue;
    try {
      if (WIN) execFileSync('taskkill', ['/pid', r.pid, '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
      else process.kill(-Number(r.pid), 'SIGKILL'); // its own process group (spawned detached)
      n++;
    } catch {}
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

// Every *.lock under a slot clone's .git (objects aside), files or folders. Links are removed, never followed: Node's
// recursive readdir would walk into a junction.
function dropLocks(d: string, skip: string) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.name.endsWith('.lock')) rmSync(f, { recursive: true, force: true });
    else if (e.isDirectory() && f !== skip) dropLocks(f, skip);
  }
}

const isLists = (v: unknown): v is Record<string, string[]> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'));

type Draft = { state: Result['state']; exit_code: number | null; text: string } | null; // null: cancelled
const err = (text: string): Draft => ({ state: 'error', exit_code: null, text });

/** Runs one claimed job. Returns its result, or null when it was cancelled (the board already holds its end). */
export async function runJob(j: JobRow, o: { cfg: RunnerConfig; home: string; slot: number; lane?: number; stop: AbortSignal }): Promise<Result | null> {
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
    try { io.reset?.(); } catch {}
  }
}

async function steps(j: JobRow, o: { cfg: RunnerConfig; home: string; slot: number; lane?: number; stop: AbortSignal }, io: Io, log: string): Promise<Draft> {
  const { cfg, home, slot, stop } = o;
  // 1. trust nothing in the row: sha shape, project, repo and recipe from this PC's own config, params a map of string
  // lists. A row without a repo (a board before #3703) is main.
  const proj = typeof j.project === 'string' && Object.hasOwn(cfg.projects, j.project) ? cfg.projects[j.project]! : undefined;
  const repo = j.repo ?? 'main';
  const p = proj && typeof repo === 'string' && Object.hasOwn(proj.repos, repo) ? { ...proj.repos[repo]!, base: proj.base } : undefined;
  // a repo name the board let through but this PC lacks is named (the shape of a runner.json name only: it reaches the requester)
  if (proj && !p && typeof repo === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(repo)) return err(`error: bad job row: no repo ${repo} for ${j.project} on this PC`);
  const recipe = p && typeof j.recipe === 'string' && Object.hasOwn(p.recipes, j.recipe) ? p.recipes[j.recipe]! : undefined;
  const params = j.params;
  if (typeof j.sha !== 'string' || !SHA.test(j.sha) || !p || !recipe || !isLists(params)) return err('error: bad job row');
  const bad = checkParams(recipe, params);
  if (bad) return err(bad);
  // a DB job runs in the lane the claim gave it (its own test stack and ports): without one it could share another's
  if (recipe.db && o.lane === undefined) return err('error: a DB job got no DB lane');

  // the summary reads the log from `from` on (the commands that matter), at most its last 1 MB, without the `$ argv`
  // lines: the commands never leave the PC
  const tail = (from: number) => {
    try {
      const text = logTail(log, Math.min(TAIL, Math.max(0, statSync(log).size - from)));
      return text.split('\n').filter((l) => !io.headers.has(l.replace(/\r$/, ''))).join('\n');
    } catch { return ''; }
  };
  const summary = (from: number) => summarize(tail(from)).text;

  // 2. the slot clone at the sha. Git and docker run with the job's base env (the user's profile, so git's
  // credentials, but never the runner's CB_* or database URL) and no prompts.
  // one clone per project, repo and slot: main keeps the one-repo name (<project>-<slot>), others <project>-<repo>-<slot>
  const stem = `${repo === 'main' ? j.project : `${j.project}-${repo}`}-${slot}`;
  const dir = join(p.base, stem);
  const lockState = join(home, 'state', `${stem}.lock`);
  const genv = jobEnv(process.env, cfg, { env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_NO_REPLACE_OBJECTS: '1' } });
  // Job code owns the clone's worktree and .git between our git calls: no hook (lefthook's included) or fsmonitor runs,
  // and .git/config goes back to the saved copy (no planted filter, credential helper, sshCommand, url rewrite,
  // include) before each job's first git call and after each job. The copy is saved at clone time and again each job,
  // right after the runner sets runner.json's git URL in it.
  const G = ['git', '-c', `core.hooksPath=${WIN ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false'];
  const git = (args: string[], capture = false) => run([...G, ...args], { cwd: dir, env: genv, io, ms: GIT_MS, stop, capture });
  const saved = join(home, 'state', `${stem}.gitconfig`);
  const gitDir = join(dir, '.git');
  io.reset = () => {
    // a .git a job swapped for a link is left alone (the next job starts the slot over): nothing outside the clone goes
    if (lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) {
      rmSync(join(gitDir, 'config'), { recursive: true, force: true }); // a planted link goes, not what it points at
      copyFileSync(saved, join(gitDir, 'config'));
      rmSync(join(gitDir, 'commondir'), { force: true }); // would point git at another config
      dropLocks(gitDir, join(gitDir, 'objects')); // a planted config.lock, index.lock, HEAD.lock or ref lock would fail the next git call
    }
    if (WIN) rmSync('\\\\?\\' + resolve(dir, 'NUL'), { recursive: true, force: true }); // core.hooksPath=NUL is relative: a job's NUL folder would break every git call
  };
  // A fetch that fails in an existing clone while origin answers (a job may have left garbage under .git, e.g. a non-ref
  // file in refs) starts the slot over once: a fresh clone, then the fetch again. rmSync removes links, never what they point at.
  for (let again = false; ; again = true) {
    if (again || !lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory() || !existsSync(saved)) { // missing, or a link: start over
      rmSync(dir, { recursive: true, force: true });
      rmSync(lockState, { force: true });
      rmSync(saved, { force: true });
      mkdirSync(p.base, { recursive: true });
      // --no-local: a local-path origin would otherwise hand over every object it holds, not only what branches reach;
      // --no-tags: branches only, never a tag-only commit
      const c = await run([...G, 'clone', '--no-checkout', '--no-local', '--no-tags', p.git, dir], { cwd: p.base, env: genv, io, ms: GIT_MS, stop, show: 'git clone --no-checkout --no-local --no-tags <origin>' });
      if (stop.aborted) return null;
      if (c.code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        return err('error: could not fetch from origin');
      }
      copyFileSync(join(gitDir, 'config'), saved);
      again = true; // a fresh clone gets no second start-over
    }
    io.reset();
    // runner.json's git URL wins over the one saved at clone time (a moved origin reaches existing slot clones); a clone
    // git no longer reads (a job emptied .git/HEAD) fails here like a failed fetch
    const u = await run([...G, 'config', 'remote.origin.url', p.git], { cwd: dir, env: genv, io, ms: GIT_MS, stop, show: 'git config remote.origin.url <origin>' });
    if (stop.aborted) return null;
    let fetched = false;
    if (u.code === 0) {
      copyFileSync(join(gitDir, 'config'), saved);
      const f = await git(['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
      if (stop.aborted) return null;
      fetched = f.code === 0;
    }
    if (fetched) break;
    if (again) return err('error: could not fetch from origin');
    // start over only when origin answers (the clone is what broke); an outside problem (network, credentials) keeps
    // the slot and its install. Asked outside the clone, which may be what broke. --exit-code: 2 = origin answered with
    // no HEAD (a bare origin's unborn default branch)
    const ls = await run([...G, 'ls-remote', '--exit-code', p.git, 'HEAD'], { cwd: p.base, env: genv, io, ms: GIT_MS, stop, capture: true, show: 'git ls-remote --exit-code <origin> HEAD' });
    if (stop.aborted) return null;
    if (ls.code !== 0 && ls.code !== 2) return err('error: could not fetch from origin');
  }
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
  // the clean keeps node_modules (the install), and with it every build cache inside: tsc's tsbuildinfo there describes a
  // dist the clean just wiped, so the next build would emit nothing (#3763). Drop node_modules/.cache beside each tracked
  // package.json, only when that node_modules really sits inside the slot: a link anywhere on its path (a job may plant
  // one pointing outside the slot) is skipped
  const pk = await git(['ls-files', '-z', '--', 'package.json', '*/package.json'], true);
  if (stop.aborted) return null;
  if (pk.code !== 0) throw new Error(`git ls-files exited ${pk.code}`);
  const root = realpathSync.native(dir) + sep;
  for (const f of pk.out.split('\0').filter(Boolean)) {
    const nm = join(dir, dirname(f), 'node_modules');
    let real: string;
    try { real = realpathSync.native(nm); } catch { continue; } // no install there
    if (real !== join(root, dirname(f), 'node_modules')) continue;
    rmSync(join(nm, '.cache'), { recursive: true, force: true, maxRetries: 3 });
  }

  // 3. install when the lockfile's blob differs from this slot's last install, when the slot has no install record, and
  // always when the blob cannot be read (a lockfile missing at the sha, a wrong lockfile path)
  const env = jobEnv(process.env, cfg, recipe, recipe.db ? o.lane : undefined);
  const lb = await git(['rev-parse', `${full}:${p.lockfile}`], true);
  const blob = lb.code === 0 ? lb.out.trim() : '';
  if (stop.aborted) return null;
  if (!blob || !existsSync(lockState) || blob !== readFileSync(lockState, 'utf8')) {
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

/** job_finish. A board that cannot be reached, or answers with anything but a refusal (too many connections, a
 *  restart: a connection, serialization, resource, operator or transaction-state SQLSTATE: classes 08 40 53 57 25), is retried every 30 s until the finish lands or the job is no longer this runner's
 *  running job ('gone': it ended on the board, e.g. cancelled just before). A refusal (a `raise`, P0001) gets one resend: the summary becomes a pointer to the log (and the
 *  exit code is dropped unless the refusal was the summary's `looks like`); a second refusal is logged and given up ('gave-up'), so
 *  the slot frees. Any other board error (a missing function, no permission) is logged and given up the same way. */
export async function finish(sql: any, runner: string, id: number, r: Result, say: (m: string) => void, wait = 30_000): Promise<'done' | 'gone' | 'gave-up'> {
  const withheld = `summary withheld: see cb job log ${id}`;
  let { exit_code, summary } = r;
  for (;;) {
    try {
      return (await sql`select cb.job_finish(${id}, ${runner}, ${r.state}, ${exit_code}, ${summary}) as ok`)[0].ok === true ? 'done' : 'gone';
    } catch (e: any) {
      if (e?.name === 'PostgresError' && e.code !== 'P0001' && !/^(08|40|53|57|25)/.test(e.code ?? '')) {
        say(`job #${id}: the board cannot take its end (${e.message}); giving up, it stays running until the next runner start`);
        return 'gave-up';
      }
      if (e?.name !== 'PostgresError' || e.code !== 'P0001') {
        say(`job #${id}: the board did not take its end (${e?.message ?? e}); retrying in ${wait / 1000} s`);
        await new Promise((ok) => setTimeout(ok, wait));
        continue;
      }
      if (summary === withheld) {
        say(`job #${id}: the board refused its end (${e.message}); giving up, it stays running until the next runner start`);
        return 'gave-up';
      }
      if (!/looks like/.test(e.message)) {
        say(`job #${id}: the board refused its end (${e.message}); sending it again without the summary`);
        exit_code = null;
      }
      summary = withheld;
    }
  }
}
