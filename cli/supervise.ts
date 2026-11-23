// The supervisor (#3601): `node cli/supervise.ts`, started with `cb supervise` in herdr tab `supervisor` on the PC.
// Every 60 s one tick: per supervised project it starts, restores and closes squad sessions through herdr as planTick
// says, then restarts the PC runner if it stopped beating. One supervisor anywhere: a Postgres advisory lock.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, machine } from '../server/db.ts';
import { loadConfig } from './recipes.ts';
import { classifyAgentGet, find, herdrJson, herdrName, promptCommand, realRun, startOne, type Launch, type Runner } from './squad-up.ts';
import { planTick, type State, type TickPlan } from './supervise-plan.ts';

const MAC = 'macbook', STARTS_PER_TICK = 3, RUNNER_STALE = 3 * 60_000, HOUR = 3_600_000, CLOSE_WAIT = 60_000, POLL = 5_000;
const BOARD = join(import.meta.dirname, '..'); // the board checkout on this PC: the runner tab's folder

export type Memory = { failedAt: Map<string, number>; blockedTold: Set<string>; runnerToldAt: number };
export type Deps = {
  sql: any; run: Runner; dryRun: boolean; now: number; memory: Memory; runnerConfig: string | null;
  probe: (host: string, port: number) => Promise<boolean>; sleep?: (ms: number) => Promise<void>;
};
const msg = (e: unknown) => ((e as Error)?.message ?? String(e)).trim();

/** One tick. Returns the lines to print. Dry run: herdr is only read (agent list), the board is never written. */
export async function tick(d: Deps): Promise<string[]> {
  const { sql, run, dryRun, now, memory } = d;
  const out: string[] = [];
  const log = async (project: string | null, what: string, session: string, note?: string) => {
    try { await sql`select cb.supervise_log(${project}, ${what}, ${session}, ${note ?? null})`; } catch (e) { out.push(`could not log ${what} ${session}: ${msg(e)}`); }
  };
  const states: State[] = [];
  for (const { slug } of await sql`select slug from cb.projects where squad ->> 'supervise' = 'true' order by slug`) {
    const s = (await sql`select cb.supervise_state(${slug}) as s`)[0].s as State;
    if (s.supervised) states.push(s);
  }

  // herdr: one agent list per herdr label (null = this PC) used by any supervised squad
  const keysOf = new Map<string | null, Set<string>>();
  for (const s of states) for (const [k, m] of Object.entries(s.squad.machines)) (keysOf.get(m.herdr) ?? keysOf.set(m.herdr, new Set()).get(m.herdr)!).add(k);
  const herdrLive = new Set<string>(), herdrDown = new Set<string>(), mac = new Set<string>();
  let macAgents = 0;
  for (const [label, keys] of keysOf) {
    let agents: any;
    try { agents = find(herdrJson(run, label, ['agent', 'list'], 30_000), 'agents'); } catch {}
    if (!Array.isArray(agents)) {
      for (const k of keys) herdrDown.add(k);
      out.push(`herdr ${label ?? 'on this PC'} did not answer: nothing starts there this tick`);
      continue;
    }
    for (const a of agents) if (typeof a?.name === 'string') { herdrLive.add(a.name); if (label === MAC) mac.add(a.name); }
    if (label === MAC) macAgents = agents.length;
  }
  // the Mac cap counts every live session there, any project (as cb squad up)
  const macKeys = new Set([MAC, ...(keysOf.get(MAC) ?? [])]);
  for (const l of await sql`select actor, machine from cb.sessions where last_seen > now() - interval '90 seconds'`) {
    if (macKeys.has(l.machine) || macKeys.has(String(l.actor).split('@')[1])) mac.add(herdrName(l.actor));
  }
  let macLive = Math.max(mac.size, macAgents), startsLeft = STARTS_PER_TICK;

  for (const state of states) {
    try {
      const plan = planTick({ state, herdrLive, herdrDown, macLive, startsLeft, failedAt: memory.failedAt, now });
      const launches = [...plan.restore, ...plan.start];
      startsLeft -= launches.length;
      macLive += launches.filter((l) => l.herdr === MAC || l.machine === MAC).length;
      await act(d, state, plan, out, log);
    } catch (e) {
      out.push(`${state.project}: tick failed: ${msg(e)}`);
    }
  }
  try { await runnerCheck(d, out, log); } catch (e) { out.push(`runner check failed: ${msg(e)}`); }
  return out;
}

type Log = (project: string | null, what: string, session: string, note?: string) => Promise<void>;

async function act(d: Deps, state: State, plan: TickPlan, out: string[], log: Log) {
  const { run, dryRun, now, memory } = d, project = state.project;
  const tabs: Record<string, { pane: string; panes: number }> = {};
  for (const [what, list] of [['restore', plan.restore], ['start', plan.start]] as const) {
    for (const l of list) {
      if (dryRun) { out.push(`would ${what} ${l.name} (${l.role}, ${l.model}) on ${l.machine}`); continue; }
      const seen = classifyAgentGet(run(l.herdr, ['agent', 'get', herdrName(l.name)], 30_000));
      if (seen !== 'absent') { out.push(`skip ${l.name}: ${seen === 'live' ? 'running in herdr' : `could not check herdr on ${l.machine}`}`); continue; }
      const r = startOne(l, run, tabs);
      out.push(r.line);
      if (r.blocked) {
        await log(project, 'blocked', l.name, r.pane);
        if (!memory.blockedTold.has(l.name)) { memory.blockedTold.add(l.name); await tellLead(d, state, l, r.pane!, out); }
      } else if (r.ok) await log(project, what, l.name, l.role);
      else {
        memory.failedAt.set(l.name, now);
        await log(project, 'failed', l.name, (r.line.startsWith('started') ? 'prompt not sent' : r.line.slice(r.line.indexOf(': ') + 2)).slice(0, 80));
      }
    }
  }
  for (const name of plan.close) {
    if (dryRun) out.push(`would close ${name}`);
    else out.push(await closeOne(d, state, name, log));
  }
  for (const n of plan.notes) {
    if (dryRun) out.push(`would note ${n.session} down again`);
    else { out.push(`${n.session} is down again after a restore: restore it by hand`); await log(project, 'down_again', n.session, 'restore it by hand'); }
  }
}

// A startup dialog is a person's: the lead is told once per name per run, with the pane and the command to finish.
async function tellLead(d: Deps, state: State, l: Launch, pane: string, out: string[]) {
  const lead = state.squad.roles.lead;
  if (!lead) return;
  const text = `supervisor: ${l.name} waits on a startup dialog in herdr pane ${pane}${l.herdr ? ` on ${l.herdr}` : ''}. Answer it there, then run: ${promptCommand(l)}`;
  try { await d.sql`select cb.tell(${`orch@${lead.machine}`}, ${text}, 'supervisor')`; } catch (e) { out.push(`could not tell orch@${lead.machine}: ${msg(e)}`); }
}

// Mark closing, re-check on a fresh statement, /exit, wait for herdr to drop the agent, close its pane.
async function closeOne(d: Deps, state: State, name: string, log: Log): Promise<string> {
  const { sql, run } = d, sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const unmark = () => sql`select cb.supervise_mark(${name}, false)`.catch(() => {});
  if (!(await sql`select cb.supervise_mark(${name}, true) as ok`)[0].ok) return `skip closing ${name}: it holds work`;
  const s = ((await sql`select cb.supervise_state(${state.project}) as s`)[0].s as State).sessions.find((x) => x.actor === name);
  if (!s || s.holds || s.questions || s.jobs) { await unmark(); return `skip closing ${name}: it took work`; }
  const m = state.squad.machines[name.split('@')[1]!]?.herdr ?? null, hn = herdrName(name);
  let pane: string | undefined;
  try { pane = find(herdrJson(run, m, ['agent', 'get', hn], 30_000), 'pane_id'); } catch {}
  if (!pane) { await unmark(); return `could not close ${name}: herdr does not show it`; }
  if (run(m, ['agent', 'prompt', hn, '/exit'], 30_000).status !== 0) { await unmark(); return `could not close ${name}: /exit was not sent`; }
  for (let waited = 0; waited < CLOSE_WAIT; waited += POLL) {
    await sleep(POLL);
    if (classifyAgentGet(run(m, ['agent', 'get', hn], 30_000)) !== 'absent') continue;
    const closed = run(m, ['pane', 'close', pane], 30_000).status === 0;
    await log(state.project, 'close', name, s.role);
    await unmark(); // the agent is gone; a mark left on its old row would refuse work to the same name started again
    return closed ? `closed ${name}` : `closed ${name}; its pane ${pane} did not close`;
  }
  await unmark();
  return `could not close ${name}`;
}

// The PC runner: no beat for 3 minutes → start it in a herdr tab, unless its log port is still held (then report hourly).
async function runnerCheck(d: Deps, out: string[], log: Log) {
  if (!d.runnerConfig) return;
  let cfg;
  try { cfg = loadConfig(readFileSync(d.runnerConfig, 'utf8')); } catch (e) { out.push(`runner config: ${msg(e)}`); return; }
  const name = cfg.name ?? machine();
  const { runners } = (await d.sql`select cb.jobs_list(null) as j`)[0].j;
  const beat = runners.find((r: any) => r.name === name)?.last_seen;
  if (beat && d.now - Date.parse(beat) < RUNNER_STALE) return;
  if (await d.probe(cfg.log.host, cfg.log.port)) {
    if (d.now - d.memory.runnerToldAt < HOUR) return;
    out.push(`runner ${name} is not beating but its port is held`);
    if (!d.dryRun) { d.memory.runnerToldAt = d.now; await log(null, 'runner', name, 'not beating but its port is held'); }
    return;
  }
  if (d.dryRun) { out.push('would start the runner'); return; }
  try {
    const pane = find(herdrJson(d.run, null, ['tab', 'create', '--cwd', BOARD, '--label', 'runner', '--no-focus']), 'pane_id');
    if (!pane) throw new Error('herdr returned no pane id');
    herdrJson(d.run, null, ['pane', 'run', pane, 'cb runner']);
    out.push(`started the runner in herdr pane ${pane}`);
    await log(null, 'runner', name, 'started');
  } catch (e) { out.push(`could not start the runner: ${msg(e)}`); }
}

const probe = (host: string, port: number) => new Promise<boolean>((ok) => {
  const s = net.connect({ host, port, timeout: 3_000 });
  s.once('connect', () => { s.destroy(); ok(true); });
  s.once('timeout', () => { s.destroy(); ok(false); });
  s.once('error', () => ok(false));
});

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run'), once = process.argv.includes('--once');
  const version = createHash('sha256').update(['supervise.ts', 'supervise-plan.ts', 'squad-up.ts']
    .map((f) => readFileSync(join(import.meta.dirname, f), 'utf8')).join('\0')).digest('hex').slice(0, 7);
  const sql = connect(undefined, { app: `cb-supervisor/${version}`, max: 2 });
  const lock = await sql.reserve(); // the lock lives on this one connection; it goes when the connection does
  // re-taken every tick: a lock held is re-entrant (true); a reconnect that lost it to another supervisor gives false
  const locked = async () => (await lock`select pg_try_advisory_lock(hashtext('cb-supervisor')) as ok`)[0]!.ok === true;
  if (!(await locked())) { console.log('another supervisor is running'); process.exit(1); }
  const home = process.env.CB_SUPERVISOR_HOME || join(homedir(), '.claude-board', 'supervisor');
  const say = (line: string) => {
    const at = new Date().toISOString();
    console.log(`${at} ${line}`);
    if (!dryRun) try { appendFileSync(join(home, `${at.slice(0, 10)}.log`), `${at} ${line}\n`); } catch {}
  };
  if (!dryRun) {
    mkdirSync(home, { recursive: true });
    for (const f of readdirSync(home)) try { if (statSync(join(home, f)).mtimeMs < Date.now() - 7 * 86_400_000) rmSync(join(home, f)); } catch {}
    say(`supervisor up (cb-supervisor/${version})`);
  }
  const configPath = process.env.CB_RUNNER_CONFIG || join(homedir(), '.claude-board', 'runner.json');
  const memory: Memory = { failedAt: new Map(), blockedTold: new Set(), runnerToldAt: 0 };
  let code = 0;
  for (;;) {
    try {
      if (!(await locked())) { say('another supervisor is running'); process.exit(1); }
      const now = ((await sql`select now() as t`)[0]!.t as Date).getTime(); // the board's clock: planTick compares DB times
      const runnerConfig = existsSync(configPath) ? configPath : null;
      for (const line of await tick({ sql, run: realRun, dryRun, now, memory, runnerConfig, probe })) say(line);
      code = 0;
    } catch (e) { say(`tick failed: ${msg(e)}`); code = 1; }
    if (dryRun || once) break;
    await new Promise((r) => setTimeout(r, 60_000));
  }
  process.exit(code);
}
