// cb run / jobs / job: queue checks on the PC runner, read the queue and the logs. Logic lives here, cb.ts only dispatches.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT_MS = 30 * 60_000;
type Result = { out: string; json: unknown; code: number };

/** After `cb run`, every --<name> that cb does not know is a recipe parameter; its values run up to the next --flag.
 *  A value that starts with a single - stays a value: the board's SQL refuses it by the parameter's name. */
export function splitRunArgs(argv: string[], known: Set<string>): { rest: string[]; params: Record<string, string[]> } {
  const rest: string[] = []; const params: Record<string, string[]> = {};
  let cur: string[] | null = null;
  for (const a of argv) {
    const m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/i.exec(a);
    if (m && !known.has(m[1]!)) { cur = params[m[1]!] ??= []; if (m[2] !== undefined) cur.push(m[2]); continue; }
    if (m) cur = null;
    (cur ?? rest).push(a);
  }
  return { rest, params };
}

/** "check (ws), test (app, files)": the recipes of one project, as the runners announced them. */
function recipeLine(list: any, project: string) {
  const seen = new Map<string, string>();
  for (const r of list.runners) for (const x of r.recipes) if (x.project === project && !seen.has(x.recipe)) {
    const ps = Object.keys(x.params ?? {});
    seen.set(x.recipe, ps.length ? `${x.recipe} (${ps.join(', ')})` : x.recipe);
  }
  return seen.size ? [...seen.values()].join(', ') : '';
}

const sha7 = (j: any) => String(j.sha).slice(0, 7);
const endLine = (j: any) => `job #${j.id} ${j.recipe} at ${sha7(j)}: ${j.state}${j.exit_code != null ? ` (exit ${j.exit_code})` : ''}. ${j.summary ?? ''}`.trim();

export async function runCmd(sql: any, o: { recipe?: string; sha?: string; card?: string; project?: string | null; params: Record<string, string[]>; wait: boolean; actor: string; pollMs?: number }): Promise<Result> {
  if (!o.project) throw new Error('no project: say which (--project <slug>) or bind this session once (cb iam <name> <project>)');
  const known = async () => {
    const [{ l }] = await sql`select cb.jobs_list(${o.project}) as l`;
    return recipeLine(l, o.project!) || 'none: no runner is connected';
  };
  if (!o.recipe) throw new Error(`usage: cb run <recipe> --sha <sha> [--<param> <value>...] [--wait]. Recipes: ${await known()}`);
  if (!o.sha) throw new Error('give the commit: --sha <sha> (git rev-parse HEAD; push it first)');
  let added: any;
  try {
    [{ r: added }] = await sql`select cb.job_add(${o.project}, ${o.recipe}, ${o.sha}, ${JSON.stringify(o.params)}::text::jsonb, ${o.card ? Number(o.card) : null}::bigint, ${o.actor}) as r`;
  } catch (e: any) {
    if (/^no recipe /.test(e?.message)) throw new Error(`no recipe ${o.recipe} for ${o.project}. Recipes: ${await known()}`);
    throw e;
  }
  const queued = `job #${added.id} queued (${added.ahead} ahead)`;
  if (!o.wait) return { out: queued, json: added, code: 0 };
  console.log(queued);
  // cb.job_finish sends no pg_notify, so poll: LISTEN alone would miss the end
  const until = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const [{ j }] = await sql`select cb.job_get(${added.id}::bigint) as j`;
    if (j && !['queued', 'running'].includes(j.state)) return { out: endLine(j), json: j, code: j.state === 'passed' ? 0 : 1 };
    if (Date.now() > until) return { out: `still running: cb job ${added.id}`, json: j, code: 1 };
    await sleep(o.pollMs ?? 3000);
  }
}

export async function jobsCmd(sql: any, project: string | null): Promise<Result> {
  const [{ l }] = await sql`select cb.jobs_list(${project}) as l`;
  const lines = l.jobs.map((j: any) => `#${j.id} ${j.state} ${j.project} ${j.recipe} at ${sha7(j)} by ${j.requester}${j.runner ? ` on ${j.runner}` : ''}`);
  if (!lines.length) lines.push('no job queued or running');
  const projects = project ? [project] : [...new Set<string>(l.runners.flatMap((r: any) => r.recipes.map((x: any) => x.project)))];
  for (const p of projects) { const rl = recipeLine(l, p); if (rl) lines.push(project ? `recipes: ${rl}` : `recipes (${p}): ${rl}`); }
  if (!l.runners.length) lines.push('no runner has connected: start cb runner on the PC');
  else lines.push(`runners: ${l.runners.map((r: any) => `${r.name} (seen ${new Date(r.last_seen).toISOString().slice(0, 19)}Z)`).join(', ')}`);
  return { out: lines.join('\n'), json: l, code: 0 };
}

export async function jobCmd(sql: any, sub: string | undefined, id: string | undefined, actor: string, tail?: string): Promise<Result> {
  const usage = 'usage: cb job show|cancel|log <id> [--tail <lines>]';
  if (!/^\d+$/.test(id ?? '') || !['show', 'cancel', 'log'].includes(sub ?? '')) throw new Error(usage);
  if (sub === 'cancel') { await sql`select cb.job_cancel(${id!}::bigint, ${actor})`; return { out: `job #${id} cancelled`, json: { id: Number(id), state: 'cancelled' }, code: 0 }; }
  const [{ j }] = await sql`select cb.job_get(${id!}::bigint) as j`;
  if (!j) throw new Error(`no job #${id}`);
  if (sub === 'show') return { out: `${endLine(j)}\n${j.project} by ${j.requester}${j.runner ? ` on ${j.runner}` : ''}, params ${JSON.stringify(j.params)}`, json: j, code: 0 };
  return logCmd(sql, j, tail);
}

async function logCmd(sql: any, j: any, tail?: string): Promise<Result> {
  if (!j.runner) throw new Error(`job #${j.id} has not started: no log yet`);
  if (tail !== undefined && !/^\d+$/.test(tail)) throw new Error('--tail takes a number of lines');
  const [r] = await sql`select log_url from cb.runners where name = ${j.runner}`;
  if (!r?.log_url) throw new Error(`the runner on ${j.runner} has no log address`);
  let res: Response;
  try { res = await fetch(`${r.log_url}/jobs/${j.id}/log${tail ? `?tail=${tail}` : ''}`, { signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error(`the runner on ${j.runner} is not answering`); }
  if (res.status === 403) throw new Error('this machine may not read job logs: they stay on the PC and the MacBook');
  if (!res.ok) throw new Error(`the runner on ${j.runner} answered ${res.status}`);
  const text = (await res.text()).replace(/\n+$/, '');
  return { out: text, json: { id: j.id, log: text }, code: 0 };
}
