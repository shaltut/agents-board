// #3222 S3: the two writes by which a relay says "pushed": cb.answer_delivered and cb.ask_delivered. A machine key names
// the seat it delivered to (delivered_to), which must be one of its own machine's, and an answer is marked delivered
// only by naming who it goes to: otherwise a key could mark another seat's answer delivered, and it would never arrive.
// Every key here is made by the test database and thrown away with it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_URL } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');
const { closeWorker } = await import('../server/worker.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), closeWorker(), serverSql.end()]));

/** A wiped board with seats on two machines, and a machine key for each. */
async function board() {
  await closeWorker();
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  for (const [m, p, a] of [['boxa', 'p1', 'W1@boxa'], ['boxa', 'p2', 'W2@boxa'], ['boxb', 'p1', 'W1@boxb']]) {
    await sql`select cb.iam(${m!}, ${p!}, ${a!}, 'demo')`;
  }
  const issue = async (m: string) => (await sql`select cb.key_issue(${m}, 'machine', null) as key`)[0].key as string;
  return { sql, a: await issue('boxa'), b: await issue('boxb') };
}
const call = (key: string, fn: string, args: object) => app.request(`/w/v1/call/${fn}`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ args }),
});
const outcome = async (res: Response) => [res.status, ((await res.json()) as any).error ?? ''] as [number, string];

/** An answered question, asked by W1@boxa; replyTo: the pane its answer goes to. Returns its number as text. */
async function answered(sql: any, replyTo: { machine: string; pane: string } | null = null) {
  await sql`select cb.ask(project => 'demo', body => ${`q ${Math.random()}`}, actor => 'W1@boxa', reply_to => ${replyTo ? sql.json(replyTo) : null})`;
  const [{ id }] = await sql`select max(id) as id from cb.questions`;
  await sql`select cb.answer(${String(id)}, 'yes')`;
  return String(id);
}
const status = async (sql: any, id: string) => (await sql`select status from cb.questions where id = ${id}`)[0].status;
const mark = (id: string, delivered_to: unknown, actor: unknown = 'relay') =>
  ({ id, delivered_to, actor, sent_back_at: null, answered_at: null });

test('a relay marks its own seat\'s answer delivered over the API, as "relay"', async () => {
  const { sql, a } = await board();
  const id = await answered(sql);
  assert.deepEqual(await outcome(await call(a, 'answer_delivered', mark(id, 'W1@boxa'))), [200, '']);
  const [q] = await sql`select status, delivered_to from cb.questions where id = ${id}`;
  assert.deepEqual([q.status, q.delivered_to], ['delivered', 'W1@boxa']);
});

test('a key names a seat of its own machine as delivered_to, never the owner, and cannot leave it out', async () => {
  const { sql, a, b } = await board();
  const id = await answered(sql);
  const refused: [string, string, object][] = [
    [a, 'no delivered_to', { id, actor: 'relay' }],
    [a, 'delivered_to null', mark(id, null)],
    [a, 'delivered_to not text', mark(id, ['W1@boxa'])],
    [b, 'another machine\'s seat', mark(id, 'W1@boxa')],
    [a, 'the owner', mark(id, 'ahmed@boxa')],
    [a, 'a bare name', mark(id, 'W1')],
    [a, 'another machine\'s seat, by hand', mark(id, 'W1@boxb', 'W2@boxa')],
  ];
  for (const [key, what, args] of refused) {
    const [code, said] = await outcome(await call(key, 'answer_delivered', args));
    assert.equal(code, 403, `${what}: ${said}`);
    assert.match(said, /delivered_to/, what);
  }
  assert.equal(await status(sql, id), 'answered');
});

test('"relay" is an actor as that exact word, on answer_delivered only', async () => {
  const { sql, a } = await board();
  const id = await answered(sql);
  for (const actor of ['Relay', 'relay ', 'relay@boxb', 'supervisor', 'ahmed', null]) {
    const [code, said] = await outcome(await call(a, 'answer_delivered', mark(id, 'W1@boxa', actor)));
    assert.equal(code, 403, `${actor}: ${said}`);
  }
  assert.equal((await call(a, 'task_add', { project: 'demo', title: 'x', actor: 'relay' })).status, 403);
  assert.equal(await status(sql, id), 'answered');
});

test('over the API an answer is marked delivered only to who it goes to', async () => {
  const { sql, a, b } = await board();
  const id = await answered(sql);
  for (const [key, to, actor] of [[a, 'W2@boxa', 'relay'], [a, 'W2@boxa', 'W2@boxa'], [b, 'W1@boxb', 'relay']] as const) {
    const [code, said] = await outcome(await call(key, 'answer_delivered', mark(id, to, actor)));
    assert.equal(code, 400, said);
    assert.match(said, new RegExp(`Q${id}'s answer goes to`));
  }
  assert.equal(await status(sql, id), 'answered');
});

test('an answer that replies to a pane is not the asker\'s to mark, from its machine or any other', async () => {
  const { sql, a, b } = await board();
  const id = await answered(sql, { machine: 'boxb', pane: 'p1' }); // asked by W1@boxa; the answer goes to boxb's pane
  const [code, said] = await outcome(await call(a, 'answer_delivered', mark(id, 'W1@boxa')));
  assert.equal(code, 400, said);
  assert.match(said, /answer goes to/);
  assert.equal(await status(sql, id), 'answered');
  assert.equal((await call(b, 'answer_delivered', mark(id, 'W1@boxb'))).status, 200);
});

test('who an answer goes to: the seat now in the pane it replies to or that pane\'s own name; with no pane, the asker', async () => {
  const { sql } = await board();
  const pane = { machine: 'boxa', pane: 'p2' };
  const deliver = (id: string, to: string | null) => sql`select cb.answer_delivered(${id}, ${to}, 'relay')`;
  for (const [replyTo, to] of [[pane, 'W2@boxa'], [pane, 'p2@boxa'], [{ machine: 'boxa', pane: '' }, 'W1@boxa']] as const) {
    const id = await answered(sql, replyTo);
    await deliver(id, to);
    assert.equal(await status(sql, id), 'delivered', to);
  }
  const id = await answered(sql, pane);
  for (const to of ['W1@boxa', 'W1@boxb', 'p1@boxa']) await assert.rejects(deliver(id, to), /answer goes to/, to);
  await sql`select cb.iam('boxa', 'p2', 'W3@boxa', 'demo')`; // the pane has another seat now
  await assert.rejects(deliver(id, 'W2@boxa'), /answer goes to/);
  await deliver(id, 'W3@boxa');
  assert.equal(await status(sql, id), 'delivered');
  // by hand on the database, naming nobody, it is marked as before
  const hand = await answered(sql);
  await sql`select cb.answer_delivered(${hand}, actor => 'L1@boxa')`;
  assert.equal(await status(sql, hand), 'delivered');
});

test('a send-back is marked told only for who it goes to', async () => {
  const { sql, a } = await board();
  await sql`select cb.ask(project => 'demo', body => 'which one?', actor => 'W1@boxa')`;
  const [{ id }] = await sql`select max(id) as id from cb.questions`;
  await sql`select cb.send_back(${String(id)}, 'simplify')`; // a reason that needs no note
  const told = async () => (await sql`select sent_back ->> 'delivered_to' as to from cb.questions where id = ${id}`)[0].to;
  const [code] = await outcome(await call(a, 'answer_delivered', mark(String(id), 'W2@boxa')));
  assert.equal(code, 400);
  assert.equal(await told(), null);
  assert.equal((await call(a, 'answer_delivered', mark(String(id), 'W1@boxa'))).status, 200);
  assert.equal(await told(), 'W1@boxa');
});

test('a relay marks an ask delivered over the API for its own seat only', async () => {
  const { sql, a, b } = await board();
  const [{ id }] = await sql`select cb.ask_open('W1@boxa', 'Status?', null) as id`;
  const [{ i }] = await sql`select cb.inbox('boxa', 'p1', 0) as i`;
  const args = { id: String(id), upto: i.asks[0].upto, delivered_to: 'W1@boxa', reminder: false };
  const delivered = async () => (await sql`select delivered_to from cb.asks where id = ${id}`)[0].delivered_to;
  for (const [key, wrong] of [[b, args], [a, { ...args, delivered_to: undefined }], [a, { ...args, delivered_to: 'W1@boxb' }]] as const) {
    const [code, said] = await outcome(await call(key, 'ask_delivered', wrong));
    assert.equal(code, 403, said);
    assert.match(said, /delivered_to/);
  }
  assert.equal(await delivered(), null);
  assert.equal((await call(a, 'ask_delivered', { ...args, delivered_to: 'W2@boxa' })).status, 200);
  assert.equal(await delivered(), null, 'not its recipient: nothing is marked');
  assert.equal((await call(a, 'ask_delivered', args)).status, 200);
  assert.equal(await delivered(), 'W1@boxa');
});
