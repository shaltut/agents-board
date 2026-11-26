// #4356: a guest's text (an answer, a send-back note, a log line) reaches a session as instructions-shaped text, so the
// invisible format characters (\p{Cf}: zero-width, bidi overrides, tag characters) are taken out where it is written.
// What the owner and admins write is theirs and stays as typed. And the text every session is served (prompts, the kit,
// the cb manual, CLAUDE.md) carries none of them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, onProject } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

// every \p{Cf} code point this Node knows, so a class written out by hand in SQL is checked against the real category
const CF = Array.from({ length: 0x110000 }, (_, c) => c).filter((c) => !(c >= 0xd800 && c <= 0xdfff))
  .map((c) => String.fromCodePoint(c)).filter((s) => /\p{Cf}/u.test(s)).join('');
const HIDDEN = `Ship it${CF}today`;

const ask = async (sql: any, to: string | null) =>
  Number((await sql`select cb.ask(project => 'demo', body => 'Ship #12 today?', options => ${sql.json(['Yes', 'No'])},
    actor => 'W1@test', to_user => ${to}) as q`)[0].q);

test('a guest answer, send-back note and log line lose every format character', async () => {
  const sql = await db();
  assert.ok(CF.length > 150, `this Node knows ${CF.length} Cf code points`);
  await sql`select cb.user_add('omar', 'Omar')`; await onProject(sql, 'omar', 'demo');
  const a = await ask(sql, 'omar');
  await sql`select cb.answer(${String(a)}, ${HIDDEN}, 'omar')`;
  const [{ answer }] = await sql`select answer from cb.questions where id = ${a}`;
  assert.equal(answer, 'Ship ittoday');

  const b = await ask(sql, 'omar');
  await sql`select cb.send_back(${String(b)}, 'details', ${HIDDEN}, 'omar')`;
  const [{ note }] = await sql`select sent_back->>'note' as note from cb.questions where id = ${b}`;
  assert.equal(note, 'Ship ittoday');

  const [{ t }] = await sql`insert into cb.tasks (project, title, assignee) values ('demo', 'a task', 'omar') returning id as t`;
  await sql`select cb.log('demo', ${HIDDEN}, ${String(t)}, '{}', 'omar')`;
  const [{ summary }] = await sql`select summary from cb.events where actor = 'omar' and kind = 'note' order by id desc limit 1`;
  assert.equal(summary, 'Ship ittoday');
});

test('a guest whose whole text is format characters has written nothing', async () => {
  const sql = await db();
  await sql`select cb.user_add('omar', 'Omar')`; await onProject(sql, 'omar', 'demo');
  const b = await ask(sql, 'omar');
  await assert.rejects(sql`select cb.send_back(${String(b)}, 'clarify', ${'\u200b\u202e'}, 'omar')`, /clarify needs/);
});

test('the owner and admins keep what they typed (an emoji joiner, a right-to-left mark)', async () => {
  const sql = await db();
  await sql`select cb.user_add('iman', 'Iman', null, 'admin')`;
  const typed = 'نعم\u200f, ship 👩\u200d💻';
  for (const who of ['ahmed', 'iman']) {
    const q = await ask(sql, null);
    await sql`select cb.answer(${String(q)}, ${typed}, ${who})`;
    const [{ answer }] = await sql`select answer from cb.questions where id = ${q}`;
    assert.equal(answer, typed, who);
  }
});

test('nothing served to every session hides a format character', () => {
  const files: string[] = [];
  const walk = (p: string) => statSync(p).isDirectory() ? readdirSync(p).forEach((f) => walk(join(p, f))) : files.push(p);
  for (const p of ['prompts', 'kit', 'hooks', 'cli/help.ts', 'CLAUDE.md', 'AGENTS.md']) {
    try { walk(new URL(`../${p}`, import.meta.url).pathname); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  assert.ok(files.length > 10);
  const bad = files.filter((f) => /\.(md|mjs|ts|json|txt)$/.test(f))
    // U+FEFF only as a byte-order mark at the very start is fine; anywhere else it hides
    .filter((f) => /\p{Cf}/u.test(readFileSync(f, 'utf8').replace(/^\ufeff/, '')));
  assert.deepEqual(bad, []);
});
