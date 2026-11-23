// Role texts (#3599): prompts/roles/*.md go into cb.role_texts, so every machine reads the same copy from the board.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Upserts every *.md in dir by file stem and deletes rows whose file is gone. */
export async function loadRoleTexts(sql: any, dir: string) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const roles = files.map((f) => f.slice(0, -3));
  for (const f of files) {
    const body = readFileSync(join(dir, f), 'utf8').trim();
    await sql`insert into cb.role_texts (role, body) values (${f.slice(0, -3)}, ${body})
      on conflict (role) do update set body = excluded.body, updated_at = now() where cb.role_texts.body is distinct from excluded.body`;
  }
  await sql`delete from cb.role_texts where role <> all (${roles})`;
}
