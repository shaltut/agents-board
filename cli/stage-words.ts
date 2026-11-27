/** #4512: the stage words cb brief prints (cb._brief_tasks gives them), for a list of cards in ONE query: cb._stage_words
 *  of each distinct project and stage, only with that project's pipeline on, so an unstaged card or a pipeline that is off
 *  gives null (never "Not staged"). cb mine and cb start's YOUR TASKS run it on every call: one round trip for the whole
 *  list, not one per card (review I1). Plain arrays cross the relay bridge as values. A part holder's cb.mine row carries
 *  its part's stage, so that is the one named. Returns the words in the order of rows. */
const key = (project: unknown, stage: unknown) => JSON.stringify([project, stage]);

export async function stageWordsFor(sql: any, rows: any[]): Promise<(string | null)[]> {
  const pairs = [...new Map(rows.filter((t) => t.stage).map((t) => [key(t.project, t.stage), [String(t.project), String(t.stage)]])).values()];
  if (!pairs.length) return rows.map(() => null);
  const got = await sql`select x.p, x.s, case when cb._pipeline(x.p) then cb._stage_words(x.s) end as w
    from unnest(${pairs.map((p) => p[0])}::text[], ${pairs.map((p) => p[1])}::text[]) as x(p, s)`;
  const words = new Map(got.map((r: any) => [key(r.p, r.s), r.w as string | null]));
  return rows.map((t) => (t.stage ? words.get(key(t.project, t.stage)) ?? null : null));
}
