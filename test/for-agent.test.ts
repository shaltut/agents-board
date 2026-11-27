// #4593: a for:<agent> label keeps a Next card for seats of that agent; cb next skips it for the others and says so.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() {
  const s = await freshDb(); clients.push(s);
  await s`select cb.ensure_project('demo')`;
  await s`insert into cb.sessions (machine, pane, actor, project, agent) values ('pc', 'p1', 'C1@pc', 'demo', 'claude'), ('pc', 'p2', 'X1@pc', 'demo', 'codex')`;
  return s;
}
const add = async (sql: any, title: string, labels: string[], assignee: string | null = null) =>
  Number((await sql`select cb.task_add(project => 'demo', title => ${title}, status => 'next', labels => ${sql.json(labels)}, assignee => ${assignee})`)[0].task_add);
const claim = async (sql: any, a: string) => (await sql`select * from cb.task_claim('demo', ${a})`)[0]?.title ?? null;

test('a for:codex card goes to a codex seat, never to a claude one; an unmarked card to either', async () => {
  const sql = await db();
  await add(sql, 'codex only', ['for:codex']);
  assert.equal(await claim(sql, 'C1@pc'), null, 'claude seat skips it');
  assert.equal(await claim(sql, 'X1@pc'), 'codex only');
  await add(sql, 'anyone', []);
  assert.equal(await claim(sql, 'C1@pc'), 'anyone');
});

test('several for: labels mean any of them; an actor with no session counts as claude; the assignee always may', async () => {
  const sql = await db();
  await add(sql, 'codex or claude', ['for:codex', 'for:claude']);
  assert.equal(await claim(sql, 'Nobody@pc'), 'codex or claude', 'no session: claude');
  await add(sql, 'agy, kept for C1', ['for:agy'], 'C1@pc');
  assert.equal(await claim(sql, 'C1@pc'), 'agy, kept for C1');
});

test('a for: label naming no agent is refused where labels are saved; a card already holding one still saves', async () => {
  const sql = await db();
  await assert.rejects(add(sql, 'typo', ['for:codx']), /for:codx.*claude, codex, opencode, agy/);
  const id = await add(sql, 'ok', ['for:codex']);
  await assert.rejects(sql`select cb.task_tag(${String(id)}, ${sql.json(['For:Gemini'])})`, /for:gemini/);
  await assert.rejects(sql`select cb.task_update(${String(id)}, ${sql.json({ labels: ['for:'] })})`, /for:/);
  // a bad label already on a card (from before this rule) does not block other changes to it
  await sql`alter table cb.tasks disable trigger tasks_before`;
  await sql`update cb.tasks set labels = '{for:old}' where id = ${id}`;
  await sql`alter table cb.tasks enable trigger tasks_before`;
  await sql`select cb.task_update(${String(id)}, ${sql.json({ title: 'renamed' })})`;
});

test('cb next with nothing to claim names the cards it skipped for another agent', async () => {
  const sql = await db();
  const id = await add(sql, 'codex only', ['for:codex', 'for:agy']);
  const r = spawnSync('node', ['cli/cb.ts', 'next', 'demo'], { encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'C1@pc', HERDR_PANE_ID: '' } });
  assert.equal(r.stdout.trim(), `nothing to claim (skipped #${id}: for agy or codex)`, r.stderr);
});
