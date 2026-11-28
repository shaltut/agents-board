// Starts the private Postgres 16 cluster in .pgdata if it isn't running; creates it if missing.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PGDATA = join(ROOT, '.pgdata');
const BIN = process.env.CB_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin';
export const pgCtl = join(BIN, 'pg_ctl.exe');

/** #4482: spawnSync with a deadline: a stalled child (initdb, pg_ctl, the port probe) throws in words instead of
 *  leaving a test run silent. A timed-out child throws, never returns: its null status read
 *  through `.status === 0` would be "not running" and start a second cluster. Windows ends only the direct child: a
 *  postmaster that pg_ctl started keeps running (node db/setup.ts --test --stop stops a worktree's). */
export function spawnWithin(cmd: string, args: string[], opts: SpawnSyncOptions, ms: number, what: string) {
  const r = spawnSync(cmd, args, { windowsHide: true, ...opts, timeout: ms }); // #4491: no console flash from a caller with none
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`${what} did not finish within ${ms / 1000} s`);
  return r;
}
// pg_ctl -w gives up by itself after 60 s (PGCTLTIMEOUT); initdb syncs every file it writes, slow on a busy disk
const QUICK = 30_000, START = 120_000, INITDB = 180_000;
const running = (dir: string) => spawnWithin(pgCtl, ['-D', dir, 'status'], { stdio: 'ignore' }, QUICK, `pg_ctl status in ${dir}`).status === 0;

/** The private cluster is this repo's Windows Postgres: a board on Linux (the VPS's container) or pointed at another
 *  machine's database (CB_DATABASE_URL) has nothing to start. */
export function ownsPg(url: string): boolean {
  const u = new URL(url);
  return process.platform === 'win32' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname) && (u.port || '5432') === '5434';
}

/** adopt: a server already answering on the port counts as ours (the main checkout's dev cluster). A worktree's test
 *  cluster passes false: it must be its own .pgdata, never whichever cluster happens to serve the port (#4413). */
export function ensurePg(dir = PGDATA, port = 5434, adopt = true): void {
  if (adopt && answers(port)) return;
  if (!existsSync(join(dir, 'PG_VERSION'))) {
    const i = spawnWithin(join(BIN, 'initdb.exe'), ['-D', dir, '-U', 'cb', '--auth=trust', '-E', 'UTF8'], { stdio: 'pipe', encoding: 'utf8' },
      INITDB, `initdb in ${dir} (delete that folder before the next try)`);
    // #4401: an initdb that never started has no output: say why, and where it was looked for
    if (i.status !== 0) {
      const hint = (i.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? ` (no initdb.exe in ${BIN}: set CB_PG_BIN to PostgreSQL's bin folder)` : '';
      const why = i.error ? `${i.error.message}${hint}` : (i.stderr || i.stdout);
      throw new Error(`could not create Postgres cluster in ${dir}: ${why}`);
    }
  }
  if (running(dir)) return;
  // stdio 'ignore': the postmaster inherits pg_ctl's handles, so a pipe here never closes and spawnSync hangs.
  const log = join(dir, 'server.log');
  // A worktree's cluster listens on 127.0.0.1 only (the test URL's host): with the default 'localhost', a port another
  // program held on 127.0.0.1 still "started" on ::1, and the tests reached that program (#4413).
  const opts = adopt ? `-p ${port}` : `-p ${port} -c listen_addresses=127.0.0.1`;
  // #4491: the 5434 dev cluster too (setup, seed, the server, cb): a piped command that started it held its pipe
  const r = startInheritingNothing(['-D', dir, '-o', opts, '-l', log, '-w', 'start'], `pg_ctl start in ${dir} (its log: ${log})`);
  // #4491 M2: PowerShell that did not run is said as such, never as a Postgres failure with nothing in its log
  if (r.error) throw new Error(`could not start Postgres in ${dir}: ${POWERSHELL} did not run (${r.error.message})`);
  // judged by pg_ctl status: PowerShell's exit code for a quickly ended process can read 0
  if (r.status !== 0 || !running(dir)) throw new Error(`could not start Postgres in ${dir}; see ${log}`);
}

// #4491 M2: by full path, never from PATH (a stripped env has none): Windows PowerShell 5.1 is in every Windows 10/11
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** #4482: every process on the way to the postmaster (node, pg_ctl, cmd) is created with handle inheritance on, so the
 *  postmaster also holds every inheritable handle above it. Run from a Git Bash pipeline (`node --test ... | tail`) that
 *  includes the pipe the shell reads: the run that started a worktree's test cluster never returned, its tests long
 *  done, until the cluster stopped; a rerun (cluster already up) passed. Start-Process (ShellExecute) creates pg_ctl
 *  with no inherited handle. Every start goes this way (#4491): the worktree test clusters and the 5434 dev cluster. */
function startInheritingNothing(args: string[], what: string) {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const line = args.map((a) => `"${a}"`).join(' ');
  // $p.Handle: read before the exit, so ExitCode is kept; never -Wait, which waits for the postmaster too
  const ps = `$p = Start-Process -FilePath ${q(pgCtl)} -ArgumentList ${q(line)} -WindowStyle Hidden -PassThru; $null = $p.Handle; $p.WaitForExit(); exit $p.ExitCode`;
  return spawnWithin(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
    { stdio: 'ignore' }, START, what);
}

const answers = (port: number) =>
  spawnWithin(join(BIN, 'pg_isready.exe'), ['-h', '127.0.0.1', '-p', String(port)], { stdio: 'ignore' }, QUICK, `pg_isready on port ${port}`).status === 0;

/** #4413: a Windows worktree tests against its own cluster (its .pgdata, its own port). All worktrees used to share
 *  127.0.0.1:5434, served by whichever worktree's cluster started first: eight parallel runs ran out of its 100
 *  connections ("too many clients") and failed when that cluster was in crash recovery. The main checkout, and every
 *  other platform (Postgres started by hand), keep 5434.
 *  #4756: so does a PC runner job's checkout (CB_RUNNER_JOB=1, cli/recipes.ts jobEnv). A slot is a clone, not a
 *  worktree: on 5434 its --test started a cluster that --test --stop never stopped, and the next job's git clean failed
 *  on the open server.log; other slots, and the main checkout, shared that port. */
export function ownTestPg(root = ROOT, platform = process.platform, env = process.env): boolean {
  return platform === 'win32' && (env.CB_RUNNER_JOB === '1' || (statSync(join(root, '.git'), { throwIfNoEntry: false })?.isFile() ?? false));
}

/** Where a worktree's port search starts: FNV-1a of its path, so the same worktree gets the same port each run. */
export function testPortStart(root: string): number {
  let h = 2166136261;
  for (const c of root.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return 15435 + (h % 1000);
}

// Any program that accepts a TCP connection on 127.0.0.1 holds the port (pg_isready reports "no response" for a
// non-Postgres listener exactly as for an empty port); only a refused connection is free. A refused port must also bind:
// one in a Windows excluded range refuses connections but cannot be listened on. One child checks the window.
const FIRST_FREE = `const net = require('node:net'); const [s, n] = process.argv.slice(1).map(Number);
const binds = (p) => new Promise((r) => { const v = net.createServer(); v.once('error', () => r(false)); v.listen(p, '127.0.0.1', () => v.close(() => r(true))); });
(async () => { for (let p = s; p < s + n; p++) {
  const taken = await new Promise((r) => { const c = net.connect({ host: '127.0.0.1', port: p }); c.setTimeout(3000);
    c.once('connect', () => { c.destroy(); r(true); }); c.once('timeout', () => { c.destroy(); r(true); });
    c.once('error', (e) => r(e.code !== 'ECONNREFUSED')); });
  if (!taken && await binds(p)) { console.log(p); return; } } })();`;

/** The port a test run on this checkout uses: 5434; for a worktree, the port its running cluster listens on, else
 *  CB_TEST_PG_PORT (test/helpers.ts sets it, so its db/setup.ts --test child picks the same port), else the first free
 *  one from testPortStart (15435-16453: below Windows' excluded dynamic ranges). */
export function testPgPort(root = ROOT, platform = process.platform, env = process.env): number {
  if (!ownTestPg(root, platform, env)) return 5434;
  const dir = join(root, '.pgdata');
  if (running(dir)) {
    const port = Number(readFileSync(join(dir, 'postmaster.pid'), 'utf8').split(/\r?\n/)[3]);
    if (port > 0) return port;
  }
  if (root === ROOT && Number(process.env.CB_TEST_PG_PORT) > 0) return Number(process.env.CB_TEST_PG_PORT);
  const start = testPortStart(root);
  // 20 ports at up to 3 s each
  const port = Number(spawnWithin(process.execPath, ['-e', FIRST_FREE, String(start), '20'], { encoding: 'utf8' }, START, `the free-port search from ${start}`).stdout);
  if (port > 0) return port;
  throw new Error(`no free port for this worktree's test Postgres in ${start}-${start + 19}: other programs hold all of them`);
}

/** The test database's URL: CB_TEST_DB on this checkout's test cluster. */
export function testDbUrl(db = process.env.CB_TEST_DB ?? 'claude_board_test', root = ROOT): string {
  return `postgres://cb@127.0.0.1:${testPgPort(root)}/${db}`;
}

/** Starts the test cluster: a worktree's own (never another's), else the board's as before (ownsPg). */
export function ensureTestPg(url: string, root = ROOT): void {
  if (ownTestPg(root)) ensurePg(join(root, '.pgdata'), Number(new URL(url).port), false);
  else if (ownsPg(url)) ensurePg();
}

// #4922: when a server process dies, the postmaster logs this, ends every connection and recovers; whatever runs
// meanwhile fails with "the database system is in recovery mode". Only the server's own LOG line counts.
const CRASHED = /\] LOG:\s+terminating any other active server processes\s*$/;
const WENT = /\] LOG:\s+.*\(PID (\d+)\) (?:exited with exit code|was terminated)/;
const OWN_ERROR = /\] (?:PANIC|FATAL):/;

/** One line per crash in a cluster's log (the first three): the process that went and its own last PANIC or FATAL. */
export function databaseLost(log: string): string[] {
  const lines = log.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < 3; i++) {
    if (!CRASHED.test(lines[i]!)) continue;
    // the line naming the process is just above, at most a DETAIL line between them
    let j = i - 1;
    while (j > i - 3 && j >= 0 && !WENT.test(lines[j]!)) j--;
    const pid = WENT.exec(lines[j] ?? '')?.[1];
    const own = pid && lines.slice(Math.max(0, j - 200), j).findLast((l) => l.includes(`[${pid}] `) && OWN_ERROR.test(l));
    const cause = pid ? `${lines[j]!.slice(0, 300)}; ${own ? `its own last error: ${own.slice(0, 300)}` : 'it logged no error of its own'}`
      : (lines[i - 1] ?? '').slice(0, 300);
    out.push(`database lost: the test Postgres crashed and restarted during this run, so failures from then on may not be real. ${cause}`);
  }
  return out;
}

/** Stops a worktree's test cluster: run it before removing the worktree (a running Postgres holds the folder). The
 *  message starts with what the cluster's log says was lost, read before the stop (which can fail after a crash) and
 *  before the runner's next job deletes .pgdata. */
export function stopTestPg(root = ROOT): { ok: boolean; message: string } {
  if (!ownTestPg(root)) return { ok: true, message: 'no test cluster of its own here (not a Windows worktree or runner job)' };
  const dir = join(root, '.pgdata');
  const log = join(dir, 'server.log');
  const lost = existsSync(log) ? databaseLost(readFileSync(log, 'utf8')) : [];
  const say = (m: string) => [...lost, m].join('\n');
  if (!running(dir)) return { ok: true, message: say(`no test cluster running in ${dir}`) };
  const r = spawnWithin(pgCtl, ['-D', dir, 'stop', '-w'], { encoding: 'utf8' }, START, `pg_ctl stop in ${dir}`);
  return { ok: r.status === 0, message: say((r.stdout || r.stderr || r.error?.message || '').trim()) };
}
