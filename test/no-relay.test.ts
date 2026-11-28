// #4860: a seat started by hand, past cb squad up, has no relay and its name stays bound to the pane that had it before.
// Messages to it waited up to 24 h and nothing named it. cb sessions and cb tick do.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

function cb(args: string[]) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'orch@pc', HERDR_PANE_ID: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// a live lead; every other seat is added by the test
async function setup() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo'), cb.ensure_project('other')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('pc', 'p0', 'orch@pc', 'demo', 'lead')`;
  return sql;
}
// a binding whose relay last checked in this long ago
const bound = (sql: any, actor: string, pane: string, ago: string, project = 'demo') => sql`
  insert into cb.sessions (machine, pane, actor, project, role, last_seen, broadcast_seen)
  values ('pc', ${pane}, ${actor}, ${project}, 'reviewer', now() - ${ago}::interval, coalesce((select max(id) from cb.events), 0))`;
const wrote = (sql: any, actor: string, ago = '0 seconds', project = 'demo') => sql`
  insert into cb.events (actor, project, kind, summary, at) values (${actor}, ${project}, 'note', 'working', now() - ${ago}::interval)`;
const told = (sql: any, to: string) => sql`select cb.tell(${to}, 'please review', 'orch@pc')`;
const card = (sql: any, assignee: string) => sql`
  select cb.task_add(project => 'demo', title => 'held', status => 'in_progress', assignee => ${assignee}, actor => 'orch@pc')`;
const of = async (sql: any, actor: string) => (await sql`select cb.sessions_overview('demo') as o`)[0].o.find((x: any) => x.actor === actor)?.unreachable;
const listed = async (sql: any, project: string | null = 'demo') => (await sql`select cb.tick(${project}, 'orch@pc') as t`)[0].t.no_relay.map((x: any) => x.actor);

test('a seat writing past the last beat of its binding is named, with the pane it is still bound to', async () => {
  const sql = await setup();
  await bound(sql, 'demo-R1@pc', 'w6:pF', '4 days');
  await wrote(sql, 'demo-R1@pc');
  const u = await of(sql, 'demo-R1@pc');
  assert.deepEqual([u.pane, u.machine, u.wrote_mins, u.waiting], ['w6:pF', 'pc', 0, 0]);
  assert.ok(u.relay_mins >= 5759, String(u.relay_mins));
  assert.deepEqual(await listed(sql), ['demo-R1@pc']);

  const tick = cb(['tick', 'demo']);
  assert.match(tick, /SEATS WITH NO RELAY/);
  assert.match(tick, /demo-R1@pc has no relay: wrote to the board 0m ago.*w6:pF@pc.*→ cb squad up demo/);
  const sessions = cb(['sessions', 'demo']);
  assert.match(sessions, /demo-R1@pc[^\n]* no relay[^\n]*\n\s+⚠ messages to it wait: wrote to the board 0m ago.*w6:pF@pc.*cb squad up demo/);
});

test('a seat with messages waiting is named though it writes nothing, until they are delivered', async () => {
  const sql = await setup();
  await bound(sql, 'demo-R2@pc', 'wM:p3', '2 hours');
  await told(sql, 'demo-R2@pc');
  await told(sql, 'demo-R2@pc');
  assert.deepEqual([(await of(sql, 'demo-R2@pc')).waiting, (await of(sql, 'demo-R2@pc')).wrote_mins], [2, null]);
  assert.match(cb(['tick', 'demo']), /demo-R2@pc has no relay: 2 messages waiting/);
  assert.match(cb(['sessions', 'demo']), /demo-R2@pc[^\n]*\n\s+⚠ messages to it wait: 2 messages waiting/);
  await sql`select cb.broadcast_seen('pc', 'wM:p3', (select max(id) from cb.events))`;
  assert.equal(await of(sql, 'demo-R2@pc'), null);
  assert.deepEqual(await listed(sql), []);
});

test('a seat with a relay, and one that stopped with nothing after its last beat, are not named', async () => {
  const sql = await setup();
  await bound(sql, 'demo-B1@pc', 'p1', '20 seconds');
  await wrote(sql, 'demo-B1@pc');
  await told(sql, 'demo-B1@pc'); // not delivered yet: its relay is up
  // closed 10 minutes ago, after its last write
  await bound(sql, 'demo-B2@pc', 'p2', '10 minutes');
  await wrote(sql, 'demo-B2@pc', '12 minutes');
  assert.deepEqual([await of(sql, 'demo-B1@pc'), await of(sql, 'demo-B2@pc'), await listed(sql)], [null, null, []]);
  assert.doesNotMatch(cb(['sessions', 'demo']), /⚠ messages to it wait/);
  assert.equal(cb(['tick', 'demo']).includes('SEATS WITH NO RELAY'), false);
});

test('a name never bound is named when it holds work and writes; a writer holding nothing is not, nor the board itself', async () => {
  const sql = await setup();
  await card(sql, 'demo-B3@pc');
  await wrote(sql, 'demo-B3@pc');
  await wrote(sql, 'fault-filer');
  await wrote(sql, 'board');
  await wrote(sql, 'supervisor');
  const u = await of(sql, 'demo-B3@pc');
  assert.deepEqual([u.pane, u.relay_mins, u.wrote_mins], [null, null, 0]);
  assert.deepEqual(await listed(sql), ['demo-B3@pc']);
  assert.match(cb(['tick', 'demo']), /demo-B3@pc has no relay: wrote to the board 0m ago; never bound to a pane/);
});

test("tick names its own project's seats, every enabled project's when none is given, and none of a disabled one", async () => {
  const sql = await setup();
  await bound(sql, 'other-R1@pc', 'p5', '1 hour', 'other');
  await wrote(sql, 'other-R1@pc', '0 seconds', 'other');
  assert.deepEqual(await listed(sql, 'demo'), []);
  assert.deepEqual(await listed(sql, 'other'), ['other-R1@pc']);
  assert.deepEqual(await listed(sql, null), ['other-R1@pc']);
  await sql`select cb.project_state('other', 'disabled', 'ahmed')`;
  assert.deepEqual([await listed(sql, null), await listed(sql, 'other')], [[], []]);
});
