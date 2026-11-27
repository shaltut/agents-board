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
  assert.equal(r.stdout.trim(), `nothing to claim (skipped #${id}: waiting for an agy or Codex seat)`, r.stderr);
});

// ---- PR 100 review (C:/w/pr-review-100-night.md) ----
const pipeline = async (sql: any) => {
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`update cb.sessions set role = 'builder'`;
  await sql`insert into cb.sessions (machine, pane, actor, project, agent, role) values ('pc', 'p3', 'R1@pc', 'demo', 'claude', 'reviewer')`;
};
const staged = async (sql: any, title: string, stage: string, labels: string[]) => {
  const id = await add(sql, title, labels);
  await sql`update cb.tasks set stage = ${stage}, stage_since = now() where id = ${id}`;
  return id;
};

test('F4: a for: label naming no agent (one saved before the rule) keeps the card from nobody', async () => {
  const sql = await db();
  const id = await add(sql, 'old label', []);
  await sql`alter table cb.tasks disable trigger tasks_before`;
  await sql`update cb.tasks set labels = '{for:ahmed}' where id = ${id}`;
  await sql`alter table cb.tasks enable trigger tasks_before`;
  assert.equal(await claim(sql, 'C1@pc'), 'old label');
});

test('F2: the label binds one stage: passing the stage takes it off, with a note; entering the first stage keeps it', async () => {
  const sql = await db();
  const id = await add(sql, 'routed', ['for:codex', 'guard']); // filed before the pipeline: no stage yet
  await pipeline(sql);
  await sql`select cb._stage_move(${id}, 'build', null, 'staged')`;
  assert.deepEqual((await sql`select labels from cb.tasks where id = ${id}`)[0].labels.sort(), ['for:codex', 'guard'], 'into its first stage: kept');
  assert.equal(await claim(sql, 'C1@pc'), null, 'the claude builder skips it');
  assert.equal(await claim(sql, 'X1@pc'), 'routed');
  await sql`select cb._stage_move(${id}, 'review', null, 'built')`;
  assert.deepEqual((await sql`select labels from cb.tasks where id = ${id}`)[0].labels, ['guard'], 'passed: the mark comes off');
  const [h] = await sql`select summary as note from cb.events where task_id = ${id} order by id desc limit 1`;
  assert.match(h.note, /built.*kept for a Codex seat for one stage only/);
  assert.doesNotMatch(h.note, /for:codex/);
  assert.equal(await claim(sql, 'R1@pc'), 'routed', 'the claude reviewer takes the review');
});

test('F7: cb next names only cards the seat could take but for the label', async () => {
  const sql = await db();
  await pipeline(sql);
  const b = await staged(sql, 'build for codex', 'build', ['for:codex']);
  const rv = await staged(sql, 'review for codex', 'review', ['for:codex']);
  const skipped = async (a: string) => (await sql`select cb._for_skipped('demo', ${a}) as s`)[0].s;
  assert.equal(await skipped('C1@pc'), `#${b}: waiting for a Codex seat`, 'the builder hears of the build card only');
  assert.equal(await skipped('R1@pc'), `#${rv}: waiting for a Codex seat`, 'a reviewer never hears of a build card');
});

test('F1: supervise_state counts waiting cards kept for an agent, per role and repo, inside the waiting counts', async () => {
  const sql = await db();
  await pipeline(sql);
  await sql`update cb.projects set squad = ${sql.json({ machines: { pc: { herdr: null, repo: '/r', board: '/b' } }, roles: { builder: { count: 2, model: 'sonnet', machine: 'pc' } }, areas: [] })} where slug = 'demo'`;
  await staged(sql, 'b1', 'build', ['for:codex']);
  await staged(sql, 'b2', 'build', []);
  await staged(sql, 'b3', 'build', ['for:agy', 'for:codex']);
  await staged(sql, 'r1', 'review', ['for:codex']);
  const st = (await sql`select cb.supervise_state('demo') as r`)[0].r;
  const repo = Object.keys(st.waiting.builder)[0];
  assert.equal(st.waiting.builder[repo], 3);
  assert.deepEqual(st.kept.builder[repo], { codex: 1, 'agy,codex': 1 });
  assert.deepEqual(st.kept.reviewer[repo], { codex: 1 });
  assert.deepEqual(st.kept.qa, {});
});

test('F3: the digest says in plain words which seat a kept card waits for, never the raw label', async () => {
  const sql = await db();
  await pipeline(sql);
  const a = await staged(sql, 'built by codex', 'build', ['for:codex']);
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  await sql`update cb.tasks set stage = null where id = ${a}`;
  const lines = ((await sql`select cb.digest('demo') as d`)[0].d as string[]).join('\n');
  assert.match(lines, new RegExp(`#${a} is waiting for a Codex seat`));
  assert.doesNotMatch(lines, /for:codex/);
});

test('F3: a card line (cb show, cb brief) names the seat in plain words, never the raw label', async () => {
  const sql = await db();
  const id = await add(sql, 'kept', ['for:codex', 'guard']);
  const r = spawnSync('node', ['cli/cb.ts', 'show', String(id)], { encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'C1@pc', HERDR_PANE_ID: '' } });
  const first = r.stdout.split('\n')[0]!;
  assert.match(first, /\{guard\} \[for a Codex seat\]/, r.stderr);
  assert.doesNotMatch(first, /for:codex/);
});
