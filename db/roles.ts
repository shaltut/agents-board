// Role texts (#3599): every machine reads the same copy from the board (cb.role_texts). The database owns them (#4332,
// Q2969): Ahmed edits them on the project settings page (cb.role_text_set), and prompts/roles/*.md only seed a role that
// has no row yet (a fresh board, or a role added later).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROLES = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'];

/** Inserts the known role files (and _common.md) by stem for each role with no row. Never overwrites an edited text and
 *  never deletes a row, whatever the folder holds. Other *.md files are ignored. */
export async function loadRoleTexts(sql: any, dir: string) {
  const stems = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    .filter((s) => s === '_common' || ROLES.includes(s));
  for (const s of stems) {
    const body = readFileSync(join(dir, `${s}.md`), 'utf8').trim();
    await sql`insert into cb.role_texts (role, body) values (${s}, ${body}) on conflict (role) do nothing`;
  }
}
