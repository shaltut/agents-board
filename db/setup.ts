// Creates the database if missing and applies schema.sql (idempotent).
// --test targets claude_board_test. Without --test, also puts bin/ on the user PATH (main checkout only, #373).
// --test --stop stops a Windows worktree's own test cluster (#4413): run it before removing the worktree.
import postgres from 'postgres';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { ensurePg, ensureTestPg, ownsPg, stopTestPg, testDbUrl } from './pg.ts';
import { databaseUrl } from '../server/db.ts';
import { loadRoleTexts } from './roles.ts';
import { recordSchema, schemaSha } from './schema-applied.ts';

const ROOT = join(import.meta.dirname, '..');
const isTest = process.argv.includes('--test');
if (process.argv.includes('--stop')) {
  // without --test this would run the full setup against CB_DATABASE_URL's board (the live one on this PC)
  if (!isTest) { console.error('--stop only stops a worktree\'s test cluster: run node db/setup.ts --test --stop'); process.exit(1); }
  const r = stopTestPg();
  (r.ok ? console.log : console.error)(r.message);
  process.exit(r.ok ? 0 : 1);
}
const url = new URL(isTest ? testDbUrl() : databaseUrl());
const dbName = url.pathname.slice(1);

if (isTest) ensureTestPg(url.toString());
else if (ownsPg(url.toString())) ensurePg();

const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { onnotice: () => {} });
const [exists] = await admin`select 1 from pg_database where datname = ${dbName}`;
if (!exists) await admin.unsafe(`create database "${dbName}"`);
await admin.end();

const sql = postgres(url.toString(), { onnotice: () => {} });
await sql.file(join(ROOT, 'db', 'schema.sql'));
await recordSchema(sql, schemaSha(join(ROOT, 'db', 'schema.sql'))); // after the whole file applied (#4352)
await loadRoleTexts(sql, join(ROOT, 'prompts', 'roles'));
await sql.end();

// A worktree's .git is a file: its bin/ is a dev copy and must not shadow the live cb on PATH (#373).
const isWorktree = statSync(join(ROOT, '.git'), { throwIfNoEntry: false })?.isFile() ?? false;
if (!isTest && !isWorktree && process.platform === 'win32') addBinToPath();
console.log(`claude-board: ${dbName} ready`);

function addBinToPath() {
  const bin = join(ROOT, 'bin');
  let current = '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' });
    current = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/)?.[1]?.trim() ?? '';
  } catch {}
  if (current.toLowerCase().split(';').includes(bin.toLowerCase())) return;
  const next = current ? `${current};${bin}` : bin;
  execFileSync('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', next, '/f'], { stdio: 'ignore' });
  console.log(`added ${bin} to your user PATH — open a new terminal to use \`cb\``);
}
