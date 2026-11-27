// cb triage (#4535): reads this machine's fault log, decides the plain groups without a model (one or two sessions'
// wrong use, the board being unreachable), searches the board for cards that may already hold each remaining fault,
// asks one read-only judge (cli/triage-agent.ts) for a verdict per group, and files the real ones on claude-board.
// Ahmed's rulings: cb files what the judge decided, after a final redaction check, under a Postgres advisory lock on
// the template, with the fault:ft-… marker so two machines never file twice (Q2999); any session may run it, and it
// writes only claude-board cards carrying the marker, one filing run per machine per 6 h (Q3001); never scheduled
// (Q3002). --dry-run writes nothing: no card, no note, no triage.json.
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { faultsHome, readFaults, releaseOf, V } from '../kit/fault-line.mjs';
import { machine } from '../server/db.ts';
import { help } from './help.ts';
import { groupFaults, readMarker, sinceMs, type Group, type Marker } from './faults.ts';
import { DEFAULT_MODEL, runJudge } from './triage-agent.ts';
import { neverSent } from './connect-retry.ts';
import { isNetworkError } from './survive.ts';

export const PROJECT = 'claude-board';
// Opus (Q3000): one group measured at about USD 0.12 and two at 0.28 on the PC, so 4 stays well inside the 1.00 cap
// (a capped run files nothing and caches nothing, and would trip again)
export const DEFAULT_MAX = 4;
export const DEFAULT_BUDGET_USD = 1;
export const COOLDOWN_MS = 6 * 3600_000;
export const MANY_SEATS = 3;
const KEEP_MS = 30 * 86400_000;
const BOARD = join(import.meta.dirname, '..');
const VERDICTS = ['bug', 'misleading', 'user_error', 'infra', 'noise', 'unsure'] as const;
const FILE = new Set(['bug', 'misleading']);
// the judge sees these first: a crash or a database error is a likelier real bug than a slow call
const RANK = ['crash', 'db', 'daemon', 'bridge', 'slow', 'usage', 'refused'];

export const markerOf = (tmpl: string) => `fault:${tmpl}`;

type Decision = { group: Group; verdict: string; why: string; by: 'rule' | 'agent'; card?: number | null; title?: string; body?: string;
  candidates?: any[]; marked?: Set<number>; action?: string; held?: string };

/** The verdict cb gives without a model, or null (the judge decides). */
export function ruleFor(g: Group, judged: Marker['groups'][string] | undefined, infraHeavy: boolean): { verdict: string; why: string } | 'judged' | null {
  if (judged && g.count < 3 * judged.count && (!g.release || !judged.release || g.release === judged.release)) return 'judged';
  if ((g.kind === 'usage' || g.kind === 'refused') && g.seats < MANY_SEATS)
    return { verdict: 'user_error', why: `${g.seats === 1 ? 'one session' : `${g.seats} sessions`} made this mistake; ${MANY_SEATS} or more would make it a possible misleading message` };
  if (['not_run', 'lost', 'retried'].includes(g.kind) && !infraHeavy) return { verdict: 'infra', why: 'the board machine or the network: unreachable, reset or slow to connect' };
  if (g.kind === 'local_start') return { verdict: 'noise', why: "this machine's own board was down and cb started it, as designed" };
  return null;
}

/** The first six words of the message that are not masked: the words a duplicate card would share. */
const searchWords = (msg: string) => msg.replace(new RegExp(V, 'g'), ' ').match(/[A-Za-z]{3,}/g)?.slice(0, 6).join(' ') ?? '';

async function candidates(sql: any, g: Group) {
  const find = (q: string) => (q ? sql`select cb.task_find(${q}, ${PROJECT}, false, 5) as r` : Promise.resolve([{ r: { cards: [] } }]))
    .then((rows: any[]) => rows[0]?.r?.cards ?? [])
    .catch((e: any) => { if (/^unknown project /.test(e?.message ?? '')) return []; throw e; });
  const seen = new Map<number, any>();
  // a wrong use names its command only in the cmd field (the message masks it): cards about it say "cb <command>"
  const byCmd = (g.kind === 'usage' || g.kind === 'refused') && g.cmds.length === 1 ? await find(`cb ${g.cmds[0]}`) : [];
  const marked = await find(markerOf(g.tmpl));
  for (const c of [...marked, ...byCmd, ...await find(searchWords(g.msg))])
    if (seen.size < 5 && !seen.has(Number(c.id))) seen.set(Number(c.id), { id: Number(c.id), title: c.title, type: c.type, status: c.status, stage: c.stage ?? null });
  // the cards that carry this fault's marker: the only ones a filing run may note (the filing run checks again)
  return { cards: [...seen.values()], marked: new Set<number>(marked.map((c: any) => Number(c.id))) };
}

export function schemaFor(max: number) {
  return { type: 'object', additionalProperties: false, required: ['groups'], properties: { groups: { type: 'array', maxItems: max,
    items: { type: 'object', additionalProperties: false, required: ['tmpl', 'verdict', 'why'], properties: {
      tmpl: { type: 'string', pattern: '^ft-[0-9a-f]{12}$' }, verdict: { enum: [...VERDICTS] },
      existing_card: { type: ['integer', 'null'] }, title: { type: 'string', maxLength: 90 }, body: { type: 'string', maxLength: 1500 },
      why: { type: 'string', maxLength: 240 } } } } } };
}

export function promptFor(sent: Decision[], sha: string | null) {
  const groups = sent.map((d) => {
    const g = d.group, cmd = g.cmds.length === 1 ? g.cmds[0]! : null;
    return { tmpl: g.tmpl, src: g.src, cmd: g.cmds.join(','), sub: g.sub, flags: g.flags, kind: g.kind, code: g.code, count: g.count,
      seats: g.seats, first: g.first, last: g.last, releases: g.releases, msg: g.msg, ms_p50: g.ms_p50, ms_max: g.ms_max,
      candidates: d.candidates ?? [], help: cmd ? (help(cmd) ?? '').slice(0, 600) : null };
  });
  return `You triage faults that cb (the Claude Board command line) hit on one machine. You are read-only: you may read and
search the code in this folder (the claude-board checkout, release ${sha ?? 'unknown'}); you have no shell and no board
access. cb has already searched the board for you.

Each group below is one message template: the cb command, its kind and code, how often it happened, how many different
sessions hit it, when, on which releases, and the message with every value masked as ${V} and every number as N.
Candidate cards are cards already on the board that may be the same fault.

For each group give one verdict:
  bug         cb or the database did something wrong: a crash, a database error that is not a deliberate refusal, a
              lost or doubled write, a wrong result, a slow call with a cause in the code, a repeat that should have stopped.
  misleading  the session did something wrong, but the message, the help text or a missing command led it there. The
              same mistake by 3 or more sessions counts (for example many sessions typing a command that does not
              exist), and so does a message that names no command to run or shows a raw error code.
  user_error  the message is right and says what to do.
  infra       the board machine or the network (asleep, timeouts, restarts), and nothing in cb would have done better.
  noise       expected and harmless.
  unsure      you cannot tell from the code and the facts. Say what would tell. Never guess a verdict.

Rules (the same as \`cb help bug\`):
- A real fault you can point at in the code, not a guess, a wish or a style taste.
- Find where the message is made: grep its words in cli/, db/schema.sql, hooks/, kit/, server/. Name file:line.
- If a candidate card is the same fault, give its id as existing_card. A cancelled candidate for the same fault means
  the lead decided it is not one: say noise.
- A code comment that names a deliberate decision by Ahmed (an owner ruling, a card) means it is not a fault: say
  user_error and name the comment.
- For bug and misleading give a title (plain words, under 90 characters) and a body: what happened, how to repeat it,
  expected vs actual, the likely cause with file:line. Do not repeat the counts, dates, release or message: cb adds
  those. Never write machine names, hosts, addresses, paths outside this repo, session or people's names, card text,
  or anything that looks like a value. Describe the shape.

Return only the JSON the schema asks for: one entry per group, in the order given.

GROUPS
${JSON.stringify(groups, null, 1)}`;
}

/** Why a title or body may not be posted (board text cannot be edited afterwards), or null. */
export function redactionProblem(text: string, names: string[] = [machine(), hostname()]): string | null {
  const t = String(text ?? '');
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(t)) return 'an IPv4 address';
  if (/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|[0-9a-f]{1,4}::[0-9a-f]{0,4}/i.test(t)) return 'an IPv6 address';
  if (/\b[a-z][a-z0-9+.-]*:\/\/\S/i.test(t)) return 'a URL';
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(t)) return 'an email address';
  if (/\b[\w-]+@[a-z0-9][a-z0-9.-]*\b/i.test(t)) return 'a session name';
  if (/(?:^|[^\w])[A-Za-z]:[\\/]|\\\\[\w.-]+\\|(?:^|[\s"'(`=])(?:~\/|\/(?:Users|home|root|tmp|var|etc|private|mnt|opt)\/)/.test(t)) return 'a path outside the repo';
  if (/\d{8,}/.test(t)) return 'a run of 8 or more digits';
  if (/(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}/.test(t)) return 'a token-like string';
  for (const n of names) if (n && n.length >= 3 && new RegExp(`(?:^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(t)) return 'a machine name';
  return null;
}

/** The judge's answer checked against what was sent: unknown or repeated groups are dropped, a card that was not one
 *  of the group's candidates is refused, and a bug or misleading entry without a title and body is held. */
export function validate(raw: unknown, sent: Decision[]) {
  const byTmpl = new Map(sent.map((d) => [d.group.tmpl, d]));
  const list = (raw as any)?.groups;
  if (!Array.isArray(list)) throw new Error('the judge answered without a groups list');
  const done = new Set<string>();
  for (const e of list) {
    const d = typeof e?.tmpl === 'string' ? byTmpl.get(e.tmpl) : undefined;
    if (!d || done.has(e.tmpl)) continue;
    done.add(e.tmpl);
    if (!VERDICTS.includes(e.verdict)) { d.verdict = 'unsure'; d.held = 'an unknown verdict'; continue; }
    d.verdict = e.verdict; d.by = 'agent';
    d.why = typeof e.why === 'string' ? e.why.slice(0, 240) : '';
    const card = e.existing_card == null ? null : Number(e.existing_card);
    if (card != null && !(d.candidates ?? []).some((c) => c.id === card)) { d.held = `card #${card} was not one of its candidates`; continue; }
    d.card = card;
    if (FILE.has(d.verdict) && card == null) {
      const title = typeof e.title === 'string' ? e.title.replace(/\s+/g, ' ').trim() : '', body = typeof e.body === 'string' ? e.body.trim() : '';
      if (!title || !body || title.length > 90 || body.length > 1500) { d.held = 'no title and body within the limits'; continue; }
      d.title = title; d.body = body;
    }
  }
  for (const d of sent) if (!done.has(d.group.tmpl)) { d.verdict = 'unsure'; d.why = 'the judge gave no verdict for it'; }
}

const utc = (iso: string) => iso.slice(0, 16).replace('T', ' ');
function facts(g: Group) {
  const where = g.cmds.length ? `cb ${g.cmds.join(', ')}${g.sub ? ` ${g.sub}` : ''}` : g.src;
  return [`Facts (cb triage, from a machine's local fault log; values masked as ${V}, numbers as N):`,
    `- where: ${where} (${g.kind}${g.code ? `, ${g.code}` : ''})`,
    `- seen: ${g.count} time${g.count === 1 ? '' : 's'} by ${g.seats} session${g.seats === 1 ? '' : 's'}, ${utc(g.first)} to ${utc(g.last)} UTC`,
    `- releases: ${g.releases.join(', ') || 'unknown'}`, `- message: ${g.msg || '(none)'}`, markerOf(g.tmpl)].join('\n');
}

/** Files one decision under the template's advisory lock: a note on the open claude-board card that carries this
 *  marker, or a new bug. Never any other card or project (Q3001). */
async function fileOne(sql: any, d: Decision, actor: string) {
  const g = d.group, marker = markerOf(g.tmpl);
  return sql.begin(async (tx: any) => {
    await tx`select pg_advisory_xact_lock(hashtext(${'cb-fault:' + g.tmpl}))`;
    const [hit] = await tx`select id, status, done_at from cb.tasks where project = ${PROJECT} and strpos(body, ${marker}) > 0
      order by status in ('done', 'cancelled'), id desc limit 1`;
    const seen = `seen ${g.count} more time${g.count === 1 ? '' : 's'} by ${g.seats} session${g.seats === 1 ? '' : 's'} from ${utc(g.first)} to ${utc(g.last)} UTC, release ${g.releases.join(', ') || 'unknown'} (cb triage)`;
    if (hit && !['done', 'cancelled'].includes(hit.status)) {
      const bad = redactionProblem(seen);
      if (bad) return { action: 'held', id: Number(hit.id), why: bad };
      await tx`select cb.log(${PROJECT}, ${seen}, ${String(hit.id)}, '{}'::jsonb, ${actor})`;
      return { action: 'noted', id: Number(hit.id) };
    }
    if (hit?.status === 'cancelled') return { action: 'cancelled', id: Number(hit.id) };
    if (hit?.status === 'done' && hit.done_at && Date.parse(g.last) <= +new Date(hit.done_at)) return { action: 'fixed', id: Number(hit.id) };
    if (!d.title || !d.body) return { action: 'none', id: hit ? Number(hit.id) : null };
    const body = `${d.body}\n\n${hit ? `Seen again after #${hit.id} was done.\n\n` : ''}${facts(g)}`;
    // the last gate: board text cannot be edited, and the facts carry the message read back from the log
    const bad = redactionProblem(`${d.title}\n${body}`);
    if (bad) return { action: 'held', id: null, why: bad };
    const [{ id }] = await tx`select cb.task_add(project => ${PROJECT}, title => ${d.title}, body => ${body}, status => 'next',
      priority => 'P2', actor => ${actor}, type => 'bug') as id`;
    return { action: 'filed', id: Number(id) };
  });
}

function writeMarker(m: Marker) {
  const file = join(faultsHome(), 'triage.json'), tmp = `${file}.${process.pid}.tmp`;
  const cut = Date.now() - KEEP_MS;
  m.groups = Object.fromEntries(Object.entries(m.groups).filter(([, v]) => Date.parse(v.at) >= cut));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(m, null, 1) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

const num = (v: string | undefined, def: number, lo: number, hi: number, what: string, int = false) => {
  if (v == null) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) throw new Error(`${what} takes a number from ${lo} to ${hi}, not "${v}"`);
  return n;
};

export type TriageOpts = { since?: string; agent?: string; model?: string; max?: string; budget?: string; dryRun: boolean; force: boolean; actor: string };

export async function triageCmd(sql: any, o: TriageOpts) {
  const since = o.since ?? '24h', agent = o.agent ?? 'claude';
  if (agent !== 'claude' && agent !== 'none') throw new Error(`cb triage --agent takes claude (the default) or none, not "${agent}": the judge needs a read-only headless run, checked only for claude so far`);
  const max = num(o.max, DEFAULT_MAX, 1, 30, '--max', true);
  const budget = num(o.budget ?? process.env.CB_TRIAGE_BUDGET_USD, DEFAULT_BUDGET_USD, 0.05, 20, '--budget');
  const model = o.model ?? DEFAULT_MODEL;
  if (!/^[\w.:\[\]-]{1,80}$/.test(model)) throw new Error(`--model takes a model name (opus, sonnet or a full id), not "${model}"`);
  const files = !o.dryRun && agent !== 'none';
  const marker = readMarker();
  if (files && !o.force && marker.last_run && Date.now() - Date.parse(marker.last_run) < COOLDOWN_MS)
    throw new Error(`a filing cb triage ran on this machine at ${utc(marker.last_run)} UTC; one filing run per 6 hours per machine. Look without filing: cb triage --dry-run, or go ahead anyway: cb triage --force`);

  const groups = groupFaults(readFaults(Date.now() - sinceMs(since)));
  const days = Math.max(1, sinceMs(since) / 86400_000);
  const infraLines = groups.filter((g) => ['not_run', 'lost', 'retried'].includes(g.kind)).reduce((n, g) => n + g.count, 0);
  const infraHeavy = infraLines / days > (Number(process.env.CB_TRIAGE_INFRA_PER_DAY) || 200);
  const ds: Decision[] = [];
  let skipped = 0;
  for (const g of groups) {
    const r = ruleFor(g, marker.groups[g.tmpl], infraHeavy);
    if (r === 'judged') { skipped++; continue; }
    ds.push(r ? { group: g, ...r, by: 'rule' } : { group: g, verdict: 'unsure', why: '', by: 'agent' });
  }
  // when the board was unreachable too often, its biggest group goes to the judge; the rest stay infra
  if (infraHeavy) {
    const infra = ds.filter((d) => d.by === 'agent' && ['not_run', 'lost', 'retried'].includes(d.group.kind));
    for (const d of infra.slice(1)) Object.assign(d, { verdict: 'infra', why: 'the board machine or the network', by: 'rule' });
  }
  const rank = (d: Decision) => { const i = RANK.indexOf(d.group.kind); return i < 0 ? RANK.length : i; };
  const toJudge = ds.filter((d) => d.by === 'agent').sort((a, b) => rank(a) - rank(b) || b.group.count - a.group.count);
  const sent = toJudge.slice(0, max), waiting = toJudge.length - sent.length;
  const head = `triage on ${machine()}, last ${since}: ${groups.length} group${groups.length === 1 ? '' : 's'}; ${ds.length - toJudge.length} decided without a model`
    + `${skipped ? `, ${skipped} judged before` : ''}; ${agent === 'none' ? `${toJudge.length} would go to the judge` : `${sent.length} sent to ${agent} (${model})`}`
    + `${waiting ? `; ${waiting} wait for the next run (--max ${max})` : ''}`;

  let cost: number | null = null, secs: number | null = null;
  if (sent.length && agent !== 'none') {
    try { for (const d of sent) { const c = await candidates(sql, d.group); d.candidates = c.cards; d.marked = c.marked; } }
    catch (e: any) {
      if (!neverSent(e) && !isNetworkError(e) && e?.code !== 'RELAY_LOST') throw e;
      return { out: [head, ...lines(ds), `board unreachable (${e.code}): nothing was sent to the judge and nothing filed. Run cb triage again once the board answers`].join('\n'),
        json: { machine: machine(), since, decisions: ds.map(view), board: 'unreachable' }, code: 3 };
    }
    const j = runJudge({ prompt: promptFor(sent, releaseOf()), schema: schemaFor(sent.length), model, budget, board: BOARD });
    cost = j.cost; secs = Math.round(j.ms / 1000);
    if (!j.ok) throw new Error(`${j.error}${j.cost != null ? ` after USD ${j.cost.toFixed(2)}` : ''}: nothing was filed and triage.json is unchanged. Try again later, send fewer groups with --max (now ${sent.length}), or raise --budget (now ${budget.toFixed(2)})`);
    validate(j.groups, sent);
    for (const d of sent) {
      // the judge's reason is printed too (stdout, --json): it passes the same check, or is withheld
      const badWhy = d.why && redactionProblem(d.why);
      if (badWhy) d.why = `(the judge's reason is withheld: it failed the redaction check, ${badWhy})`;
      if (d.held || !FILE.has(d.verdict)) continue;
      // the whole card as it would be filed: the judge's title and body and cb's facts block (the logged message)
      const bad = d.title ? redactionProblem(`${d.title}\n${d.body}\n\n${facts(d.group)}`) : redactionProblem(facts(d.group));
      if (bad) { d.held = `failed the redaction check (${bad})`; d.title = d.body = undefined; }
    }
  }

  if (files) {
    for (const d of sent) {
      if (d.held || !FILE.has(d.verdict)) continue;
      const r: any = await fileOne(sql, d, o.actor);
      d.action = r.action;
      d.card = r.id ?? d.card;
      if (r.action === 'held') { d.held = `failed the redaction check (${r.why})`; continue; }
      marker.groups[d.group.tmpl] = { verdict: d.verdict, card: d.card ?? null, at: new Date().toISOString(), count: d.group.count, release: d.group.release, by: d.by };
      writeMarker(marker);
      // the judge named a card without the marker: Q3001 limits writes to marked cards, so nothing is written there
    }
  }
  const at = new Date().toISOString();
  if (files) {
    for (const d of ds) if (!d.held && d.verdict !== 'unsure')
      marker.groups[d.group.tmpl] = { verdict: d.verdict, card: d.card ?? null, at, count: d.group.count, release: d.group.release, by: d.by };
    marker.last_run = at;
    writeMarker(marker);
  }
  const tail = agent === 'none' ? 'no model: nothing judged, nothing filed. Judge them: cb triage --dry-run'
    : `${secs != null ? `judge: ${secs} s, USD ${cost != null ? cost.toFixed(2) : 'unknown'} (list price)` : 'no group needed the judge'}; `
      + (files ? `${ds.filter((d) => d.action === 'filed').length} filed, ${ds.filter((d) => d.action === 'noted').length} noted`
        : 'dry run: nothing filed, triage.json unchanged. File them: cb triage');
  return { out: [head, ...lines(ds, files), tail].join('\n'), json: { machine: machine(), since, model: agent === 'none' ? null : model, cost_usd: cost, seconds: secs, dry_run: !files, decisions: ds.map(view) } };
}

const view = (d: Decision) => ({ tmpl: d.group.tmpl, kind: d.group.kind, count: d.group.count, seats: d.group.seats, verdict: d.verdict, by: d.by,
  why: d.why, card: d.card ?? null, title: d.title ?? null, action: d.action ?? null, held: d.held ?? null });

function lines(ds: Decision[], files = false) {
  const word = (d: Decision) => {
    if (d.held) return 'held';
    if (d.action === 'filed') return `filed #${d.card}`;
    if (d.action === 'noted') return `noted #${d.card}`;
    if (d.action === 'cancelled') return `noise (#${d.card} cancelled)`;
    if (d.action === 'fixed') return `fixed (#${d.card} done)`;
    // a note goes only on a card carrying this fault's marker (Q3001); any other card the judge names is only shown
    if (FILE.has(d.verdict)) return d.card != null ? (!files && d.marked?.has(d.card) ? `would note #${d.card}` : `same as #${d.card}`) : files ? 'not filed' : 'would file';
    return d.by === 'agent' && d.verdict === 'unsure' && !d.why ? 'to judge' : d.verdict;
  };
  return ds.slice(0, 40).map((d) => {
    const g = d.group, what = `${g.kind}${g.code ? ` ${g.code}` : ''} x${g.count} (${g.cmds.join(',') || g.src}, ${g.seats} session${g.seats === 1 ? '' : 's'})`;
    const text = d.held ? d.held : d.title ? `"${d.title}"` : d.why;
    return `  ${word(d).padEnd(14)} ${g.tmpl}  ${what.padEnd(36)} ${text}`;
  });
}
