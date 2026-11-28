// #3222 S1a: the functions cb's own SQL became. The CLI suites pin what each command prints; this pins what only the
// functions can get wrong: no read hands out a sign-in secret, rows keep their types, and cb ask and cb reask are still
// all or nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts';
import { OPS } from '../server/ops.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const NOT_A_PICTURE = Buffer.from('<html></html>').toString('base64');

async function board() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('pc', 'p1', 'B1@pc', 'demo', 'builder')`;
  const ask = async (over: Record<string, unknown> = {}) => {
    const a: any = { body: 'Which parser?', options: ['one', 'two'], images: [], ...over };
    const [r] = await sql`select cb.ask_post(project => 'demo', body => ${a.body}, options => ${sql.json(a.options)},
      actor => 'B1@pc', images => ${sql.json(a.images)}) as r`;
    return r.r as { id: number; again: boolean };
  };
  const count = async () => (await sql`select (select count(*)::int from cb.questions) as q, (select count(*)::int from cb.question_images) as i`)[0];
  return { sql, ask, count };
}

test('no function cb calls returns a sign-in token or a password hash', async () => {
  const { sql } = await board();
  await sql`select cb.user_add('cai', 'Cai', 'ahmed')`;
  await sql`select cb.user_password('cai', 'correct horse battery', 'ahmed')`;
  const [{ token, password }] = await sql`select token, password from cb.users where name = 'cai'`;
  const said = JSON.stringify([await sql`select * from cb.user_show('cai')`, await sql`select * from cb.users_overview()`]);
  assert.match(said, /Cai/);
  for (const secret of [token, password]) assert.ok(!said.includes(secret), 'a secret column came back');
  // and by shape, for every function cb may call that has no user row to show here
  const shapes = await sql`select p.proname, pg_get_function_result(p.oid) as result from pg_proc p
    where p.pronamespace = 'cb'::regnamespace and p.proname = any(${Object.keys(OPS)}::text[])`;
  assert.deepEqual(shapes.filter((f: any) => /\b(token|password)\b|cb\.users\b/i.test(f.result)).map((f: any) => f.proname), []);
});

test('task_row gives the card as the table holds it, dates as dates', async () => {
  const { sql } = await board();
  const [{ id }] = await sql`select cb.task_add(project => 'demo', title => 'Fix month parse', actor => 'B1@pc') as id`;
  const [direct] = await sql`select * from cb.tasks where id = ${id}`;
  const [row] = await sql`select * from cb.task_row(${id})`;
  assert.deepEqual(row, direct);
  assert.ok(row.created_at instanceof Date);
});

test('ask_post returns the open question instead of asking it twice', async () => {
  const { ask, count } = await board();
  const first = await ask();
  assert.equal(first.again, false);
  assert.deepEqual(await ask(), { id: first.id, again: true });
  assert.equal((await ask({ body: 'Which database?' })).again, false);
  assert.equal((await count()).q, 2);
});

test('ask_post stores the question and its pictures together, or neither', async () => {
  const { sql, ask, count } = await board();
  await assert.rejects(ask({ images: [{ caption: 'Now', data: PNG }, { caption: 'Broken', data: NOT_A_PICTURE }] }), /not a PNG/);
  assert.deepEqual(await count(), { q: 0, i: 0 });
  const q = await ask({ images: [{ caption: 'Now', data: PNG }, { caption: null, data: PNG }] });
  const stored = await sql`select caption, data from cb.question_images where question_id = ${q.id} order by ord`;
  assert.deepEqual(stored.map((i: any) => [i.caption, i.data.toString('base64')]), [['Now', PNG], [null, PNG]]);
  // new pictures are never dropped by the resend check
  assert.equal((await ask({ images: [{ caption: 'Now', data: PNG }] })).again, false);
});

test('reask_post replaces the pictures only when the rewrite stands', async () => {
  const { sql, ask, count } = await board();
  const q = await ask({ images: [{ caption: 'old', data: PNG }] });
  const reask = (body: string, images: unknown[]) => sql`select cb.reask_post(id => ${String(q.id)}, body => ${body}, actor => 'B1@pc',
    images => ${sql.json(images as any)})`;
  await assert.rejects(reask('Which parser now?', [{ caption: 'new', data: PNG }, { caption: 'bad', data: NOT_A_PICTURE }]), /not a PNG/);
  assert.deepEqual((await sql`select caption from cb.question_images`).map((i: any) => i.caption), ['old']);
  assert.equal((await sql`select body from cb.questions where id = ${q.id}`)[0].body, 'Which parser?');
  await reask('Which parser now?', [{ caption: 'new', data: PNG }]);
  assert.deepEqual((await sql`select caption from cb.question_images`).map((i: any) => i.caption), ['new']);
  assert.deepEqual(await count(), { q: 1, i: 1 });
});
