// #4726: every start re-applies the schema beside live readers. It must not re-create a check constraint that did not
// change (ACCESS EXCLUSIVE plus a full scan), and a lock it loses is waited for and tried again, not a dead start.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { applySchema } from '../db/apply.ts';

const clients: any[] = [];
const dir = mkdtempSync(join(tmpdir(), 'cb-apply-'));
after(async () => { await Promise.all(clients.map((c) => c.end())); rmSync(dir, { recursive: true, force: true }); });

const checks = async (sql: any) => (await sql`select c.conrelid::regclass::text t, c.conname n, c.oid::int id, pg_get_constraintdef(c.oid) def
  from pg_constraint c join pg_namespace s on s.oid = c.connamespace where s.nspname = 'cb' and c.contype = 'c' order by 1, 2`).map((r: any) => ({ ...r }));

test('a second apply re-creates no check constraint; a changed one is put back', { timeout: 120_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql.file('db/schema.sql');
  const first = await checks(sql);
  assert.ok(first.length >= 11, `found ${first.length}`);
  await sql.file('db/schema.sql');
  assert.deepEqual(await checks(sql), first); // a re-created constraint has a new oid
  // an older schema's definition (it carries no stamp) is replaced by this one
  const want = first.find((c: any) => c.n === 'events_kind_check')!;
  await sql.unsafe(`alter table cb.events drop constraint events_kind_check; alter table cb.events add constraint events_kind_check check (kind <> '') not valid`);
  await sql.file('db/schema.sql');
  assert.equal((await checks(sql)).find((c: any) => c.n === 'events_kind_check')!.def, want.def);
});

test('schema.sql drops and re-adds no check constraint by hand: cb._ensure_check does it', () => {
  assert.doesNotMatch(readFileSync('db/schema.sql', 'utf8'), /^alter table \S+ drop constraint if exists \w+_check;/m);
});

test('an apply that loses a lock is tried again once the lock is free', { timeout: 60_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`drop table if exists public.cb_apply_probe`;
  await sql`create table public.cb_apply_probe (a int)`;
  const file = join(dir, 'probe.sql');
  writeFileSync(file, 'alter table public.cb_apply_probe add column b int;\n');
  const one = postgres(TEST_URL, { max: 1, connection: { lock_timeout: 200 }, onnotice: () => {} }); clients.push(one);
  const holder = await sql.reserve();
  await holder`begin`;
  await holder`select * from public.cb_apply_probe`;
  const lost: string[] = [];
  try {
    await applySchema(one, file, { waitMs: 10, onRetry: async (code) => { lost.push(code); await holder`commit`; } });
  } finally { holder.release(); }
  assert.deepEqual(lost, ['55P03']);
  await sql`select b from public.cb_apply_probe`;
  await sql`drop table public.cb_apply_probe`;
});

test('an apply gives up after its tries, and retries only a deadlock or a lock timeout', async () => {
  const failing = (code: string) => { let n = 0; return { sql: { file: async () => { n++; throw Object.assign(new Error(code), { code }); } }, runs: () => n }; };
  for (const [code, runs] of [['40P01', 5], ['55P03', 5], ['42601', 1]] as const) {
    const f = failing(code);
    await assert.rejects(applySchema(f.sql, 'x.sql', { waitMs: 0, onRetry: () => {} }), { code });
    assert.equal(f.runs(), runs, code);
  }
});
