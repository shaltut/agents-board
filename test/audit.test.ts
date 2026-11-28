// #3222 S7 prep (#4915), ruling D4: the audit of what a superuser could have left in the board's database. It reads only,
// compares with a clean database of the same release, and prints shapes: object names, counts and ids, never a value.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import postgres from 'postgres';
import { TEST_URL } from './helpers.ts';
import { applySchema } from '../db/apply.ts';
import { loadRoleTexts } from '../db/roles.ts';
import { audit, readOnly } from '../db/audit.ts';

const ROOT = join(import.meta.dirname, '..');
// databases and a role of this run's own: others share the cluster
const LIVE = `claude_board_test_audit_live_${process.pid}`, REF = `claude_board_test_audit_ref_${process.pid}`;
const ROLE = `cb_audit_test_${process.pid}`;
const urlOf = (db: string) => { const u = new URL(TEST_URL); u.pathname = `/${db}`; return u.toString(); };
const connectTo = (db: string) => postgres(urlOf(db), { max: 1, onnotice: () => {} });
let admin: any;

before(async () => {
  admin = connectTo('postgres');
  for (const db of [LIVE, REF]) {
    await admin.unsafe(`create database ${db}`);
    const sql = connectTo(db);
    await applySchema(sql, join(ROOT, 'db', 'schema.sql'));
    await loadRoleTexts(sql, join(ROOT, 'prompts', 'roles'));
    await sql.end();
  }
});
after(async () => {
  for (const db of [LIVE, REF]) await admin.unsafe(`drop database if exists ${db} with (force)`);
  await admin.unsafe(`drop role if exists ${ROLE}`);
  await admin.end();
});

const run = () => audit({ live: urlOf(LIVE), reference: urlOf(REF), others: [] });
const has = (lines: string[], re: RegExp) => assert.ok(lines.some((l) => re.test(l)), `${re}\n${lines.join('\n')}`);

test('two clean databases of one release differ in nothing', async () => {
  const r = await run();
  assert.deepEqual(r.lines.filter((l) => /^LOOK: (added|changed|missing) /.test(l)), []);
});

test('the audit cannot write', async () => {
  await assert.rejects(readOnly(urlOf(LIVE), (sql) => sql`insert into cb.settings (key, value) values ('x', '1')`), /read-only transaction/);
});

test('what a superuser left in the database is listed by name', async () => {
  const sql = connectTo(LIVE);
  try {
    await sql.unsafe(`create function public.zz_helper() returns text language sql as $$ select 'zzyxbody' $$`);
    await sql.unsafe(`create function public.zz_export() returns void language plpgsql as $$ begin execute 'copy cb.users to program ''zzyxcommand'''; end $$`);
    await sql.unsafe(`create or replace function cb.board_now() returns timestamptz language sql stable security definer as $$ select now() - interval '1 day' $$`);
    await sql.unsafe(`create function public.zz_event() returns event_trigger language plpgsql as $$ begin end $$`);
    await sql.unsafe(`create event trigger zz_on_ddl on ddl_command_end execute function public.zz_event()`);
    await sql.unsafe(`alter event trigger zz_on_ddl disable`);
    await sql.unsafe(`create function public.zz_row() returns trigger language plpgsql as $$ begin return new; end $$`);
    await sql.unsafe(`create trigger zz_on_user after insert on cb.users for each row execute function public.zz_row()`);
    await sql.unsafe(`create schema "zz${String.fromCharCode(7)}bell"`); // a name is its maker's text
    await sql.unsafe(`alter table cb.tasks add column zz_backdoor text`);
    await sql.unsafe(`grant select on cb.users to public`);
    await sql.unsafe(`create schema zz_hidden`);
    await sql.unsafe(`create view zz_hidden.zz_view as select 1 as one`);
    await admin.unsafe(`create role ${ROLE} login`);
    await admin.unsafe(`grant pg_execute_server_program to ${ROLE}`);
    await admin.unsafe(`alter database ${LIVE} set statement_timeout = '123456'`);
  } finally { await sql.end(); }
  const r = await run();
  has(r.lines, /^LOOK: added function public\.zz_helper\(\)/);
  has(r.lines, /^LOOK: changed function cb\.board_now\(\)/);
  has(r.lines, /^LOOK: function public\.zz_export\(\) names COPY .* PROGRAM/);
  has(r.lines, /^LOOK: event trigger zz_on_ddl/);
  has(r.lines, /^LOOK: added trigger zz_on_user on cb\.users/);
  has(r.lines, /^LOOK: added column cb\.tasks\.zz_backdoor/);
  has(r.lines, /^LOOK: changed relation cb\.users/);
  has(r.lines, /^LOOK: added schema zz_hidden/);
  has(r.lines, /^LOOK: added relation zz_hidden\.zz_view/);
  has(r.lines, new RegExp(`^LOOK: a role besides the board's own: ${ROLE}`));
  has(r.lines, new RegExp(`^LOOK: ${ROLE} is a member of pg_execute_server_program`));
  has(r.lines, /^LOOK: a setting stored for a role or database: statement_timeout/);
  has(r.lines, /^LOOK: added schema zz\?bell/);
  for (const line of r.lines) assert.doesNotMatch(line, /\p{Cc}/u, 'no control character reaches the terminal');
  assert.ok(r.findings >= 12, String(r.findings));
  assert.doesNotMatch(r.lines.join('\n'), /zzyxbody|zzyxcommand|123456/, 'names only, never a body or a value');
});

test("the board's own rows are told as counts and ids, never as names or values", async () => {
  const sql = connectTo(LIVE);
  let raw: number;
  try {
    await sql`insert into cb.projects (slug, name) values ('zzyxproj', 'Zzyx Project')`;
    await sql`insert into cb.users (name, display, role) values ('zzyxuser', 'Zzyx Person', 'admin')`;
    await sql`insert into cb.settings (key, value) values ('zz_key', ${sql.json('zzyxvalue')})`;
    raw = Number((await sql`insert into cb.events (actor, project, kind, summary, data) values ('ahmed', 'zzyxproj', 'message', 'zzyxprompt', ${sql.json({ raw: 'true' })}) returning id`)[0].id);
    await sql`update cb.role_texts set body = 'zzyxrole' where role = 'builder'`;
    await sql`insert into cb.memories (kind, title, body, status, authority, created_by, confirmed_by, confirmed_at) values ('rule', 'zzyxtitle', 'zzyxmemory', 'active', 'ahmed', 'ahmed', 'ahmed', now())`;
  } finally { await sql.end(); }
  const r = await run();
  has(r.lines, /users: 1 admin, 0 member/);
  has(r.lines, /^LOOK: 1 admin has no password/);
  has(r.lines, new RegExp(`typed into seats as the owner's own words.*: 1 in the last 30 days: ${raw}\\b`));
  has(r.lines, /role texts that differ from this release's files: builder/);
  has(r.lines, /rules and rulings under the owner's authority confirmed in the last 30 days: M\d+/);
  assert.doesNotMatch(r.lines.join('\n'), /zzyx/i);
});

test('a board table that is no ordinary table is not read', async () => {
  const sql = connectTo(LIVE);
  try {
    await sql.unsafe(`alter table cb.settings rename to settings_kept`);
    // a view here runs its function as whoever reads it: the audit must not
    await sql.unsafe(`create function public.zz_trap() returns text language plpgsql as $$ begin raise exception 'the audit ran the trap'; end $$`);
    await sql.unsafe(`create view cb.settings as select public.zz_trap() as key, null::jsonb as value`);
  } finally { await sql.end(); }
  const r = await run();
  has(r.lines, /^LOOK: cb\.settings is not an ordinary table: its rows were not read/);
});

test('the command prints no password, exits 1 with things to look at, and 2 with how to make a reference when none is given', () => {
  const secret = new URL(urlOf(LIVE)).password;
  const env = { ...process.env, CB_DATABASE_URL: urlOf(LIVE), CB_AUDIT_REFERENCE_URL: urlOf(REF), CB_AUDIT_DATABASES: '' };
  const r = spawnSync('node', ['db/audit.ts'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /things? to look at/);
  const none = spawnSync('node', ['db/audit.ts'], { cwd: ROOT, env: { ...env, CB_AUDIT_REFERENCE_URL: '' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(none.status, 2, none.stdout + none.stderr);
  assert.match(none.stderr, /CB_AUDIT_REFERENCE_URL.*maintain\.md/s);
  if (secret) for (const out of [r.stdout, r.stderr, none.stderr]) assert.ok(!out.includes(`:${secret}@`));
});
