import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import postgres from 'postgres';
import { testDbUrl } from '../db/pg.ts';
import { loadRoleTexts } from '../db/roles.ts';

// CB_TEST_DB lets parallel worktrees test without wiping each other's data. On Windows a worktree also gets its own
// cluster and port (#4413: they shared 5434 and its 100 connections); the main checkout and other platforms use 5434.
export const TEST_URL = testDbUrl();
process.env.CB_TEST_PG_PORT = new URL(TEST_URL).port; // its db/setup.ts --test child must pick the same port
// freshDb truncates every table: never anything but a test database (a VPS agent's CB_TEST_DB=claude_board would wipe the board)
if (!/^claude_board_test\w*$/.test(process.env.CB_TEST_DB ?? 'claude_board_test')) throw new Error(`CB_TEST_DB must start with claude_board_test, not "${process.env.CB_TEST_DB}"`);
process.env.CB_DATABASE_URL = TEST_URL;
// #4400: the servers the tests start read who counts as this PC from the env on each request (server/main.ts
// trustLocal). The deploy image sets HOST=0.0.0.0 and CB_TRUST_LOCAL=0, so a run there (or in any shell with either set)
// made every local test request a stranger: about 50 tests failed with 401. Clear them: the servers' defaults are what
// the tests are written for (a test about these settings, auth.test.ts, sets and clears its own).
delete process.env.HOST;
delete process.env.CB_TRUST_LOCAL;
delete process.env.CB_BEHIND_CLOUDFLARE;

let ready = false;
// #4482: setup (cluster start, database, schema) took ~40 s on a loaded PC; past this it fails, in words, with what to
// run, instead of leaving the run silent (db/pg.ts gives each step its own deadline).
const SETUP_MS = 300_000;

function setupTestDb() {
  try {
    execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe', timeout: SETUP_MS });
  } catch (e: any) {
    const stalled = e?.code === 'ETIMEDOUT' ? `node db/setup.ts --test did not finish within ${SETUP_MS / 1000} s`
      : /(?:^|\n)Error: ([^\n]* did not finish within [^\n]*)/.exec(String(e?.stderr ?? ''))?.[1];
    if (!stalled) throw e;
    throw new Error(`the test database is not ready: ${stalled}. Stop this checkout's test cluster with node db/setup.ts --test --stop `
      + `and run the tests again (on Windows the cluster's log is ${join(import.meta.dirname, '..', '.pgdata', 'server.log')})`);
  }
}

/** Applies setup to the test DB (once per process) and wipes all cb tables. */
/** #3772: a connection of another database on the same Postgres that carries one of our application names, as another
 *  test run's relay would. It runs nothing but "select": the maintenance database is only somewhere else to be. */
export async function stranger(name: string) {
  const url = new URL(TEST_URL);
  url.pathname = '/postgres';
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {}, connection: { application_name: name } });
  const [{ pid }] = await sql`select pg_backend_pid() as pid`;
  return { pid: pid as number, end: () => sql.end() };
}

export async function freshDb() {
  if (!ready) {
    setupTestDb();
    ready = true;
  }
  // tests seed as Ahmed too: they connect as his dashboard does (sessions can't act as ahmed)
  const sql = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'cb-web' } });
  const tables = await sql`select tablename from pg_tables where schemaname = 'cb'`;
  // #4482: a lock held by a connection left from an earlier test fails the wipe in a minute instead of waiting forever
  if (tables.length) await sql.begin(async (tx: any) => {
    await tx`set local lock_timeout = '60s'`;
    await tx.unsafe(`truncate ${tables.map((t) => 'cb.' + t.tablename).join(', ')} restart identity cascade`);
  });
  // role texts as the files say (#4332): setup only seeds a missing role, so a test database kept from an older checkout
  // would otherwise hold old texts forever, and a test that edits one would leak it into the next
  await loadRoleTexts(sql, join(import.meta.dirname, '..', 'prompts', 'roles'));
  return sql;
}

/** Puts a person on a project (creating it), as Ahmed does on People: work reaches people only on their projects. */
export async function onProject(sql: any, user: string, project: string) {
  await sql`select cb.ensure_project(${project}), cb.user_project_add(${user}, ${project}, 'ahmed')`;
}
