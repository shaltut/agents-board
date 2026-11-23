// cb squad up: start a project's missing squad sessions through herdr. planSquad is pure (tested);
// squadUp is the thin herdr runner (proved by the live check, not unit tests).
import { spawnSync } from 'node:child_process';

type Machine = { herdr: string | null; repo: string; board: string };
type Role = { count?: number; model: string; machine: string };
export type Squad = { machines: Record<string, Machine>; roles: Record<string, Role>; areas: string[] };
export type Launch = { name: string; role: string; area?: string; model: string; machine: string; herdr: string | null; cwd: string; settings: string; prompt: string };

const LETTER: Record<string, string> = { architect: 'A', builder: 'B', reviewer: 'R', qa: 'Q', investigator: 'I' };
const ORDER = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'];
const MAC = 'macbook', MAC_CAP = 8;

export function planSquad(project: string, squad: Squad, live: { actor: string; machine: string }[], herdrAgents: Record<string, string[]>, macAgents = 0) {
  const want: { name: string; role: string; area?: string }[] = [];
  for (const role of ORDER.filter((r) => squad.roles[r])) {
    const m = squad.roles[role].machine;
    if (role === 'lead') want.push({ name: `orch@${m}`, role });
    else if (role === 'owner') for (const area of squad.areas) want.push({ name: `${project}-O-${area}@${m}`, role, area });
    else for (let i = 1; i <= (squad.roles[role].count ?? 1); i++) want.push({ name: `${project}-${LETTER[role]}${i}@${m}`, role });
  }
  const running = new Set([...live.map((l) => l.actor), ...Object.values(herdrAgents).flat()]);
  // every session already on the Mac, any project, counts toward the cap
  // macAgents = how many agents herdr itself lists on the Mac (catches quiet or unnamed ones)
  let mac = Math.max(new Set([...live.filter((l) => l.machine === MAC).map((l) => l.actor), ...(herdrAgents[MAC] ?? [])]).size, macAgents);
  const out = { start: [] as Launch[], skip: [] as string[], refused: [] as string[] };
  for (const w of want) {
    // a live session named exactly `orch` is the lead, whatever machine the squad file puts it on
    if (running.has(w.name) || (w.role === 'lead' && running.has('orch'))) { out.skip.push(w.name); continue; }
    const machine = w.name.split('@')[1], mc = squad.machines[machine], role = squad.roles[w.role];
    if (machine === MAC && mac >= MAC_CAP) { out.refused.push(w.name); continue; }
    if (machine === MAC) mac++;
    out.start.push({
      ...w, model: role.model, machine, herdr: mc.herdr, cwd: mc.repo,
      settings: `${mc.board.replace(/[\/]+$/, '')}/kit/permissions/${w.role}.json`,
      prompt: `cb iam ${w.name} ${project} --role ${w.role}${w.area ? ` --area ${w.area}` : ''} --model ${role.model}, then cb role ${w.role}, then cb next`,
    });
  }
  return out;
}

const run = (m: string | null, args: string[], timeout = 180_000) => spawnSync('herdr', [...(m ? ['--machine', m] : []), ...args], { encoding: 'utf8', timeout });

// `herdr agent get <name>`: exit 0 = running, agent_not_found = not running, anything else = could not tell.
export function classifyAgentGet(r: { status: number | null; stderr?: string | null; error?: unknown }): 'live' | 'absent' | 'unknown' {
  if (r.error) return 'unknown';
  if (r.status === 0) return 'live';
  return r.status === 1 && /agent_not_found/.test(r.stderr ?? '') ? 'absent' : 'unknown';
}

const herdr = (m: string | null, args: string[]) => {
  const r = run(m, args);
  if (r.status !== 0) throw new Error((r.error?.message || r.stderr || r.stdout || 'herdr failed').trim());
  try { return JSON.parse(r.stdout); } catch { return null; }
};
const find = (o: any, key: string): any => {
  if (o && typeof o === 'object') {
    if (key in o) return o[key];
    for (const v of Object.values(o)) { const f = find(v, key); if (f !== undefined) return f; }
  }
};

export async function squadUp(project: string, dryRun: boolean, callFn: (fn: string, a: any) => Promise<unknown>): Promise<string> {
  const squad = await callFn('squad_get', { project }) as Squad | null;
  if (!squad) throw new Error(`${project} has no squad yet: write one with cb squad set ${project} -f <file>`);
  const rows = await callFn('sessions_overview', { project: null }) as any[];
  const live = rows.filter((r) => r.live).map((r) => ({ actor: r.actor as string, machine: (r.actor.split('@')[1] ?? r.machine) as string }));
  const lines: string[] = [];
  let macAgents = 0, macDown = false;
  const mac = squad.machines[MAC];
  if (mac) {
    try { macAgents = (find(herdr(mac.herdr, ['agent', 'list']), 'agents') ?? []).length; } catch { macDown = true; }
  }
  // 1) plan, 2) ask herdr whether each planned name already runs, 3) plan again with the answers
  const herdrAgents: Record<string, string[]> = {};
  const unknown = new Set<string>();
  for (const l of planSquad(project, squad, live, {}, macAgents).start) {
    if (l.machine === MAC && macDown) { unknown.add(l.name); continue; }
    const c = classifyAgentGet(run(l.herdr, ['agent', 'get', l.name], 30_000));
    if (c === 'live') (herdrAgents[l.machine] ??= []).push(l.name);
    else if (c === 'unknown') unknown.add(l.name);
  }
  const plan = planSquad(project, squad, live, herdrAgents, macAgents);
  const toStart = plan.start.filter((l) => !unknown.has(l.name));
  for (const l of plan.start) if (unknown.has(l.name)) lines.push(`skip ${l.name}: could not check herdr on ${l.machine}`);
  for (const n of plan.skip) lines.push(`skip ${n}: live`);
  for (const n of plan.refused) lines.push(`refused ${n}: the Mac already has ${MAC_CAP} live sessions`);
  for (const l of toStart) lines.push(`start ${l.name} (${l.role}, ${l.model}) on ${l.machine}`);
  if (dryRun) return lines.join('\n');
  // Only tabs made in this run are reused: two panes per tab, never an existing pane.
  const tabs: Record<string, { pane: string; panes: number }> = {};
  for (const l of toStart) {
    try {
      let pane: string;
      const t = tabs[l.machine];
      if (t && t.panes < 2) { pane = find(herdr(l.herdr, ['pane', 'split', '--pane', t.pane, '--direction', 'right', '--cwd', l.cwd, '--no-focus']), 'pane_id'); }
      else { pane = find(herdr(l.herdr, ['tab', 'create', '--cwd', l.cwd, '--label', l.name, '--no-focus']), 'pane_id'); }
      if (!pane) throw new Error('herdr returned no pane id');
      herdr(l.herdr, ['agent', 'start', l.name, '--kind', 'claude', '--pane', pane, '--timeout', '120000', '--', '--model', l.model, '--permission-mode', 'bypassPermissions', '--settings', l.settings]);
      if (t && t.panes < 2) t.panes++; else tabs[l.machine] = { pane, panes: 1 }; // tab state only once the agent is up
      herdr(l.herdr, ['agent', 'prompt', l.name, l.prompt]);
      lines.push(`started ${l.name}`);
    } catch (e) { lines.push(`failed ${l.name}: ${(e as Error).message}`); }
  }
  return lines.join('\n');
}
