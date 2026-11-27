// Starts the private Postgres 16 cluster in .pgdata if it isn't running; creates it if missing.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PGDATA = join(ROOT, '.pgdata');
const BIN = process.env.CB_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin';
const pgCtl = join(BIN, 'pg_ctl.exe');

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
    const i = spawnSync(join(BIN, 'initdb.exe'), ['-D', dir, '-U', 'cb', '--auth=trust', '-E', 'UTF8'], { stdio: 'pipe', encoding: 'utf8' });
    // #4401: an initdb that never started has no output: say why, and where it was looked for
    if (i.status !== 0) {
      const hint = (i.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? ` (no initdb.exe in ${BIN}: set CB_PG_BIN to PostgreSQL's bin folder)` : '';
      const why = i.error ? `${i.error.message}${hint}` : (i.stderr || i.stdout);
      throw new Error(`could not create Postgres cluster in ${dir}: ${why}`);
    }
  }
  if (spawnSync(pgCtl, ['-D', dir, 'status'], { stdio: 'ignore' }).status === 0) return;
  // stdio 'ignore': the postmaster inherits pg_ctl's handles, so a pipe here never closes and spawnSync hangs.
  const log = join(dir, 'server.log');
  const r = spawnSync(pgCtl, ['-D', dir, '-o', `-p ${port}`, '-l', log, '-w', 'start'], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`could not start Postgres in ${dir}; see ${log}`);
}

const answers = (port: number) => spawnSync(join(BIN, 'pg_isready.exe'), ['-h', '127.0.0.1', '-p', String(port)], { stdio: 'ignore' }).status === 0;

/** #4413: a Windows worktree tests against its own cluster (its .pgdata, its own port). All worktrees used to share
 *  127.0.0.1:5434, served by whichever worktree's cluster started first: eight parallel runs ran out of its 100
 *  connections ("too many clients") and failed when that cluster was in crash recovery. The main checkout, and every
 *  other platform (Postgres started by hand), keep 5434. */
export function ownTestPg(root = ROOT, platform = process.platform): boolean {
  return platform === 'win32' && (statSync(join(root, '.git'), { throwIfNoEntry: false })?.isFile() ?? false);
}

/** The port a test run on this checkout uses: 5434; for a worktree, the port its running cluster listens on, else the
 *  first free one from a start derived from the worktree's path (15435-16454: below Windows' excluded dynamic ranges). */
export function testPgPort(root = ROOT, platform = process.platform): number {
  if (!ownTestPg(root, platform)) return 5434;
  const dir = join(root, '.pgdata');
  if (spawnSync(pgCtl, ['-D', dir, 'status'], { stdio: 'ignore' }).status === 0) {
    const port = Number(readFileSync(join(dir, 'postmaster.pid'), 'utf8').split(/\r?\n/)[3]);
    if (port > 0) return port;
  }
  let h = 2166136261; // FNV-1a of the path: the same worktree gets the same port each run
  for (const c of root.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const start = 15435 + (h % 1000);
  for (let port = start; port < start + 20; port++) if (!answers(port)) return port;
  throw new Error(`no free port for this worktree's test Postgres in ${start}-${start + 19}: other servers answer on all of them`);
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
