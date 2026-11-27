// #4525 (and #4350): every text a seat is handed fits where it is printed, uncut. The binding limit is the start hook's
// re-injection after a compaction (CAP and RESUME_KEEP in hooks/session-start.mjs, read here from its source): a seat
// that holds cards gets at most ROLE_ROOM characters for what cb role prints, which is the board-wide text, its
// project's addition (capped at 1000) and the ask-first line. cb role itself prints everything; cb.role_text_set caps a
// stored text at 8000. Lengths are JS lengths, as the hook counts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

const ROLES = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'];
const file = (r: string) => readFileSync(`prompts/roles/${r}.md`, 'utf8').trim();
const hook = readFileSync('hooks/session-start.mjs', 'utf8');
const num = (name: string) => Number(hook.match(new RegExp(`^const ${name} = (\\d+);`, 'm'))?.[1]);
const CAP = num('CAP'), RESUME_KEEP = num('RESUME_KEEP'), ROLE_ROOM = CAP - RESUME_KEEP;

test('the hook\'s numbers: the role gets what the cards leave (CAP - RESUME_KEEP), and the hook uses both', () => {
  assert.ok(CAP > 0 && RESUME_KEEP > 0, 'the hook still says const CAP = <n>; and const RESUME_KEEP = <n>;');
  assert.equal(ROLE_ROOM, 6000);
  assert.match(hook, /Math\.min\(role\.length, CAP - Math\.min\(resume\.length, RESUME_KEEP\)\)/);
  assert.match(hook, /cb\.role_text\(\$\{r\.role\}, \$\{r\.project \?\? null\}, \$\{r\.actor \?\? null\}\)/, 'the hook reads the text with the seat\'s project and name, as cb role does');
});

test('every role, with the longest project addition and ask-first line, fits what the hook re-injects', async () => {
  const sql = await db();
  const slug = 'a-rather-long-project-slug-for-sizes';
  await sql`select cb.ensure_project(${slug})`;
  const sizes: string[] = [];
  for (const who of ['lead', 'ahmed', `${'S'.repeat(56)}@machine`]) { // the named one at the 64-character cap
    await sql`select cb.project_role_set(${slug}, ${'x'.repeat(1000)}, ${who}, 'ahmed')`;
    for (const r of ROLES) {
      // read by another seat, and by the one asked first itself
      for (const actor of [null, who]) {
        const [{ t }] = await sql`select cb.role_text(${r}, ${slug}, ${actor}) as t`;
        assert.ok(t.length <= ROLE_ROOM, `${r} with ask first ${who.slice(0, 8)}: ${t.length} > ${ROLE_ROOM}`);
      }
      const [{ t }] = await sql`select cb.role_text(${r}, ${slug}) as t`;
      if (who === 'lead') sizes.push(`${r} ${t.length}`);
    }
  }
  console.log(`# worst case served (addition 1000): ${sizes.join(', ')} of ${ROLE_ROOM}`);
});

test('the board-wide seeds: each served text leaves room for the addition, and stays under the stored-text cap', () => {
  const common = file('_common');
  for (const r of ROLES) {
    const served = common.length + 2 + file(r).length;
    assert.ok(served <= ROLE_ROOM - 1300, `${r} serves ${served}: over ${ROLE_ROOM - 1300}, the room left for a 1000-character addition`);
    assert.ok(file(r).length <= 8000);
  }
});

test('the session text (#4350) is a short core that points at cb help', () => {
  const s = readFileSync('prompts/session.md', 'utf8').trim();
  assert.ok(s.length <= 1600, `prompts/session.md is ${s.length} characters: keep it a ~1.5 KB core and move detail to cb help`);
  assert.match(s, /`cb help rules`/);
});
