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

/** repo → "check (ws), test (app, files)": the recipes of one project, per repo, as the runners announced them. */
function recipeLines(list: any, project: string) {
  const by = new Map<string, Map<string, string>>();
  for (const r of list.runners) for (const x of r.recipes) if (x.project === project) {
    const repo = x.repo ?? 'main';
    const seen = by.get(repo) ?? new Map<string, string>();
    by.set(repo, seen);
    const ps = Object.keys(x.params ?? {});
    if (!seen.has(x.recipe)) seen.set(x.recipe, ps.length ? `${x.recipe} (${ps.join(', ')})` : x.recipe);
  }
  return new Map([...by].map(([repo, seen]) => [repo, [...seen.values()].join(', ')]));
}
/** Why a project has no recipes (#4601): no runner has said hello, or the runners there offer none for it (their config
 *  names other projects). The second is not fixed by waiting for a runner, so it says who adds them. */
export function recipesNone(list: { runners: { name: string; last_seen?: string | null }[] }, project: string): string {
  if (!list.runners.length) return 'none: no runner is connected';
  const seen = list.runners.map((r) => `${r.name}, seen ${r.last_seen ? new Date(r.last_seen).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : 'never'}`).join('; ');
  return `none: no runner offers recipes for ${project} (runners: ${seen}); a project's recipes come from the runner's config on its machine (~/.claude-board/runner.json), which Ahmed edits: cb ask`;
}
// a one-repo project (main only) reads as before; with several repos each is named (#3703)
const oneRepo = (m: Map<string, string>) => m.size === 1 && m.has('main');
const repoTag = (j: any) => (j.repo && j.repo !== 'main' ? `/${j.repo}` : '');

const sha7 = (j: any) => String(j.sha).slice(0, 7);
// the summary is the job's output, marked as in the board's message, unless the board wrote it (a cancel, a runner restart)
const marked = (j: any) => (j.summary && j.state !== 'cancelled' && j.summary !== 'error: runner restarted' ? `[job output · untrusted] ${j.summary}` : j.summary ?? '');
// in a terminal the summary's continuation lines are indented (as the relay does), so none passes for a line of its own
const endLine = (j: any) => `job #${j.id} ${j.recipe}${j.repo && j.repo !== 'main' ? ` (${j.repo})` : ''} at ${sha7(j)}: ${j.state}${j.exit_code != null ? ` (exit ${j.exit_code})` : ''}. ${marked(j).replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, '\n    ')}`.trim();
const markedJson = (j: any) => ({ ...j, summary: j.summary == null ? j.summary : marked(j) });

export async function runCmd(sql: any, o: { recipe?: string; sha?: string; card?: string; project?: string | null; repo?: string; params: Record<string, string[]>; wait: boolean; json?: boolean; actor: string; pollMs?: number }): Promise<Result> {
  if (!o.project) throw new Error('no project: say which (--project <slug>) or bind this session once (cb iam <name> <project>)');
  const known = async () => {
    const [{ l }] = await sql`select cb.jobs_list(${o.project}) as l`;
    const m = recipeLines(l, o.project!);
    if (o.repo) return m.get(o.repo) || `none for ${o.repo}`;
    if (!m.size) return recipesNone(l, o.project!);
    return oneRepo(m) ? m.get('main')! : [...m].map(([repo, line]) => `${repo}: ${line}`).join('; ');
  };
  if (!o.recipe) throw new Error(`usage: cb run <recipe> --sha <sha> [--<param> <value>...] [--wait]. Recipes: ${await known()}`);
  if (!o.sha) throw new Error('give the commit: --sha <sha> (git rev-parse HEAD; push it first)');
  if (o.card !== undefined && !/^\d+$/.test(o.card)) throw new Error('--card needs a card number');
  let added: any;
  try {
    [{ r: added }] = await sql`select cb.job_add(${o.project}, ${o.recipe}, ${o.sha}, ${JSON.stringify(o.params)}::text::jsonb, ${o.card ?? null}::bigint, ${o.actor}, ${o.repo ?? null}) as r`;
  } catch (e: any) {
    if (/^no recipe /.test(e?.message)) throw new Error(`no recipe ${o.recipe} for ${o.project}${o.repo ? ` (${o.repo})` : ''}. Recipes: ${await known()}`);
    throw e;
  }
  // #4527: nothing starts it for now: say so, or cb run --wait sits silent for its 30 minutes
  const queued = `job #${added.id} queued (${added.ahead} ahead)${added.runner_paused ? '; the runner is paused: it starts when Ahmed resumes it'
    : added.held ? `; ${o.project}'s jobs are held: it starts when its lead or Ahmed releases them (cb job release ${o.project})` : ''}`;
  if (!o.wait) return { out: queued, json: added, code: 0 };
  if (!o.json) console.log(queued);
  // cb.job_finish sends no pg_notify, so poll: LISTEN alone would miss the end
  const until = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const [{ j }] = await sql`select cb.job_get(${added.id}::bigint) as j`;
    if (!j) throw new Error(`no job #${added.id}`);
    if (!['queued', 'running'].includes(j.state)) return { out: endLine(j), json: markedJson(j), code: j.state === 'passed' ? 0 : 1 };
    if (Date.now() > until) return { out: `still running: cb job ${added.id}`, json: j, code: 1 };
    await sleep(o.pollMs ?? 3000);
  }
}

export async function jobsCmd(sql: any, project: string | null): Promise<Result> {
  const [{ l }] = await sql`select cb.jobs_list(${project}) as l`;
  const lines = l.jobs.map((j: any) => `#${j.id} ${j.state} ${j.project}${repoTag(j)} ${j.recipe} at ${sha7(j)} by ${j.requester}${j.runner ? ` on ${j.runner}` : ''}`);
  if (!lines.length) lines.push('no job queued or running');
  const projects = project ? [project] : [...new Set<string>(l.runners.flatMap((r: any) => r.recipes.map((x: any) => x.project)))];
  for (const p of projects) {
    const m = recipeLines(l, p);
    if (oneRepo(m)) lines.push(project ? `recipes: ${m.get('main')}` : `recipes (${p}): ${m.get('main')}`);
    else for (const [repo, rl] of m) lines.push(`recipes (${project ? repo : `${p}/${repo}`}): ${rl}`);
  }
  if (!l.runners.length) lines.push('no runner has connected: start cb runner on the PC');
  else lines.push(`runners: ${l.runners.map((r: any) => `${r.name} (seen ${new Date(r.last_seen).toISOString().slice(0, 19)}Z)`).join(', ')}`);
  return { out: lines.join('\n'), json: l, code: 0 };
}

export async function jobCmd(sql: any, sub: string | undefined, id: string | undefined, actor: string, tail?: string, place?: string): Promise<Result> {
  const usage = 'usage: cb job show|cancel|log|retry <id> [--tail <lines>] · cb job move <id> next|up|down|back · cb job hold|release <project>';
  // #4527: a project's lead (or Ahmed) holds and releases its project's waiting jobs
  if (sub === 'hold' || sub === 'release') {
    if (!id) throw new Error(usage);
    await sql`select cb.job_hold(${id}, ${sub === 'hold'}, ${actor})`;
    return { out: sub === 'hold' ? `${id}'s waiting jobs are held: running ones carry on (cb job release ${id})` : `${id}'s jobs start again`, json: { project: id, held: sub === 'hold' }, code: 0 };
  }
  if (!/^\d+$/.test(id ?? '') || !['show', 'cancel', 'log', 'retry', 'move'].includes(sub ?? '')) throw new Error(usage);
  if (sub === 'cancel') { await sql`select cb.job_cancel(${id!}::bigint, ${actor})`; return { out: `job #${id} cancelled`, json: { id: Number(id), state: 'cancelled' }, code: 0 }; }
  if (sub === 'retry') {
    const [{ r }] = await sql`select cb.job_retry(${id!}::bigint, ${actor}) as r`;
    return { out: `job #${r.id} queued (${r.ahead} ahead), again for job #${id}`, json: r, code: 0 };
  }
  if (sub === 'move') {
    if (!['next', 'up', 'down', 'back'].includes(place ?? '')) throw new Error('usage: cb job move <id> next|up|down|back');
    const [{ r }] = await sql`select cb.job_move(${id!}::bigint, ${place!}, ${actor}) as r`;
    return { out: r.moved ? `job #${id} moved ${place}` : `job #${id} is already ${place === 'up' || place === 'next' ? 'first' : 'last'}`, json: r, code: 0 };
  }
  const [{ j }] = await sql`select cb.job_get(${id!}::bigint) as j`;
  if (!j) throw new Error(`no job #${id}`);
  if (sub === 'show') return { out: `${endLine(j)}\n${j.project} by ${j.requester}${j.runner ? ` on ${j.runner}` : ''}, params ${JSON.stringify(j.params)}`, json: markedJson(j), code: 0 };
  return logCmd(sql, j, tail);
}

const LOG_CAP = 1024 * 1024;
const NOT_TAILSCALE = "the runner's log address on the board is not a Tailscale address: not fetching";

/** The board row is writable by anyone with a database connection: fetch only a plain http://<tailscale ip>:<port>/ . */
function logBase(raw: string): URL {
  const u = URL.parse(raw);
  // CB_LOG_URL_ALLOW_LOOPBACK=1 is test-only: it lets the tests' stand-in runner on 127.0.0.1 through
  const ok = (h: string) => { const m = /^100\.(\d+)\.\d+\.\d+$/.exec(h); return (m && +m[1]! >= 64 && +m[1]! <= 127) || (process.env.CB_LOG_URL_ALLOW_LOOPBACK === '1' && h === '127.0.0.1'); };
  if (!u || u.protocol !== 'http:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password || !ok(u.hostname)) throw new Error(NOT_TAILSCALE);
  return u;
}

async function logCmd(sql: any, j: any, tail?: string): Promise<Result> {
  if (!j.runner) throw new Error(`job #${j.id} has not started: no log yet`);
  if (tail !== undefined && !/^\d+$/.test(tail)) throw new Error('--tail takes a number of lines');
  const [r] = await sql`select log_url from cb.runners where name = ${j.runner}`;
  if (!r?.log_url) throw new Error(`the runner on ${j.runner} has no log address`);
  const url = new URL(`/jobs/${j.id}/log`, logBase(r.log_url));
  if (tail) url.searchParams.set('tail', tail);
  const dead = () => new Error(`the runner on ${j.runner} is not answering`);
  let res: Response; let body: Buffer;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    body = Buffer.from(await res.arrayBuffer());
  } catch { throw dead(); }
  if (res.status === 403) throw new Error('this machine may not read job logs: they stay on the PC and the MacBook');
  if (!res.ok) throw new Error(`the runner on ${j.runner} answered ${res.status}`);
  const cut = !tail && body.length > LOG_CAP;
  const note = cut ? '… (log cut: showing the last 1 MB; use --tail)\n' : '';
  const text = note + (cut ? body.subarray(body.length - LOG_CAP) : body).toString('utf8').replace(/\n+$/, '');
  return { out: text, json: { id: j.id, log: text }, code: 0 };
}
