// cb squad up: start a project's missing squad sessions through herdr. planSquad is pure (tested);
// squadUp is the thin herdr runner (proved by the live check, not unit tests).
import { spawnSync } from 'node:child_process';

// machine.repo: the one repo's folder of a squad without repos; with repos each repo lists its own paths (#3703)
// machine.workspace: the herdr workspace (its label) new sessions open in; none: herdr's focused one (#3719)
type Machine = { herdr: string | null; repo?: string; board: string; workspace?: string };
type Role = { count?: number | Record<string, number>; model: string; machine: string };
type Repo = { home: boolean; paths: Record<string, string> };
// protected (#3746): branch names or * globs; each session's pane gets CB_PROTECTED_BRANCHES, read by the push hook
export type Squad = { machines: Record<string, Machine>; roles: Record<string, Role>; repos?: Record<string, Repo>;
  areas: (string | { name: string; repo: string })[]; supervise?: boolean; protected?: string[] };
export type Want = { name: string; role: string; area?: string; repo: string };
// env: set in the session's pane (herdr --env), so the agent and its hooks inherit it
export type Launch = { name: string; role: string; area?: string; repo: string; model: string; machine: string; herdr: string | null; cwd: string; settings: string; prompt: string; workspace?: string; env?: Record<string, string> };

const LETTER: Record<string, string> = { architect: 'A', builder: 'B', reviewer: 'R', qa: 'Q', investigator: 'I' };
const ORDER = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'];
const MAC = 'macbook', MAC_CAP = 8;

type Live = { actor: string; machine: string; project?: string | null; role?: string | null };
// a session not live now, as sessions_overview gives it: its actor's latest session, last_seen as an ISO time
type Seen = { actor: string; project?: string | null; role?: string | null; last_seen?: string | null };
export type QuietLead = { actor: string; mins: number };

// A session's role as cb._role reads it: unset, an orch name is the lead
const roleOf = (l: { actor: string; role?: string | null }) => l.role ?? (l.actor === 'orch' || l.actor.startsWith('orch@') ? 'lead' : null);
const DAY_MS = 24 * 3600_000; // cb.triagers' window: a lead seen within it still leads

/** The squad's wanted sessions with the lead settled against who is live (#3746). A project's lead is the session live in
 *  it with the lead role, whatever its name: then no lead is wanted, unless it goes by one of the squad's lead names (kept,
 *  so it is skipped as live). A lead-role session of the project seen in the last day but not live is still its lead: no
 *  second lead is started beside it (quietLead names it), unless it goes by a squad lead name, restarted as before.
 *  orch@<m> live, or seen in the last day, in another project leads that one: this project's is <project>-orch@<m>. */
function wantNow(project: string, squad: Squad, live: Live[], quiet: Seen[] = [], now = Date.now()) {
  let quietLead: QuietLead | null = null;
  const want = wantList(project, squad).flatMap((w): Want[] => {
    if (w.role !== 'lead') return [w];
    const here = live.filter((x) => x.project === project), alt = { ...w, name: `${project}-${w.name}` };
    for (const c of [w, alt]) if (here.some((x) => x.actor === c.name)) return [c];
    if (here.some((x) => roleOf(x) === 'lead')) return [];
    const q = quiet.map((x) => ({ actor: x.actor, project: x.project, role: x.role, at: Date.parse(x.last_seen ?? '') }))
      .filter((x) => x.project === project && roleOf(x) === 'lead' && now - x.at < DAY_MS) // no last_seen: NaN, never in
      .sort((a, b) => b.at - a.at)[0];
    if (q) {
      for (const c of [w, alt]) if (q.actor === c.name) return [c];
      quietLead = { actor: q.actor, mins: Math.floor((now - q.at) / 60_000) };
      return [];
    }
    // orch@<m> live, or seen in the last day, bound to another project leads that one: taking its name here would rebind it
    const elsewhere = (x: { actor: string; project?: string | null }) => x.actor === w.name && !!x.project && x.project !== project;
    return [live.some(elsewhere) || quiet.some((x) => elsewhere(x) && now - Date.parse(x.last_seen ?? '') < DAY_MS) ? alt : w];
  });
  return { want, quietLead };
}
const minsAgo = (m: number) => (m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`);

/** A squad's repos, home first, then by name (as cb._repos_of). No repos: one repo, main, in each machine's repo folder. */
export function reposOf(squad: Squad): Record<string, Repo> {
  if (!squad.repos) return { main: { home: true, paths: Object.fromEntries(Object.entries(squad.machines).map(([k, m]) => [k, m.repo ?? ''])) } };
  return Object.fromEntries(Object.entries(squad.repos).sort(([a, x], [b, y]) => Number(!!y.home) - Number(!!x.home) || (a < b ? -1 : a > b ? 1 : 0)));
}
export const homeRepo = (squad: Squad) => Object.entries(reposOf(squad)).find(([, r]) => r.home)?.[0] ?? 'main';

// Names: the home repo keeps today's (demo-B1@m); another repo's builders and reviewers carry it (demo-dashboard-B1@m)
export function wantList(project: string, squad: Squad): Want[] {
  const want: Want[] = [], home = homeRepo(squad);
  for (const role of ORDER.filter((r) => squad.roles[r])) {
    const m = squad.roles[role].machine, count = squad.roles[role].count;
    if (role === 'lead') want.push({ name: `orch@${m}`, role, repo: home });
    else if (role === 'owner') for (const a of squad.areas) {
      const area = typeof a === 'string' ? a : a.name;
      want.push({ name: `${project}-O-${area}@${m}`, role, area, repo: typeof a === 'string' ? home : a.repo });
    }
    else if (role === 'builder' || role === 'reviewer') {
      const per = typeof count === 'object' ? count : { [home]: count ?? 1 };
      for (const repo of Object.keys(reposOf(squad))) for (let i = 1; i <= (per[repo] ?? 0); i++)
        want.push({ name: `${project}-${repo === home ? '' : `${repo}-`}${LETTER[role]}${i}@${m}`, role, repo });
    }
    else for (let i = 1; i <= (typeof count === 'number' ? count : 1); i++) want.push({ name: `${project}-${LETTER[role]}${i}@${m}`, role, repo: home });
  }
  return want;
}

// herdr agent names: a lowercase letter, then lowercase letters, digits, '-' or '_', 1-32 chars. The board name stays the actor.
export const herdrName = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
const validHerdrName = (n: string) => /^[a-z][a-z0-9_-]{0,31}$/.test(n);

export function promptCommand(l: { herdr: string | null; name: string; prompt: string }) {
  return `herdr${l.herdr ? ` --machine ${l.herdr}` : ''} agent prompt ${herdrName(l.name)} "${l.prompt}"`;
}

export function launchFor(project: string, squad: Squad, w: Want, first: 'next' | 'resume' = 'next'): Launch {
  const machine = w.name.split('@')[1], mc = squad.machines[machine], role = squad.roles[w.role], repos = reposOf(squad);
  // with repos: the session names its repo, and the architect and qa (who read across repos) get every repo's folder
  const across = squad.repos && (w.role === 'architect' || w.role === 'qa')
    ? `. Repos: ${Object.entries(repos).filter(([, r]) => r.paths[machine]).map(([k, r]) => `${k} ${r.paths[machine]}`).join(', ')}` : '';
  return {
    ...w, model: role.model, machine, herdr: mc.herdr, cwd: repos[w.repo]?.paths[machine] ?? '', ...(mc.workspace ? { workspace: mc.workspace } : {}),
    ...(squad.protected?.length ? { env: { CB_PROTECTED_BRANCHES: squad.protected.join(',') } } : {}),
    settings: `${mc.board.replace(/[\/]+$/, '')}/kit/permissions/${w.role}.json`,
    prompt: `cb iam ${w.name} ${project} --role ${w.role}${w.area ? ` --area ${w.area}` : ''} --model ${role.model}${squad.repos ? ` --repo ${w.repo}` : ''}, then cb role ${w.role}, then cb ${first}${across}`,
  };
}

// quiet: the sessions not live now (sessions_overview rows), read only to find a quiet lead
export function planSquad(project: string, squad: Squad, live: Live[], herdrAgents: Record<string, string[]>, macAgents = 0, quiet: Seen[] = []) {
  // the Mac cap counts by the herdr label: a machine whose herdr is 'macbook' is the Mac, whatever its key
  const isMac = (key: string) => key === MAC || squad.machines[key]?.herdr === MAC;
  const running = new Set([...live.map((l) => l.actor), ...Object.values(herdrAgents).flat()]);
  // every session already on the Mac, any project, counts toward the cap
  // macAgents = how many agents herdr itself lists on the Mac (catches quiet or unnamed ones)
  let mac = Math.max(new Set([...live.filter((l) => isMac(l.machine)).map((l) => l.actor),
    ...Object.entries(herdrAgents).filter(([k]) => isMac(k)).flatMap(([, v]) => v)]).size, macAgents);
  const { want, quietLead } = wantNow(project, squad, live, quiet);
  const out = { start: [] as Launch[], skip: [] as string[], refused: [] as string[], heldBy: {} as Record<string, string>, herdrOnly: [] as Launch[], quietLead };
  for (const w of want) {
    const machine = w.name.split('@')[1];
    const l = launchFor(project, squad, w);
    const onBoard = live.find((x) => x.actor === w.name);
    if (onBoard) {
      out.skip.push(w.name);
      if (w.role === 'lead' && onBoard.project && onBoard.project !== project) out.heldBy[w.name] = onBoard.project;
      continue;
    }
    if (running.has(w.name)) { out.skip.push(w.name); out.herdrOnly.push(l); continue; }
    if (isMac(machine) && mac >= MAC_CAP) { out.refused.push(w.name); continue; }
    if (isMac(machine)) mac++;
    out.start.push(l);
  }
  return out;
}

type Res = { status: number | null; stdout?: string | null; stderr?: string | null; error?: Error };
export type Runner = (m: string | null, args: string[], timeout?: number) => Res;
export const realRun: Runner = (m, args, timeout = 180_000) => spawnSync('herdr', [...(m ? ['--machine', m] : []), ...args], { encoding: 'utf8', timeout });

// `herdr agent get <name>`: exit 0 = running, agent_not_found = not running, anything else = could not tell.
export function classifyAgentGet(r: { status: number | null; stderr?: string | null; error?: unknown }): 'live' | 'absent' | 'unknown' {
  if (r.error) return 'unknown';
  if (r.status === 0) return 'live';
  return r.status === 1 && /agent_not_found/.test(r.stderr ?? '') ? 'absent' : 'unknown';
}

export const find = (o: any, key: string): any => {
  if (o && typeof o === 'object') {
    if (key in o) return o[key];
    for (const v of Object.values(o)) { const f = find(v, key); if (f !== undefined) return f; }
  }
};

/** One herdr call: its JSON (null when not JSON); throws herdr's own error text on a non-zero exit. */
export function herdrJson(run: Runner, m: string | null, args: string[], timeout?: number) {
  const r = run(m, args, timeout);
  if (r.status !== 0) throw new Error((r.error?.message || r.stderr || r.stdout || 'herdr failed').trim());
  try { return JSON.parse(r.stdout ?? ''); } catch { return null; }
}

// A pane herdr just made refuses agent start (agent_pane_busy) until its shell prompt is up: about 10 s of retries.
const BUSY_TRIES = 6, BUSY_WAIT_MS = 2000;
const sleep = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Start one session: a pane (a new tab, or a split of a tab in `tabs`, two panes per tab), the agent, its first
 *  prompt. ok: the agent is up (blocked: up but waiting on a startup dialog; the pane is kept). A launch that did not
 *  come up has its own pane closed, never any other. "started, prompt not sent" is ok: false with its pane. */
export function startOne(l: Launch, run: Runner, tabs: Record<string, { pane: string; panes: number }>, pause: (ms: number) => void = sleep): { line: string; pane?: string; blocked?: boolean; ok: boolean } {
  const herdr = (m: string | null, args: string[], timeout?: number) => herdrJson(run, m, args, timeout);
  if (!validHerdrName(herdrName(l.name))) return { ok: false, line: `failed ${l.name}: herdr name ${herdrName(l.name)} is invalid` };
  let pane: string | undefined, started = false;
  // the launch's env goes on every call that makes its pane: herdr starts the agent there, and the agent inherits it
  const env = Object.entries(l.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  try {
    const t = tabs[l.machine];
    if (t && t.panes < 2) pane = find(herdr(l.herdr, ['pane', 'split', '--pane', t.pane, '--direction', 'right', '--cwd', l.cwd, '--no-focus', ...env]), 'pane_id');
    else if (l.workspace) {
      // the squad's workspace by label; missing: made here, and its first pane takes this session
      const list = find(herdr(l.herdr, ['workspace', 'list']), 'workspaces');
      if (!Array.isArray(list)) throw new Error('herdr workspace list gave no workspaces'); // never a second workspace by mistake
      const ws = list.find((w: any) => w.label === l.workspace)?.workspace_id;
      pane = ws ? find(herdr(l.herdr, ['tab', 'create', '--workspace', ws, '--cwd', l.cwd, '--label', l.name, '--no-focus', ...env]), 'pane_id')
        : find(find(herdr(l.herdr, ['workspace', 'create', '--cwd', l.cwd, '--label', l.workspace, '--no-focus', ...env]), 'root_pane'), 'pane_id');
    }
    else pane = find(herdr(l.herdr, ['tab', 'create', '--cwd', l.cwd, '--label', l.name, '--no-focus', ...env]), 'pane_id');
    if (!pane) throw new Error('herdr returned no pane id');
    let blocked = false;
    try {
      for (let i = 1; ; i++) {
        try {
          herdr(l.herdr, ['agent', 'start', herdrName(l.name), '--kind', 'claude', '--pane', pane, '--timeout', '120000', '--', '--model', l.model, '--permission-mode', 'bypassPermissions', '--settings', l.settings]);
          break;
        } catch (e) {
          // agent_pane_busy: the new pane's shell is not up yet (a split made a moment ago, a slow shell profile)
          if (i >= BUSY_TRIES || !/agent_pane_busy/.test((e as Error).message)) throw e;
          pause(BUSY_WAIT_MS);
        }
      }
    } catch (e) {
      // agent_not_ready: Claude Code waits on a startup dialog (folder trust, bypass warning). The agent exists: keep the pane.
      if (!/agent_not_ready/.test((e as Error).message)) throw e;
      blocked = true;
    }
    started = true;
    if (t && t.panes < 2) t.panes++; else tabs[l.machine] = { pane, panes: 1 }; // tab state only once the agent is up
    if (blocked) return { ok: true, blocked, pane, line: `blocked ${l.name}: a startup dialog is waiting (folder trust or bypass warning). Answer it in herdr pane ${pane}${l.herdr ? ` on ${l.herdr}` : ''}, then run: ${promptCommand(l)}` };
    herdr(l.herdr, ['agent', 'prompt', herdrName(l.name), l.prompt]);
    return { ok: true, pane, line: `started ${l.name}` };
  } catch (e) {
    if (started) return { ok: false, pane, line: `started ${l.name}, prompt not sent: ${promptCommand(l)}` };
    if (pane) try { herdr(l.herdr, ['pane', 'close', pane]); } catch {}
    return { ok: false, line: `failed ${l.name}: ${(e as Error).message}` };
  }
}

export async function squadUp(project: string, dryRun: boolean, callFn: (fn: string, a: any) => Promise<unknown>, run: Runner = realRun): Promise<string> {
  const herdr = (m: string | null, args: string[], timeout?: number) => herdrJson(run, m, args, timeout);
  const squad = await callFn('squad_get', { project }) as Squad | null;
  if (!squad) throw new Error(`${project} has no squad yet: write one with cb squad set ${project} -f <file>`);
  const rows = await callFn('sessions_overview', { project: null }) as any[];
  const live = rows.filter((r) => r.live).map((r) => ({ actor: r.actor as string, machine: (r.actor.split('@')[1] ?? r.machine) as string,
    project: (r.project ?? null) as string | null, role: (r.role ?? null) as string | null }));
  const quiet = rows.filter((r) => !r.live).map((r) => ({ actor: r.actor as string, project: (r.project ?? null) as string | null,
    role: (r.role ?? null) as string | null, last_seen: (r.last_seen ?? null) as string | null }));
  const lines: string[] = [];
  let macAgents = 0, macDown = false;
  const macKey = Object.keys(squad.machines).find((k) => squad.machines[k].herdr === MAC);
  if (macKey) {
    try { macAgents = (find(herdr(MAC, ['agent', 'list'], 30_000), 'agents') ?? []).length; } catch { macDown = true; }
  }
  const isMac = (k: string) => k === MAC || squad.machines[k]?.herdr === MAC;
  // Ask herdr about EVERY wanted name that is not live on the board (a quiet session is live in herdr only), then plan once.
  const herdrAgents: Record<string, string[]> = {};
  const unknown = new Set<string>();
  const onBoard = new Set(live.map((l) => l.actor));
  for (const w of wantNow(project, squad, live, quiet).want) {
    if (onBoard.has(w.name)) continue;
    const machine = w.name.split('@')[1];
    if (isMac(machine) && macDown) { unknown.add(w.name); continue; }
    if (!validHerdrName(herdrName(w.name))) continue; // fails at launch with a clear line
    const c = classifyAgentGet(run(squad.machines[machine].herdr, ['agent', 'get', herdrName(w.name)], 30_000));
    if (c === 'live') (herdrAgents[machine] ??= []).push(w.name);
    else if (c === 'unknown') unknown.add(w.name);
  }
  const plan = planSquad(project, squad, live, herdrAgents, macAgents, quiet);
  const toStart = plan.start.filter((l) => !unknown.has(l.name));
  for (const l of plan.start) if (unknown.has(l.name)) lines.push(`skip ${l.name}: could not check herdr on ${l.machine}`);
  const q = plan.quietLead;
  if (q) lines.push(`skip lead: ${q.actor} leads ${project} but is not live (last seen ${minsAgo(q.mins)}): restart it, or cb iam <name> ${project} --role lead`);
  const herdrOnly = new Set(plan.herdrOnly.map((l) => l.name));
  for (const n of plan.skip) {
    if (plan.heldBy[n]) lines.push(`skip ${n}: lead name held by project ${plan.heldBy[n]}`);
    else if (!herdrOnly.has(n)) lines.push(`skip ${n}: live`);
  }
  for (const l of plan.herdrOnly) lines.push(`skip ${l.name}: running in herdr but not on the board (not bound?)`, `  ${promptCommand(l)}`);
  for (const n of plan.refused) lines.push(`refused ${n}: the Mac already has ${MAC_CAP} live sessions`);
  for (const l of toStart) lines.push(`start ${l.name} (${l.role}, ${l.model}) on ${l.machine}`);
  if (dryRun) return lines.join('\n');
  // Only tabs made in this run are reused: two panes per tab, never an existing pane.
  const tabs: Record<string, { pane: string; panes: number }> = {};
  for (const l of toStart) lines.push(startOne(l, run, tabs).line);
  return lines.join('\n');
}
