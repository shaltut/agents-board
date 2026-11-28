// #3222 S7, ruling D4: at cut-over the board's database is audited where it is, for what a holder of its superuser
// password could have left. Run by the owner: docs/ops/maintain.md, "Cut-over".
//
// It reads only (every connection is a read-only transaction), and compares every database with the same one on a clean
// cluster set up from the same release: anything added, changed or missing is listed. A few things are listed even when
// both sides have them. It prints shapes: names of database objects, counts and ids, never a body, a value, a person or
// a project, so its output may go on the board. A name is whatever its maker chose: read it as untrusted text.
//
// What it cannot see: a COPY ... PROGRAM that ran leaves nothing in the catalogs, a superuser can change files outside
// them, and can make the catalogs lie. The runbook looks at the database container too; in doubt, restore into a clean
// database.
import postgres from 'postgres';
import { join } from 'node:path';
import { readRoleSeeds } from './roles.ts';

type Rows = Map<string, string>; // what it is (a name) -> a fingerprint of how it is defined
export type Report = { lines: string[]; findings: number };

/** One read-only look: pg_catalog first on the path, so no object made by anyone answers for a built-in name. */
export async function readOnly<T>(url: string, work: (sql: any) => PromiseLike<T>): Promise<T> {
  const client = postgres(url, { max: 1, onnotice: () => {},
    connection: { application_name: 'cb-audit', default_transaction_read_only: true, search_path: 'pg_catalog, pg_temp', statement_timeout: 120_000 } });
  try { return await client.begin('isolation level repeatable read read only', (sql: any) => work(sql)) as T; }
  finally { await client.end(); }
}

const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${encodeURIComponent(db)}`; return u.toString(); };
// a name as one printable line: no control characters (a name could carry terminal escapes), at most 160
const shown = (s: string) => { const one = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?'); return one.length > 160 ? `${one.slice(0, 157)}...` : one; };

const USER_SCHEMA = `n.nspname !~ '^pg_(toast|temp)'`;

// Each answers (what, how): `what` is printed, `how` is only compared. No object ids: they differ between two clusters
const PER_DATABASE = [
  `select 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as what,
     concat_ws('|', l.lanname, p.prosrc, p.probin, pg_get_function_sqlbody(p.oid), p.prosecdef, p.proleakproof, p.provolatile,
       p.prokind, p.proconfig::text, p.proacl::text, o.rolname, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid),
       a.aggtransfn::text, a.aggfinalfn::text) as how
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
   join pg_roles o on o.oid = p.proowner left join pg_aggregate a on a.aggfnoid = p.oid where ${USER_SCHEMA}`,
  `select 'relation ' || n.nspname || '.' || c.relname,
     concat_ws('|', c.relkind, o.rolname, c.relacl::text, c.relrowsecurity, c.relforcerowsecurity, c.reloptions::text,
       case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid) end)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles o on o.oid = c.relowner
   where ${USER_SCHEMA} and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')`,
  // by name: a board that was upgraded has its columns in another order than a new one
  `select 'column ' || n.nspname || '.' || c.relname || '.' || a.attname,
     concat_ws('|', format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated, a.attacl::text,
       pg_get_expr(d.adbin, d.adrelid))
   from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where ${USER_SCHEMA} and c.relkind in ('r', 'p', 'v', 'm', 'f') and a.attnum > 0 and not a.attisdropped`,
  `select 'index ' || schemaname || '.' || indexname || ' on ' || tablename, indexdef from pg_indexes where schemaname !~ '^pg_(toast|temp)'`,
  `select 'constraint ' || co.conname || ' on ' || n.nspname || '.' || coalesce(c.relname, t.typname), pg_get_constraintdef(co.oid)
   from pg_constraint co join pg_namespace n on n.oid = co.connamespace
   left join pg_class c on c.oid = co.conrelid left join pg_type t on t.oid = co.contypid where ${USER_SCHEMA}`,
  `select 'trigger ' || t.tgname || ' on ' || n.nspname || '.' || c.relname, concat_ws('|', pg_get_triggerdef(t.oid), t.tgenabled)
   from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal`,
  `select 'rule ' || r.rulename || ' on ' || n.nspname || '.' || c.relname, pg_get_ruledef(r.oid)
   from pg_rewrite r join pg_class c on c.oid = r.ev_class join pg_namespace n on n.oid = c.relnamespace where r.rulename <> '_RETURN'`,
  `select 'policy ' || policyname || ' on ' || schemaname || '.' || tablename, concat_ws('|', cmd, roles::text, qual, with_check, permissive) from pg_policies`,
  `select 'event trigger ' || e.evtname, concat_ws('|', e.evtevent, e.evtfoid::regprocedure::text, e.evtenabled) from pg_event_trigger e`,
  `select 'extension ' || e.extname, concat_ws('|', e.extversion, n.nspname) from pg_extension e join pg_namespace n on n.oid = e.extnamespace`,
  `select 'schema ' || n.nspname, concat_ws('|', o.rolname, n.nspacl::text) from pg_namespace n join pg_roles o on o.oid = n.nspowner where ${USER_SCHEMA}`,
  `select 'language ' || lanname, concat_ws('|', lanpltrusted, lanacl::text, lanplcallfoid::regprocedure::text) from pg_language`,
  `select 'cast ' || castsource::regtype::text || ' to ' || casttarget::regtype::text, concat_ws('|', castfunc::regprocedure::text, castcontext, castmethod) from pg_cast`,
  `select 'operator ' || o.oid::regoperator::text, o.oprcode::text from pg_operator o`,
  `select 'foreign data wrapper ' || fdwname, fdwoptions::text from pg_foreign_data_wrapper`,
  `select 'foreign server ' || srvname, concat_ws('|', srvoptions::text, srvacl::text) from pg_foreign_server`,
  `select 'user mapping ' || coalesce(usename, 'public') || ' on ' || srvname, umoptions::text from pg_user_mappings`,
  `select 'publication ' || pubname, concat_ws('|', puballtables, pubinsert, pubupdate, pubdelete) from pg_publication`,
  `select 'default privileges ' || defaclobjtype::text || ' of ' || r.rolname || ' in ' || coalesce(n.nspname, 'all schemas'), defaclacl::text
   from pg_default_acl d join pg_roles r on r.oid = d.defaclrole left join pg_namespace n on n.oid = d.defaclnamespace`,
  `select 'large objects', count(*)::text from pg_largeobject_metadata having count(*) > 0`,
];

// settings whose value runs a command or loads code
const RUNS_CODE = ['archive_command', 'archive_library', 'restore_command', 'archive_cleanup_command', 'recovery_end_command',
  'shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries', 'ssl_passphrase_command'];

async function rowsOf(sql: any, queries: string[]): Promise<Rows> {
  const rows: Rows = new Map();
  for (const q of queries) for (const r of await sql.unsafe(q).values()) rows.set(String(r[0]), String(r[1] ?? ''));
  return rows;
}

function differences(live: Rows, ref: Rows, where: string): string[] {
  const out: string[] = [];
  for (const [what, how] of live) if (!ref.has(what)) out.push(`added ${what}${where}`); else if (ref.get(what) !== how) out.push(`changed ${what}${where}`);
  for (const what of ref.keys()) if (!live.has(what)) out.push(`missing ${what}${where}`);
  return out.sort();
}

/** Listed whether or not the reference has them: this board's cluster needs none of these. */
async function cluster(sql: any): Promise<{ rows: Rows; look: string[]; notes: string[]; version: string }> {
  const look: string[] = [], notes: string[] = [];
  const me = (await sql`select current_user as u`)[0].u;
  const rows = await rowsOf(sql, [
    `select 'role ' || rolname, concat_ws('|', rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil)
     from pg_roles where rolname !~ '^pg_'`,
    `select 'membership of ' || m.rolname || ' in ' || r.rolname, a.admin_option::text from pg_auth_members a
     join pg_roles m on m.oid = a.member join pg_roles r on r.oid = a.roleid`,
    `select 'tablespace ' || spcname, concat_ws('|', pg_tablespace_location(oid), spcacl::text) from pg_tablespace`,
  ]);
  for (const r of await sql`select rolname from pg_roles where rolname !~ '^pg_' and rolname <> current_user order by 1`) look.push(`a role besides the board's own: ${r.rolname}`);
  for (const r of await sql`select m.rolname as member, r.rolname as of from pg_auth_members a join pg_roles m on m.oid = a.member
      join pg_roles r on r.oid = a.roleid where m.rolname !~ '^pg_' order by 1, 2`) look.push(`${r.member} is a member of ${r.of}`);
  notes.push(`the board connects as ${me}`);
  for (const r of await sql`select distinct split_part(c, '=', 1) as name, coalesce(d.datname, 'every database') as db, coalesce(o.rolname, 'every role') as role
      from pg_db_role_setting s cross join unnest(s.setconfig) c left join pg_database d on d.oid = s.setdatabase
      left join pg_roles o on o.oid = s.setrole order by 1, 2, 3`) look.push(`a setting stored for a role or database: ${r.name} (${r.role}, ${r.db})`);
  for (const r of await sql`select name from pg_settings where name = any(${RUNS_CODE}) and setting not in ('', '(disabled)') order by 1`)
    look.push(`${r.name} is set: its value can run a command or load code (read it in the database)`);
  for (const r of await sql`select distinct name from pg_file_settings where sourcefile like '%postgresql.auto.conf' order by 1`)
    look.push(`postgresql.auto.conf (ALTER SYSTEM) sets ${r.name}`);
  for (const r of await sql`select type, database, user_name, auth_method, error,
      case when address is null then 'local' when address = 'all' then 'any address' when address in ('127.0.0.1', '::1', 'localhost') then 'this host'
           when address in ('samehost', 'samenet') then address else 'a network' end as source, concat_ws('/', address, netmask) as address
      from pg_hba_file_rules order by line_number`) {
    if (r.error) { look.push('a line of pg_hba.conf has an error'); continue; }
    const what = `access rule: ${r.type} from ${r.source}, databases ${r.database}, users ${r.user_name}: ${r.auth_method}`;
    rows.set(`${what} (${r.address})`, '');
    if (r.auth_method === 'trust' && r.type !== 'local' && r.source !== 'this host') look.push(`access without a password: ${what}`);
  }
  const counts = (await sql`select (select count(*) from pg_replication_slots)::int as "replication slots",
    (select count(*) from pg_subscription)::int as subscriptions, (select count(*) from pg_prepared_xacts)::int as "prepared transactions"`)[0];
  for (const [what, n] of Object.entries(counts)) if (n) look.push(`${what}: ${n}`);
  const version = (await sql`show server_version`)[0].server_version;
  return { rows, look, notes, version };
}

/** What a database holds that is listed even when the reference holds the same. */
async function inDatabase(sql: any, db: string): Promise<string[]> {
  const look: string[] = [];
  for (const r of await sql`select evtname from pg_event_trigger order by 1`) look.push(`event trigger ${r.evtname} in ${db}`);
  for (const r of await sql`select extname from pg_extension where extname not in ('plpgsql', 'pgcrypto') order by 1`) look.push(`extension ${r.extname} in ${db}`);
  for (const r of await sql`select distinct n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and p.prosrc ~* '\\mcopy\\M[\\s\\S]*\\m(to|from)\\s+program\\M' order by 1`)
    look.push(`function ${r.f} names COPY ... PROGRAM, which runs a command`);
  return look;
}

// the board's tables whose rows the audit reads
const READ = ['users', 'sign_ins', 'settings', 'projects', 'events', 'role_texts', 'memories'];

/** The board's own rows (users and roles, squads and protected branches, role texts, owner authority), as counts and ids. */
async function boardRows(sql: any, seeds: Record<string, string>): Promise<{ look: string[]; notes: string[] }> {
  const look: string[] = [], notes: string[] = [];
  // reading a view, or a table with a rule or policy, runs whatever it names, as the superuser reading it
  const kinds = new Map<string, string>((await sql`select c.relname, c.relkind::text || case when c.relrowsecurity or c.relhasrules then '+' else '' end as kind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'cb' and c.relname = any(${READ})`).map((r: any) => [r.relname, r.kind]));
  const plain = (t: string) => {
    const k = kinds.get(t);
    if (k === 'r') return true;
    if (k) look.push(`cb.${t} is not an ordinary table: its rows were not read`);
    else if (t !== 'sign_ins') look.push(`cb.${t} is missing`);
    return false;
  };
  const columns = new Set((await sql`select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'cb'`).map((r: any) => r.c));
  const ids = (rows: any[], prefix = '') => rows.map((r) => prefix + r.id).join(' ');

  if (plain('users')) {
    const u = (await sql`select count(*) filter (where role = 'admin')::int as admins, count(*) filter (where role = 'member')::int as members,
      count(*) filter (where role = 'admin' and password is null)::int as bare, count(*) filter (where password is not null)::int as passwords from cb.users`)[0];
    notes.push(`users: ${u.admins} admin, ${u.members} member, ${u.passwords} with a password`);
    if (u.bare) look.push(`${u.bare} admin${u.bare === 1 ? ' has' : 's have'} no password: after the sign-ins are ended (D5) they cannot sign in`);
    if (columns.has('users.token')) {
      const n = (await sql`select count(token)::int as n from cb.users`)[0].n;
      if (n) look.push(`${n} plain sign-in value${n === 1 ? '' : 's'} in cb.users.token`);
    }
  }
  if (plain('sign_ins')) {
    const s = await sql`select kind, count(*)::int as n from cb.sign_ins group by kind order by kind`;
    notes.push(`sign-ins to end at D5: ${s.map((r: any) => `${r.n} ${r.kind}`).join(', ') || 'none'}`);
  }
  if (plain('settings')) notes.push(`rows in cb.settings: ${(await sql`select count(*)::int as n from cb.settings`)[0].n} (read them in the database)`);
  if (plain('projects') && columns.has('projects.squad')) {
    const s = (await sql`select count(*) filter (where squad is not null)::int as squads, count(*) filter (where squad ? 'protected')::int as fenced,
      count(*) filter (where squad ? 'supervise' and squad ->> 'supervise' = 'true')::int as supervised, count(*) filter (where auto_backup)::int as backup from cb.projects`)[0];
    notes.push(`squads: ${s.squads}, ${s.fenced} naming protected branches, ${s.supervised} supervised; projects with automatic backup on: ${s.backup} (check each on its settings page)`);
  }
  if (plain('events')) {
    const raw = await sql`select id from cb.events where actor = 'ahmed' and data ->> 'raw' = 'true' and at > now() - interval '30 days' order by id`;
    notes.push(`messages typed into seats as the owner's own words (read each one: did the owner send it?): ${raw.length} in the last 30 days${raw.length ? `: ${ids(raw)}` : ''}`);
    const squads = await sql`select id from cb.events where kind = 'updated' and summary = 'squad updated' and at > now() - interval '30 days' order by id`;
    notes.push(`squad saves in the last 30 days: ${squads.length}${squads.length ? `, events ${ids(squads)}` : ''}`);
  }
  if (plain('role_texts')) {
    const differ = (await sql`select role, body from cb.role_texts order by role`)
      .filter((r: any) => (seeds[r.role] ?? null) !== String(r.body).trim()).map((r: any) => (Object.hasOwn(seeds, r.role) ? r.role : 'a role this release does not ship'));
    notes.push(`role texts that differ from this release's files: ${differ.join(', ') || 'none'} (edited or older: read each on its settings page)`);
  }
  if (plain('memories')) {
    const m = await sql`select id from cb.memories where authority = 'ahmed' and confirmed_at > now() - interval '30 days' order by id`;
    notes.push(`rules and rulings under the owner's authority confirmed in the last 30 days: ${m.length ? `${ids(m, 'M')} (cb mem show <id>)` : 'none'}`);
  }
  return { look, notes };
}

/** live: the board's database. reference: the same database on a clean cluster set up from this release. others: the
 *  other databases of both clusters to compare too ('all': every one that takes connections). */
export async function audit(o: { live: string; reference: string; others?: string[] | 'all' }): Promise<Report> {
  const look: string[] = [], notes: string[] = [];
  const liveCluster = await readOnly(o.live, cluster), refCluster = await readOnly(o.reference, cluster);
  if (liveCluster.version !== refCluster.version) look.push(`the server is version ${liveCluster.version}, the reference ${refCluster.version}: use the same image, or built-in objects differ`);
  look.push(...liveCluster.look, ...differences(liveCluster.rows, refCluster.rows, ' (the cluster)'));
  notes.push(...liveCluster.notes);

  const databasesOf = (url: string) => readOnly(url, async (sql) => await rowsOf(sql, [
    `select d.datname, concat_ws('|', o.rolname, d.datistemplate, d.datallowconn, d.datacl::text) from pg_database d join pg_roles o on o.oid = d.datdba`]));
  const main = decodeURIComponent(new URL(o.live).pathname.slice(1));
  let others = o.others ?? 'all';
  if (others === 'all') {
    const [live, ref] = [await databasesOf(o.live), await databasesOf(o.reference)];
    look.push(...differences(live, ref, ' (a database)'));
    others = [...live].filter(([name, how]) => name !== main && how.split('|')[2] === 't' && ref.has(name)).map(([name]) => name);
  }
  const pairs: [string, string, string][] = [[main, o.live, o.reference], ...others.map((db): [string, string, string] => [db, withDb(o.live, db), withDb(o.reference, db)])];
  for (const [db, live, reference] of pairs) {
    const [rows, own] = await readOnly(live, async (sql) => [await rowsOf(sql, PER_DATABASE), await inDatabase(sql, db)] as const);
    const clean = await readOnly(reference, (sql) => rowsOf(sql, PER_DATABASE));
    look.push(...own, ...differences(rows, clean, db === main ? '' : ` in ${db}`));
  }

  const mine = await readOnly(o.live, (sql) => boardRows(sql, readRoleSeeds(join(import.meta.dirname, '..', 'prompts', 'roles'))));
  look.push(...mine.look);
  notes.push(...mine.notes);
  const lines = [`Database audit (D4): read only. ${pairs.length} database${pairs.length === 1 ? '' : 's'} compared.`,
    ...notes.map(shown), ...look.map((l) => shown(`LOOK: ${l}`)),
    `${look.length} thing${look.length === 1 ? '' : 's'} to look at.${look.length ? ' Anything you cannot explain: restore into a clean database (maintain.md).' : ''}`,
    'Not seen here: a COPY ... PROGRAM that already ran, and files changed outside the catalogs: check the database container too.'];
  return { lines, findings: look.length };
}

if (import.meta.main) {
  const live = process.env.CB_DATABASE_URL, reference = process.env.CB_AUDIT_REFERENCE_URL;
  if (!live || !reference) {
    console.error(`the audit needs CB_DATABASE_URL (the board's database) and CB_AUDIT_REFERENCE_URL (a clean one set up from this release): see docs/ops/maintain.md, "Cut-over"`);
    process.exit(2);
  }
  // CB_AUDIT_DATABASES: the other databases to compare, comma separated; unset: all of them
  const only = process.env.CB_AUDIT_DATABASES;
  try {
    const r = await audit({ live, reference, others: only === undefined ? 'all' : only.split(',').filter(Boolean) });
    console.log(r.lines.join('\n'));
    process.exit(r.findings ? 1 : 0);
  } catch (e: any) { // never the address: it holds the password
    console.error(`the audit did not finish: ${String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, '<database address>')}`);
    process.exit(2);
  }
}
