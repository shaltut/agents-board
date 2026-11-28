/** #4512: the stage words cb brief prints (cb._brief_tasks gives them), for a list of cards in ONE query: cb._stage_words
 *  of each distinct project and stage, only with that project's pipeline on, so an unstaged card or a pipeline that is off
 *  gives null (never "Not staged"). cb mine and cb start's YOUR TASKS run it on every call: one round trip for the whole
 *  list, not one per card (review I1). A part holder's cb.mine row carries its part's stage, so that is the one named.
 *  Returns the words in the order of rows. */
import { call } from './board.ts';

const key = (project: unknown, stage: unknown) => JSON.stringify([project, stage]);

export async function stageWordsFor(sql: any, rows: any[]): Promise<(string | null)[]> {
  const pairs = [...new Map(rows.filter((t) => t.stage).map((t) => [key(t.project, t.stage), [String(t.project), String(t.stage)]])).values()];
  if (!pairs.length) return rows.map(() => null);
  const got = await call('stage_words_for', { pairs }, sql) as (string | null)[];
  const words = new Map(pairs.map((p, i) => [key(p[0], p[1]), got[i] ?? null]));
  return rows.map((t) => (t.stage ? words.get(key(t.project, t.stage)) ?? null : null));
}
