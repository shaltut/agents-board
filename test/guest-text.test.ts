// #4356: a guest's text (an answer, a send-back note, a log line) reaches a session as instructions-shaped text, so the
// invisible format characters (\p{Cf}: zero-width, bidi overrides, tag characters) are taken out where it is written.
// What the owner and admins write is theirs and stays as typed. And the text every session is served (prompts, the kit,
// the cb manual, CLAUDE.md) carries none of them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, onProject } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

// review I3: the Unicode 17 Cf class, pinned here as cb.guest_text writes it (21 ranges, 170 code points). The SQL
// test uses this list, so every range is tested whatever Node's tables are; a separate pure test compares it with this
// Node's \p{Cf}, and when that fails after a Node upgrade the fix is to regenerate both.
const CF17: [number, number][] = [[0xad, 0xad], [0x600, 0x605], [0x61c, 0x61c], [0x6dd, 0x6dd], [0x70f, 0x70f], [0x890, 0x891], [0x8e2, 0x8e2], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0001, 0xe0001], [0xe0020, 0xe007f]];
const CF = CF17.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i))).join('');
const HIDDEN = `Ship it${CF}today`;

test('the pinned class is exactly this Node\'s \\p{Cf}', () => {
  assert.equal([...CF].length, 170);
  const node = Array.from({ length: 0x110000 }, (_, c) => c).filter((c) => !(c >= 0xd800 && c <= 0xdfff))
    .map((c) => String.fromCodePoint(c)).filter((x) => /\p{Cf}/u.test(x)).join('');
  assert.equal(node, CF, `Node ${process.versions.node} (Unicode ${process.versions.unicode}) knows a different Cf set: ` +
    'regenerate CF17 here and the class in cb.guest_text (db/schema.sql) from it');
});

const ask = async (sql: any, to: string | null) =>
  Number((await sql`select cb.ask(project => 'demo', body => 'Ship #12 today?', options => ${sql.json(['Yes', 'No'])},
    actor => 'W1@test', to_user => ${to}) as q`)[0].q);

test('a guest answer, send-back note and log line lose every format character', async () => {
  const sql = await db();
  await sql`select cb.user_add('cai', 'Cai')`; await onProject(sql, 'cai', 'demo');
  const a = await ask(sql, 'cai');
  await sql`select cb.answer(${String(a)}, ${HIDDEN}, 'cai')`;
  const [{ answer }] = await sql`select answer from cb.questions where id = ${a}`;
  assert.equal(answer, 'Ship ittoday');

  const b = await ask(sql, 'cai');
  await sql`select cb.send_back(${String(b)}, 'details', ${HIDDEN}, 'cai')`;
  const [{ note }] = await sql`select sent_back->>'note' as note from cb.questions where id = ${b}`;
  assert.equal(note, 'Ship ittoday');

  const [{ t }] = await sql`insert into cb.tasks (project, title, assignee) values ('demo', 'a task', 'cai') returning id as t`;
  await sql`select cb.log('demo', ${HIDDEN}, ${String(t)}, '{}', 'cai')`;
  const [{ summary }] = await sql`select summary from cb.events where actor = 'cai' and kind = 'note' order by id desc limit 1`;
  assert.equal(summary, 'Ship ittoday');
});

// review I2: a terminal reads control characters (an ESC sequence recolours, moves the cursor, rewrites the line; \r
// returns to its start), so a guest's text loses C0 and C1 controls too; a line break stays one line break (\n), and
// the relay indents every continuation line. A tab stays.
test('a guest answer and log line lose control characters; a line break stays \\n', async () => {
  const sql = await db();
  await sql`select cb.user_add('cai', 'Cai')`; await onProject(sql, 'cai', 'demo');
  const typed = 'Yes\x1b[2K\x1b[1A\rred\x07\x08 and\r\nnext\rline\u0085end\tok\x7f\x9b';
  const q = await ask(sql, 'cai');
  await sql`select cb.answer(${String(q)}, ${typed}, 'cai')`;
  const [{ answer }] = await sql`select answer from cb.questions where id = ${q}`;
  assert.equal(answer, 'Yes[2K[1A\nred and\nnext\nline\nend\tok');
  const [{ t }] = await sql`insert into cb.tasks (project, title, assignee) values ('demo', 'a task', 'cai') returning id as t`;
  await sql`select cb.log('demo', ${typed}, ${String(t)}, '{}', 'cai')`;
  const [{ summary }] = await sql`select summary from cb.events where actor = 'cai' and kind = 'note' order by id desc limit 1`;
  assert.equal(summary, 'Yes[2K[1A\nred and\nnext\nline\nend\tok');
  // the name as any caller spells it (review M1)
  const [{ g }] = await sql`select cb.guest_text(' Cai ', ${'a\u200bb'}) as g`;
  assert.equal(g, 'ab');
});

test('a guest whose whole text is format characters has written nothing', async () => {
  const sql = await db();
  await sql`select cb.user_add('cai', 'Cai')`; await onProject(sql, 'cai', 'demo');
  const b = await ask(sql, 'cai');
  await assert.rejects(sql`select cb.send_back(${String(b)}, 'clarify', ${'\u200b\u202e'}, 'cai')`, /clarify needs/);
});

test('the owner and admins keep what they typed (an emoji joiner, a right-to-left mark)', async () => {
  const sql = await db();
  await sql`select cb.user_add('ana', 'Ana', null, 'admin')`;
  const typed = 'نعم\u200f, ship 👩\u200d💻';
  for (const who of ['ahmed', 'ana']) {
    const q = await ask(sql, null);
    await sql`select cb.answer(${String(q)}, ${typed}, ${who})`;
    const [{ answer }] = await sql`select answer from cb.questions where id = ${q}`;
    assert.equal(answer, typed, who);
  }
});

test('nothing served to every session hides a format character', () => {
  const files: string[] = [];
  const walk = (p: string) => statSync(p).isDirectory() ? readdirSync(p).forEach((f) => walk(join(p, f))) : files.push(p);
  // db/schema.sql too: the class that strips them is written as \u escapes, never as the characters (review I1)
  for (const p of ['prompts', 'kit', 'hooks', 'cli/help.ts', 'CLAUDE.md', 'AGENTS.md', 'db/schema.sql']) {
    try { walk(fileURLToPath(new URL(`../${p}`, import.meta.url))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  assert.ok(files.length > 10);
  assert.ok(files.some((f) => f.endsWith('schema.sql')));
  const bad = files.filter((f) => /\.(md|mjs|ts|json|txt|sql)$/.test(f))
    // U+FEFF only as a byte-order mark at the very start is fine; anywhere else it hides
    .filter((f) => /\p{Cf}/u.test(readFileSync(f, 'utf8').replace(/^\ufeff/, '')));
  assert.deepEqual(bad, []);
});
