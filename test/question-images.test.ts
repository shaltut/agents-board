import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, onProject, TEST_URL } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');
const { compose } = await import('../server/telegram.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }

// A real 1x1 PNG, and the first bytes of the other types we take.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

async function asked(sql: any, actor = 'W1') {
  const [{ q }] = await sql`select cb.ask(project => 'demo', body => 'Which header?', options => ${sql.json(['A', 'B'])}, actor => ${actor}) as q`;
  return String(q);
}
const add = (sql: any, id: string, data: Buffer, caption: string | null = null, actor = 'W1', replace_all = false) =>
  sql`select cb.question_image_add(id => ${id}, data => ${data}, caption => ${caption}, replace_all => ${replace_all}, actor => ${actor}) as i`;

test('pictures are optional: a question without any has none', async () => {
  const sql = await db();
  const q = await asked(sql);
  const rows = await (await app.request('/api/questions')).json();
  assert.equal(rows.find((r: any) => String(r.id) === q).images, null);
});

test('a picture keeps its order and caption; its type comes from its bytes', async () => {
  const sql = await db();
  const q = await asked(sql);
  await add(sql, `Q${q}`, PNG, ' Now ');
  await add(sql, q, JPEG, 'After');
  await add(sql, q, WEBP);
  const rows = await sql`select ord, caption, mime from cb.question_images where question_id = ${Number(q)} order by ord`;
  assert.deepEqual(rows.map((r: any) => [r.ord, r.caption, r.mime]),
    [[1, 'Now', 'image/png'], [2, 'After', 'image/jpeg'], [3, null, 'image/webp']]);
  const [listed] = (await (await app.request('/api/questions')).json()).filter((r: any) => String(r.id) === q);
  assert.deepEqual(listed.images.map((i: any) => i.caption), ['Now', 'After', null]);
  assert.ok(!('data' in listed.images[0]), 'the list carries ids and captions, never the bytes');
});

test('only a picture is taken: not HTML, not empty, not over 5 MB', async () => {
  const sql = await db();
  const q = await asked(sql);
  await assert.rejects(add(sql, q, HTML), /not a PNG, JPEG, WebP or GIF/);
  await assert.rejects(add(sql, q, Buffer.alloc(0)), /empty/);
  await assert.rejects(add(sql, q, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])), /5 MB at most/);
});

test('only the asker adds pictures, and only while the question waits for its answer', async () => {
  const sql = await db();
  const q = await asked(sql);
  await assert.rejects(add(sql, q, PNG, null, 'W2'), /asked by W1: only its asker/);
  await sql`select cb.answer(${q}, 'A')`;
  await assert.rejects(add(sql, q, PNG), /already answered/);
});

test('at most 6 pictures; replace_all starts over', async () => {
  const sql = await db();
  const q = await asked(sql);
  for (let i = 0; i < 6; i++) await add(sql, q, PNG, `p${i}`);
  await assert.rejects(add(sql, q, PNG), /already has 6 pictures/);
  await add(sql, q, JPEG, 'fresh', 'W1', true);
  const rows = await sql`select ord, caption from cb.question_images where question_id = ${Number(q)}`;
  assert.deepEqual(rows.map((r: any) => [r.ord, r.caption]), [[1, 'fresh']]);
});

test('"Show me" sends a question back for pictures; the asker rewrites it with only pictures', async () => {
  const sql = await db();
  const q = await asked(sql);
  await sql`select cb.send_back(${q}, 'visual')`;
  const [sb] = await sql`select status, sent_back ->> 'reason' as reason from cb.questions where id = ${Number(q)}`;
  assert.deepEqual([sb.status, sb.reason], ['sent_back', 'visual']);
  const session = postgres(TEST_URL, { onnotice: () => {} }); // the asker's session, not the dashboard
  try {
    await assert.rejects(session`select cb.reask(id => ${q}, body => 'Which header, really?', actor => 'W1')`, /sent back with "Show me": rewrite it with pictures/);
    // a picture from an earlier transaction doesn't count: the rewrite must bring new ones
    await add(session, q, PNG, 'old');
    await assert.rejects(session`select cb.reask(id => ${q}, actor => 'W1')`, /sent back with "Show me"/);
    // as cb reask -i does: the pictures, then the rewrite, in one transaction
    await session.begin(async (tx: any) => {
      await add(tx, q, PNG, 'Now', 'W1', true);
      await tx`select cb.reask(id => ${q}, actor => 'W1')`;
    });
  } finally { await session.end(); }
  const [row] = await sql`select status, versions -> -1 ->> 'reason' as reason from cb.questions where id = ${Number(q)}`;
  assert.deepEqual([row.status, row.reason], ['open', 'visual']);
  const [e] = await sql`select summary from cb.events where kind = 'rewritten'`;
  assert.match(e.summary, /\(with pictures\)/);
  assert.equal((await sql`select count(*)::int as n from cb.question_images where question_id = ${Number(q)}`)[0].n, 1);
});

test('a rewrite with nothing new, not even pictures, is refused', async () => {
  const sql = await db();
  const q = await asked(sql);
  await assert.rejects(sql`select cb.reask(id => ${q}, actor => 'W1')`, /nothing to rewrite: .* -i pictures/);
});

test('the picture route serves the bytes with their type, kept an image', async () => {
  const sql = await db();
  const q = await asked(sql);
  const [{ i }] = await add(sql, q, PNG, 'Now');
  const res = await app.request(`/api/questions/${q}/images/${i}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.equal((await app.request(`/api/questions/${Number(q) + 1}/images/${i}`)).status, 404, 'a picture only under its own question');
});

// Guests reach the board through a tunnel (as in server.test.ts).
const remote = (path: string, cookie?: string) =>
  app.request(path, { headers: { 'x-forwarded-for': '1.2.3.4', host: 'abc.ngrok-free.app', ...(cookie ? { cookie: `cb_user=${cookie}` } : {}) } });

test('a guest sees the pictures of a question handed to them, and no other', async () => {
  const sql = await db();
  const [{ token }] = await sql`select cb.user_add('cai', 'Cai') as token`;
  await onProject(sql, 'cai', 'demo');
  const [{ q: mine }] = await sql`select cb.ask(project => 'demo', body => 'Yours', to_user => 'cai', actor => 'W1') as q`;
  const [{ q: theirs }] = await sql`select cb.ask(project => 'demo', body => 'Ahmed''s', actor => 'W1') as q`;
  const [{ i: a }] = await add(sql, String(mine), PNG);
  const [{ i: b }] = await add(sql, String(theirs), PNG);
  assert.equal((await remote(`/api/questions/${mine}/images/${a}`)).status, 401, 'signed out: nothing');
  assert.equal((await remote(`/api/questions/${mine}/images/${a}`, token)).status, 200);
  assert.equal((await remote(`/api/questions/${theirs}/images/${b}`, token)).status, 403);
  const me = await (await remote('/api/me', token)).json();
  assert.equal(me.questions[0].images.length, 1);
});

test('Telegram says a question has pictures and offers "Show me"', () => {
  const q = { id: 7, project: 'demo', asked_by: 'W1', body: 'Which header?', context: null, multi: false,
    options: [{ label: 'A', description: null }], pictures: 2 };
  const m = compose(q);
  assert.match(m.text, /2 pictures with this question: see them on the board/);
  assert.ok(m.reply_markup.inline_keyboard.flat().some((b: any) => b.text === 'Show me' && b.callback_data === 'b:7:visual'));
  assert.doesNotMatch(compose({ ...q, pictures: 0 }).text, /picture/);
});
