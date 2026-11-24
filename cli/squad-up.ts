// cb squad up: start a project's missing squad sessions through herdr. planSquad is pure (tested);
// squadUp is the thin herdr runner (proved by the live check, not unit tests).
import { spawnSync } from 'node:child_process';

// machine.repo: the one repo's folder of a squad without repos; with repos each repo lists its own paths (#3703)
// machine.workspace: the herdr workspace (its label) new sessions open in; none: herdr's focused one (#3719)
type Machine = { herdr: string | null; repo?: string; board: string; workspace?: string };
type Role = { count?: number | Record<string, number>; model: string; machine: string };
type Repo = { home: boolean; paths: Record<string, string> };
export type Squad = { machines: Record<string, Machine>; roles: Record<string, Role>; repos?: Record<string, Repo>;
  areas: (string | { name: string; repo: string })[]; supervise?: boolean };
export type Want = { name: string; role: string; area?: string; repo: string };
export type Launch = { name: string; role: string; area?: string; repo: string; model: string; machine: string; herdr: string | null; cwd: string; settings: string; prompt: string; workspace?: string };

const LETTER: Record<string, string> = { architect: 'A', builder: 'B', reviewer: 'R', qa: 'Q', investigator: 'I' };
const ORDER = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'];
const MAC = 'macbook', MAC_CAP = 8;

type Live = { actor: string; machine: string; project?: string | null };

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
    settings: `${mc.board.replace(/[\/]+$/, '')}/kit/permissions/${w.role}.json`,
    prompt: `cb iam ${w.name} ${project} --role ${w.role}${w.area ? ` --area ${w.area}` : ''} --model ${role.model}${squad.repos ? ` --repo ${w.repo}` : ''}, then cb role ${w.role}, then cb ${first}${across}`,
  };
}

export function planSquad(project: string, squad: Squad, live: Live[], herdrAgents: Record<string, string[]>, macAgents = 0) {
  // the Mac cap counts by the herdr label: a machine whose herdr is 'macbook' is the Mac, whatever its key
  const isMac = (key: string) => key === MAC || squad.machines[key]?.herdr === MAC;
  const running = new Set([...live.map((l) => l.actor), ...Object.values(herdrAgents).flat()]);
  // every session already on the Mac, any project, counts toward the cap
  // macAgents = how many agents herdr itself lists on the Mac (catches quiet or unnamed ones)
  let mac = Math.max(new Set([...live.filter((l) => isMac(l.machine)).map((l) => l.actor),
    ...Object.entries(herdrAgents).filter(([k]) => isMac(k)).flatMap(([, v]) => v)]).size, macAgents);
  const out = { start: [] as Launch[], skip: [] as string[], refused: [] as string[], heldBy: {} as Record<string, string>, herdrOnly: [] as Launch[] };
  for (const w of wantList(project, squad)) {
    const machine = w.name.split('@')[1];
    const l = launchFor(project, squad, w);
    const onBoard = live.find((x) => x.actor === w.name || (w.role === 'lead' && x.actor === 'orch'));
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

/** Start one session: a pane (a new tab, or a split of a tab in `tabs`, two panes per tab), the agent, its first
 *  prompt. ok: the agent is up (blocked: up but waiting on a startup dialog; the pane is kept). A launch that did not
 *  come up has its own pane closed, never any other. "started, prompt not sent" is ok: false with its pane. */
export function startOne(l: Launch, run: Runner, tabs: Record<string, { pane: string; panes: number }>): { line: string; pane?: string; blocked?: boolean; ok: boolean } {
  const herdr = (m: string | null, args: string[], timeout?: number) => herdrJson(run, m, args, timeout);
  if (!validHerdrName(herdrName(l.name))) return { ok: false, line: `failed ${l.name}: herdr name ${herdrName(l.name)} is invalid` };
  let pane: string | undefined, started = false;
  try {
    const t = tabs[l.machine];
    if (t && t.panes < 2) pane = find(herdr(l.herdr, ['pane', 'split', '--pane', t.pane, '--direction', 'right', '--cwd', l.cwd, '--no-focus']), 'pane_id');
    else if (l.workspace) {
      // the squad's workspace by label; missing: made here, and its first pane takes this session
      const list = find(herdr(l.herdr, ['workspace', 'list']), 'workspaces');
      if (!Array.isArray(list)) throw new Error('herdr workspace list gave no workspaces'); // never a second workspace by mistake
      const ws = list.find((w: any) => w.label === l.workspace)?.workspace_id;
      pane = ws ? find(herdr(l.herdr, ['tab', 'create', '--workspace', ws, '--cwd', l.cwd, '--label', l.name, '--no-focus']), 'pane_id')
        : find(find(herdr(l.herdr, ['workspace', 'create', '--cwd', l.cwd, '--label', l.workspace, '--no-focus']), 'root_pane'), 'pane_id');
    }
    else pane = find(herdr(l.herdr, ['tab', 'create', '--cwd', l.cwd, '--label', l.name, '--no-focus']), 'pane_id');
    if (!pane) throw new Error('herdr returned no pane id');
    let blocked = false;
    try {
      herdr(l.herdr, ['agent', 'start', herdrName(l.name), '--kind', 'claude', '--pane', pane, '--timeout', '120000', '--', '--model', l.model, '--permission-mode', 'bypassPermissions', '--settings', l.settings]);
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
  const live = rows.filter((r) => r.live).map((r) => ({ actor: r.actor as string, machine: (r.actor.split('@')[1] ?? r.machine) as string, project: (r.project ?? null) as string | null }));
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
  for (const w of wantList(project, squad)) {
    if (onBoard.has(w.name) || (w.role === 'lead' && onBoard.has('orch'))) continue;
    const machine = w.name.split('@')[1];
    if (isMac(machine) && macDown) { unknown.add(w.name); continue; }
    if (!validHerdrName(herdrName(w.name))) continue; // fails at launch with a clear line
    const c = classifyAgentGet(run(squad.machines[machine].herdr, ['agent', 'get', herdrName(w.name)], 30_000));
    if (c === 'live') (herdrAgents[machine] ??= []).push(w.name);
    else if (c === 'unknown') unknown.add(w.name);
  }
  const plan = planSquad(project, squad, live, herdrAgents, macAgents);
  const toStart = plan.start.filter((l) => !unknown.has(l.name));
  for (const l of plan.start) if (unknown.has(l.name)) lines.push(`skip ${l.name}: could not check herdr on ${l.machine}`);
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
