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

type Live = { actor: string; machine: string; project?: string | null };

export function wantList(project: string, squad: Squad) {
  const want: { name: string; role: string; area?: string }[] = [];
  for (const role of ORDER.filter((r) => squad.roles[r])) {
    const m = squad.roles[role].machine;
    if (role === 'lead') want.push({ name: `orch@${m}`, role });
    else if (role === 'owner') for (const area of squad.areas) want.push({ name: `${project}-O-${area}@${m}`, role, area });
    else for (let i = 1; i <= (squad.roles[role].count ?? 1); i++) want.push({ name: `${project}-${LETTER[role]}${i}@${m}`, role });
  }
  return want;
}

export function promptCommand(l: { herdr: string | null; name: string; prompt: string }) {
  return `herdr${l.herdr ? ` --machine ${l.herdr}` : ''} agent prompt ${l.name} "${l.prompt}"`;
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
    const machine = w.name.split('@')[1], mc = squad.machines[machine], role = squad.roles[w.role];
    const l: Launch = {
      ...w, model: role.model, machine, herdr: mc.herdr, cwd: mc.repo,
      settings: `${mc.board.replace(/[\/]+$/, '')}/kit/permissions/${w.role}.json`,
      prompt: `cb iam ${w.name} ${project} --role ${w.role}${w.area ? ` --area ${w.area}` : ''} --model ${role.model}, then cb role ${w.role}, then cb next`,
    };
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
const realRun: Runner = (m, args, timeout = 180_000) => spawnSync('herdr', [...(m ? ['--machine', m] : []), ...args], { encoding: 'utf8', timeout });

// `herdr agent get <name>`: exit 0 = running, agent_not_found = not running, anything else = could not tell.
export function classifyAgentGet(r: { status: number | null; stderr?: string | null; error?: unknown }): 'live' | 'absent' | 'unknown' {
  if (r.error) return 'unknown';
  if (r.status === 0) return 'live';
  return r.status === 1 && /agent_not_found/.test(r.stderr ?? '') ? 'absent' : 'unknown';
}

const find = (o: any, key: string): any => {
  if (o && typeof o === 'object') {
    if (key in o) return o[key];
    for (const v of Object.values(o)) { const f = find(v, key); if (f !== undefined) return f; }
  }
};

export async function squadUp(project: string, dryRun: boolean, callFn: (fn: string, a: any) => Promise<unknown>, run: Runner = realRun): Promise<string> {
  const herdr = (m: string | null, args: string[], timeout?: number) => {
    const r = run(m, args, timeout);
    if (r.status !== 0) throw new Error((r.error?.message || r.stderr || r.stdout || 'herdr failed').trim());
    try { return JSON.parse(r.stdout ?? ''); } catch { return null; }
  };
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
    const c = classifyAgentGet(run(squad.machines[machine].herdr, ['agent', 'get', w.name], 30_000));
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
  for (const l of toStart) {
    let pane: string | undefined, started = false;
    try {
      const t = tabs[l.machine];
      if (t && t.panes < 2) pane = find(herdr(l.herdr, ['pane', 'split', '--pane', t.pane, '--direction', 'right', '--cwd', l.cwd, '--no-focus']), 'pane_id');
      else pane = find(herdr(l.herdr, ['tab', 'create', '--cwd', l.cwd, '--label', l.name, '--no-focus']), 'pane_id');
      if (!pane) throw new Error('herdr returned no pane id');
      herdr(l.herdr, ['agent', 'start', l.name, '--kind', 'claude', '--pane', pane, '--timeout', '120000', '--', '--model', l.model, '--permission-mode', 'bypassPermissions', '--settings', l.settings]);
      started = true;
      if (t && t.panes < 2) t.panes++; else tabs[l.machine] = { pane, panes: 1 }; // tab state only once the agent is up
      herdr(l.herdr, ['agent', 'prompt', l.name, l.prompt]);
      lines.push(`started ${l.name}`);
    } catch (e) {
      if (started) lines.push(`started ${l.name}, prompt not sent: ${promptCommand(l)}`);
      else {
        lines.push(`failed ${l.name}: ${(e as Error).message}`);
        // a pane this run made for a launch that did not come up: close it, never any other pane
        if (pane) try { herdr(l.herdr, ['pane', 'close', pane]); } catch {}
      }
    }
  }
  return lines.join('\n');
}
