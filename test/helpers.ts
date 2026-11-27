import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

// CB_TEST_DB lets parallel worktrees test without wiping each other's data.
export const TEST_URL = `postgres://cb@127.0.0.1:5434/${process.env.CB_TEST_DB ?? 'claude_board_test'}`;
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

/** Applies setup to the test DB (once per process) and wipes all cb tables. */
export async function freshDb() {
  if (!ready) {
    execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe' });
    ready = true;
  }
  // tests seed as Ahmed too: they connect as his dashboard does (sessions can't act as ahmed)
  const sql = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'cb-web' } });
  const tables = await sql`select tablename from pg_tables where schemaname = 'cb' and tablename <> 'role_texts'`; // role_texts is filled by setup, not by tests
  if (tables.length) await sql.unsafe(`truncate ${tables.map((t) => 'cb.' + t.tablename).join(', ')} restart identity cascade`);
  return sql;
}

/** Puts a person on a project (creating it), as Ahmed does on People: work reaches people only on their projects. */
export async function onProject(sql: any, user: string, project: string) {
  await sql`select cb.ensure_project(${project}), cb.user_project_add(${user}, ${project}, 'ahmed')`;
}
