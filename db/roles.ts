// Role texts (#3599): prompts/roles/*.md go into cb.role_texts, so every machine reads the same copy from the board.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROLES = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'];

/** Upserts the known role files (and _common.md) by stem; deletes rows whose file is gone. Other *.md files are ignored. */
export async function loadRoleTexts(sql: any, dir: string) {
  const stems = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    .filter((s) => s === '_common' || ROLES.includes(s));
  if (!stems.length) return; // a missing or empty folder must not wipe the board's texts
  for (const s of stems) {
    const body = readFileSync(join(dir, `${s}.md`), 'utf8').trim();
    await sql`insert into cb.role_texts (role, body) values (${s}, ${body})
      on conflict (role) do update set body = excluded.body, updated_at = now() where cb.role_texts.body is distinct from excluded.body`;
  }
  await sql`delete from cb.role_texts where role <> all (${stems})`;
}
