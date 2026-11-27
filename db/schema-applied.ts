// The schema a database runs (#4352): db/setup.ts notes it after each apply in cb.schema_applied(), which
// cb.schema_covers reads (db/schema.sql, Releases), so cb update can refuse a release the board's database is too old for.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hex = (h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

/** The sha256 of a schema file, as a release manifest lists it. */
export const schemaSha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Notes `applied` as the schema this database runs, appended to the ones seen before (kept in the order first applied).
 *  Run only after the whole file applied: a failed apply leaves the last schema noted. Every value is a hex sha256, so
 *  the literal written into the function holds nothing else. */
export async function recordSchema(sql: any, applied: string) {
  if (!hex(applied)) throw new Error(`not a schema sha256: ${JSON.stringify(applied)}`);
  const [{ has }] = await sql`select to_regprocedure('cb.schema_applied()') is not null as has`;
  const was = has ? (await sql`select cb.schema_applied() as a`)[0].a : null;
  const seen: string[] = Array.isArray(was?.seen) ? was.seen.filter(hex) : [];
  if (!seen.includes(applied)) seen.push(applied);
  const json = JSON.stringify({ current: applied, seen: seen.slice(-1000) });
  await sql.unsafe(`create or replace function cb.schema_applied() returns jsonb language sql immutable as $f$ select '${json}'::jsonb $f$`);
}
