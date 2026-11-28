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
  const failing = (code: string) => { let n = 0; return { sql: { begin: async () => { n++; throw Object.assign(new Error(code), { code }); } }, runs: () => n }; };
  for (const [code, runs] of [['40P01', 5], ['55P03', 5], ['42601', 1]] as const) {
    const f = failing(code);
    await assert.rejects(applySchema(f.sql, 'x.sql', { tries: 5, waitMs: 0, onRetry: () => {} }), { code });
    assert.equal(f.runs(), runs, code);
  }
});

// The deadlock seen live (twice): a reader holds one table and then wants another, while the apply holds the second and
// wants the first. 'add column if not exists' locks even when it adds nothing, so a re-apply still locks every table.
test('a live reader is never deadlocked by an apply: it holds one table, then reads another', { timeout: 120_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  const one = postgres(TEST_URL, { max: 1, connection: { lock_timeout: 5000 }, onnotice: () => {} }); clients.push(one);
  const reader = await sql.reserve();
  const lost: string[] = [];
  let apply: Promise<unknown>, readerError: any = null;
  try {
    await reader`begin`;
    await reader`select count(*) from cb.runners`; // a table the file reaches late
    apply = applySchema(one, 'db/schema.sql', { onRetry: (code) => { lost.push(code); } });
    apply.catch(() => {});
    // read the second table once the apply is under way: it holds cb.projects and waits, or it has already backed off
    for (let i = 0; i < 600 && !lost.length; i++) {
      const [held] = await sql`select 1 from pg_locks where relation = 'cb.projects'::regclass and mode = 'AccessExclusiveLock' and granted`;
      if (held) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    try { await reader`select count(*) from cb.projects`; } catch (e) { readerError = e; }
    await reader`commit`;
  } finally { reader.release(); }
  await apply!;
  assert.equal(readerError?.code ?? null, null, 'the reader lost its query');
  assert.ok(!lost.includes('40P01'), `the apply deadlocked: ${lost.join(' ')}`);
});

test('an apply gets through while many readers keep querying, and none of them fails', { timeout: 120_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  const one = postgres(TEST_URL, { max: 1, connection: { lock_timeout: 5000 }, onnotice: () => {} }); clients.push(one);
  const readers = postgres(TEST_URL, { max: 8, onnotice: () => {} }); clients.push(readers);
  let stop = false;
  const errors: string[] = [];
  let reads = 0;
  const loops = Array.from({ length: 8 }, async (_, i) => {
    while (!stop) {
      try {
        await (i % 2 ? readers`select count(*) from cb.events e left join cb.sessions s on s.actor = e.actor left join cb.tasks t on t.id = e.task_id left join cb.projects p on p.slug = t.project`
          : readers`select count(*) from cb.projects p left join cb.tasks t on t.project = p.slug left join cb.questions q on q.task_id = t.id left join cb.users u on u.name = t.assignee`);
        reads++;
      } catch (e: any) { errors.push(e.code ?? e.message); }
      await new Promise((r) => setTimeout(r, 5));
    }
  });
  try { await applySchema(one, 'db/schema.sql', { onRetry: () => {} }); } finally { stop = true; await Promise.all(loops); }
  assert.deepEqual(errors, []);
  assert.ok(reads > 0);
});
