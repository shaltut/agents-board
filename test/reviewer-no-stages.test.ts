// #4744: in a project without pipeline stages nothing hands a reviewer a review card, so cb next, cb start, cb pass,
// cb fail and the reviewer's role text all say how a review reaches it there: the lead hands out the pull request.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() {
  const s = await freshDb(); clients.push(s);
  await s`select cb.ensure_project('demo')`;
  await s`insert into cb.sessions (machine, pane, actor, project, agent, role) values
    ('pc', 'p1', 'B1@pc', 'demo', 'claude', 'builder'), ('pc', 'p3', 'R1@pc', 'demo', 'claude', 'reviewer')`;
  return s;
}
const inReview = async (sql: any) => {
  const id = Number((await sql`select cb.task_add(project => 'demo', title => 'built', status => 'in_progress', assignee => 'B1@pc')`)[0].task_add);
  await sql`select cb.task_move(${String(id)}, 'review', 'PR up', 'B1@pc')`;
  return id;
};
const cb = (args: string[], actor: string, env: Record<string, string> = {}) =>
  spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: actor, HERDR_PANE_ID: '', ...env } });
const WORDS = /demo has no pipeline stages.*the lead hands you pull requests \(cb tell\).*cb log <card>.*PR comment.*note reaches the builder.*only findings, never a GO again.*Never cb done/;

test('cb next tells a reviewer in a project without stages how review reaches it, and claims nothing', async () => {
  const sql = await db();
  const id = await inReview(sql);
  const r = cb(['next', 'demo'], 'R1@pc');
  assert.match(r.stdout.trim(), WORDS, r.stderr);
  assert.equal(JSON.parse(cb(['next', 'demo', '--json'], 'R1@pc').stdout), null);
  const [t] = await sql`select status, assignee from cb.tasks where id = ${id}`;
  assert.deepEqual([t.status, t.assignee], ['review', 'B1@pc'], 'the card stays its builder\'s');
});

test('a builder there, and a reviewer in a project with stages, still read "nothing to claim"', async () => {
  const sql = await db();
  assert.equal(cb(['next', 'demo'], 'B1@pc').stdout.trim(), 'nothing to claim');
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  assert.equal(cb(['next', 'demo'], 'R1@pc').stdout.trim(), 'nothing to claim');
});

test('a reviewer there with a Next card of its own still claims it', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'read PR 9', status => 'next', assignee => 'R1@pc')`;
  assert.match(cb(['next', 'demo'], 'R1@pc').stdout, /read PR 9/);
});

test('cb start tells a reviewer with an empty queue the same, not to register work', async () => {
  await db();
  const r = cb(['start'], '', { HERDR_PANE_ID: 'p3', CB_MACHINE: 'pc' });
  assert.match(r.stdout, WORDS, r.stderr);
  assert.doesNotMatch(r.stdout, /nothing queued for you/);
});

test('cb pass and cb fail send a reviewer there to the card log and the PR, never to cb done', async () => {
  const sql = await db();
  const id = await inReview(sql);
  for (const verb of ['pass', 'fail']) {
    const r = cb([verb, String(id), 'GO at abc'], 'R1@pc');
    assert.notEqual(r.status, 0, verb);
    assert.match(r.stderr, WORDS, verb);
    assert.doesNotMatch(r.stderr, /finish it with cb done/, verb);
    const b = cb([verb, String(id), 'x'], 'B1@pc');
    assert.match(b.stderr, new RegExp(`pipeline is off for demo: finish it with cb done ${id}`), `${verb} for a builder`);
  }
});

test('the reviewer role text says what to do in a project without stages', async () => {
  const sql = await db();
  const [{ t }] = await sql`select cb.role_text('reviewer') as t`;
  assert.match(t, /no stages.*the lead hands you PRs.*cb log.*PR comment.*Never `cb done`/is);
  // #4749: the lead merges from the reviewer's word, so a GO there goes to the lead too; in that bullet, not only in the
  // pipeline rule further down ("the lead only if the PR comment failed")
  const bullet = t.split('\n').find((line: string) => line.startsWith('- A project with no stages'));
  assert.match(bullet!, /On a GO.*tell the lead too.*PR.*full head sha.*merge/);
});
