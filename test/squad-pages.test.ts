import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function seed() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.tasks (project, title) values ('demo', 'x')`;
  return sql;
}

test('page_set: versions every real save, ignores an identical one, refuses secrets', async () => {
  const sql = await seed();
  const set = async (body: string, extra = '') => (await sql.unsafe(`select cb.page_set($1, task => '1'${extra}, actor => 'W1@mac') as v`, [body]))[0].v;
  assert.equal(await set('design one'), 1);
  assert.equal(await set('design one'), 1);
  assert.equal(await set('design two'), 2);
  assert.equal((await sql`select count(*)::int as n from cb.page_versions`)[0].n, 2);
  assert.equal((await sql`select count(*)::int as n from cb.events where task_id = 1 and summary = 'design page v2'`)[0].n, 1);
  await assert.rejects(() => set('see password=Hunter2!x here'), /pages are on the board/);
  await assert.rejects(() => set('   '), /empty/);
  await assert.rejects(() => set('x', `, area => 'api', project => 'demo'`), /one of/);
  assert.equal((await sql`select cb.page_set('area text', area => 'api', project => 'demo', actor => 'W1@mac') as v`)[0].v, 1);
});

test('page_get: current, a given version, and the approved one', async () => {
  const sql = await seed();
  await sql`select cb.page_set('v1 text', task => '1', actor => 'W1@mac')`;
  await sql`select cb.page_set('v2 text', task => '1', actor => 'W1@mac')`;
  await sql`update cb.tasks set approved_version = 1`;
  const g = (await sql`select cb.page_get(task => '1') as g`)[0].g;
  assert.equal(g.version, 2);
  assert.equal(g.approved_version, 1);
  assert.equal(g.approved_body, 'v1 text');
  assert.equal((await sql`select cb.page_get(task => '1', version => 1) as g`)[0].g.body, 'v1 text');
  assert.equal((await sql`select cb.page_get(task => '99') as g`)[0].g, null);
});

test('cb page set -f reads a long multi-line file', async () => {
  const sql = await seed();
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n').padEnd(12000, 'y');
  const f = join(tmpdir(), `cb-page-${process.pid}.md`);
  writeFileSync(f, text);
  try {
    const r = spawnSync('node', ['cli/cb.ts', 'page', 'set', '1', '-f', f], { encoding: 'utf8',
      env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', CB_MACHINE: 'mac', CLAUDE_CODE_MESSAGING_SOCKET: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((await sql`select cb.page_get(task => '1') as g`)[0].g.body, text);
    const s = spawnSync('node', ['cli/cb.ts', 'page', 'show', '1'], { encoding: 'utf8',
      env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', CB_MACHINE: 'mac', CLAUDE_CODE_MESSAGING_SOCKET: '' } });
    assert.match(s.stdout, /^design page for #1, v1 · W1@test · /);
  } finally { rmSync(f, { force: true }); }
});
