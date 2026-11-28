// cb models (#4763): each agent CLI knows its own models, and only on the machine it runs on (the board server has no
// agent CLIs). So a machine reads its CLIs' list commands and sends the names to the board, where the settings page offers
// them. What a CLI prints is data: only names of the agent's own shape are taken (cb.machine_models_set checks again).
import { findOnPath, launchFlags, runCli, BOARD, type SpawnSyncFn } from './agent-flags.ts';
import { spawnSync } from 'node:child_process';

export type ListedAgent = 'codex' | 'opencode' | 'agy';
export type ModelEntry = { id: string; efforts?: string[] };
export type MachineModels = Record<string, Record<string, { models: ModelEntry[]; at: string }>>;
/** Each CLI's own list command. Claude Code has none: the page offers its four names. */
export const LIST_ARGS: Record<ListedAgent, string[]> = { codex: ['debug', 'models'], opencode: ['models'], agy: ['models'] };
const AGENTS = Object.keys(LIST_ARGS) as ListedAgent[];
const command = (agent: ListedAgent) => `${agent} ${LIST_ARGS[agent].join(' ')}`;

// a line that is a model: agy prints "<id><tab><name>", opencode "<provider>/<model>" alone
const LINE: Record<'agy' | 'opencode', RegExp> = {
  agy: /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\t|\s{2,})\S/,
  opencode: /^([a-z0-9][a-z0-9._-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95})\s*$/,
};

export function parseModels(agent: ListedAgent, out: string): ModelEntry[] {
  if (agent !== 'codex') return out.split(/\r?\n/).flatMap((l) => { const id = LINE[agent].exec(l)?.[1]; return id ? [{ id }] : []; });
  let list: any;
  try { list = JSON.parse(out.slice(out.indexOf('{'))).models; } catch { /* below */ }
  if (!Array.isArray(list)) throw new Error(`${command(agent)} did not print its JSON list`);
  return list.flatMap((m: any) => {
    if (typeof m?.slug !== 'string' || m.visibility === 'hide') return [];
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels.map((e: any) => e?.effort).filter((e: unknown): e is string => typeof e === 'string') : [];
    return [{ id: m.slug, ...(efforts.length ? { efforts } : {}) }];
  });
}

/** path null: the CLI is not installed here; error: it is, but its list command did not answer. */
export type Lister = (agent: ListedAgent) => { path: string | null; out?: string; err?: string; error?: string };

// #4856: agy over ssh on a Mac answered this though it was signed in there. Only matched, never repeated
const AGY_SIGNED_OUT = /please sign in to view available models/i;

/** Runs the CLI's list command, `timeoutMs` at most (30 s: agy asks its service), with the seats' update-off env.
 *  Codex's answer carries every model's prompt, hundreds of KB, so up to 4 MB is read. */
export function makeLister(o: { timeoutMs?: number; env?: NodeJS.ProcessEnv; spawn?: SpawnSyncFn } = {}): Lister {
  const timeoutMs = o.timeoutMs ?? 30_000, base = o.env ?? process.env, spawn = o.spawn ?? (spawnSync as unknown as SpawnSyncFn);
  return (agent) => {
    const path = findOnPath(agent, base);
    if (!path) return { path: null };
    const updateOff = Object.fromEntries(Object.entries(launchFlags(agent, BOARD, BOARD).env).filter(([k]) => /AUTO_?UPDATE/i.test(k)));
    const [r] = runCli(path, [LIST_ARGS[agent]], timeoutMs, { ...base, ...updateOff }, spawn, 4 * 1024 * 1024);
    if (r!.error) return { path, error: r!.error === 'ETIMEDOUT' ? `timed out after ${timeoutMs / 1000} s` : r!.error };
    if (r!.status !== 0) return { path, error: `exit ${r!.status}`, out: r!.out, err: r!.err };
    return { path, out: r!.out, err: r!.err };
  };
}

/** Reads every installed CLI's list and sends what it could read as `machine`'s. One line per agent. A list that cannot
 *  be read is left as the board has it. */
export async function reportModels(o: { machine: string; list: Lister;
  save: (machine: string, lists: Partial<Record<ListedAgent, ModelEntry[]>>) => Promise<Record<string, number>> }): Promise<string[]> {
  const lists: Partial<Record<ListedAgent, ModelEntry[]>> = {}, said: Partial<Record<ListedAgent, string>> = {};
  for (const agent of AGENTS) {
    const r = o.list(agent);
    if (!r.path) { said[agent] = `${agent}: not installed here`; continue; }
    let why = r.error;
    if (!why) {
      try {
        const models = parseModels(agent, r.out ?? '');
        if (models.length) { lists[agent] = models; continue; }
        why = `no model names in what \`${command(agent)}\` printed`;
      } catch (e: any) { why = String(e?.message ?? e); }
    }
    if (agent === 'agy' && AGY_SIGNED_OUT.test(`${r.out ?? ''}\n${r.err ?? ''}`)) {
      said[agent] = 'agy: list not read (agy is not signed in in this session): the board keeps the last one. On ssh to a machine where agy is signed in, run `cb models report` in a herdr pane there instead; else sign in with `agy`';
      continue;
    }
    said[agent] = `${agent}: list not read (${why}): the board keeps the last one. Run \`${command(agent)}\` here to see why`;
  }
  const kept = Object.keys(lists).length ? await o.save(o.machine, lists) : {};
  return AGENTS.map((a) => said[a] ?? `${a}: ${kept[a] ?? 0} models sent for ${o.machine}`);
}

/** cb models: what each machine last sent. */
export function modelsShow(all: MachineModels): string {
  const machines = Object.keys(all).sort();
  if (!machines.length) return 'No machine has sent a model list yet. On each machine run: cb models report';
  return machines.flatMap((m) => [m, ...Object.keys(all[m]!).sort().map((a) => {
    const { models, at } = all[m]![a]!;
    return `  ${a} (${models.length}, sent ${String(at).slice(0, 10)}): ${models.map((x) => x.id).join(', ')}`;
  })]).join('\n');
}
