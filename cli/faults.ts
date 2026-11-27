// cb faults (#4535): this machine's fault log, grouped by template. Reads only the local files (kit/fault-line.mjs)
// and triage.json; never connects to the board, so it works while the board is down, which is when it matters most.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { faultsHome, readFaults } from '../kit/fault-line.mjs';
import { machine } from '../server/db.ts';

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3600_000, d: 86400_000, w: 7 * 86400_000 };

/** --since 30m | 24h | 7d | 2w (the cb usage form) → milliseconds. */
export function sinceMs(s: string | undefined): number {
  const m = /^(\d{1,5})([mhdw])$/.exec(s ?? '24h');
  if (!m) throw new Error(`--since takes a number and m, h, d or w (e.g. --since 24h, --since 7d), not "${s}"`);
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}

export type Group = {
  tmpl: string; kind: string; src: string; code: string | null; msg: string; cmds: string[]; sub: string | null;
  flags: string[]; release: string | null; count: number; seats: number; first: string; last: string; releases: string[]; ms_p50: number; ms_max: number;
};

/** One group per template: count (summing n), distinct seats (machine + pane; no pane = one seat per machine), the
 *  commands, first and last seen, the releases seen, and the duration's median and max. Biggest first. */
export function groupFaults(lines: any[]): Group[] {
  const by = new Map<string, any[]>();
  for (const l of lines) {
    if (typeof l?.tmpl !== 'string' || !/^ft-[0-9a-f]{12}$/.test(l.tmpl)) continue; // the cap line has none
    (by.get(l.tmpl) ?? by.set(l.tmpl, []).get(l.tmpl)!).push(l);
  }
  const groups = [...by.entries()].map(([tmpl, ls]) => {
    const ms = ls.map((l) => Number(l.ms) || 0).sort((a, b) => a - b);
    const at = ls.map((l) => String(l.at)).sort();
    const uniq = (f: (l: any) => unknown) => [...new Set(ls.map(f).filter((x): x is string => typeof x === 'string'))].sort();
    const l0 = ls[ls.length - 1];
    return {
      tmpl, kind: l0.kind, src: l0.src, code: l0.code ?? null, msg: l0.msg ?? '', cmds: uniq((l) => l.cmd), sub: l0.sub ?? null,
      flags: [...new Set(ls.flatMap((l) => (Array.isArray(l.flags) ? l.flags : [])))].sort() as string[], release: l0.release ?? null,
      count: ls.reduce((n, l) => n + (Number(l.n) || 1), 0), seats: new Set(ls.map((l) => `${l.machine}\0${l.pane ?? ''}`)).size,
      first: at[0]!, last: at[at.length - 1]!, releases: uniq((l) => l.release),
      ms_p50: ms[Math.floor((ms.length - 1) / 2)] ?? 0, ms_max: ms[ms.length - 1] ?? 0,
    };
  });
  return groups.sort((a, b) => b.count - a.count || a.tmpl.localeCompare(b.tmpl));
}

export type Marker = { last_run?: string; groups: Record<string, { verdict: string; card?: number | null; at: string; count: number; release?: string | null; by: 'agent' | 'rule' }> };

/** triage.json: what was judged on this machine (cli/triage.ts writes it). Missing or broken = nothing judged yet. */
export function readMarker(env = process.env): Marker {
  try {
    const m = JSON.parse(readFileSync(join(faultsHome(env), 'triage.json'), 'utf8'));
    if (m && typeof m === 'object' && m.groups && typeof m.groups === 'object') return m;
  } catch {}
  return { groups: {} };
}

const hm = (iso: string) => iso.slice(11, 16);
const span = (g: Group) => (g.first.slice(0, 10) === g.last.slice(0, 10) ? `${hm(g.first)}-${hm(g.last)}` : `${g.first.slice(5, 10)}-${g.last.slice(5, 10)}`);
export function triageWord(t: Marker['groups'][string] | undefined): string {
  if (!t) return 'not triaged';
  if (t.card && (t.verdict === 'bug' || t.verdict === 'misleading')) return `filed #${t.card}`;
  return t.card ? `${t.verdict}, same as #${t.card}` : t.verdict === 'user_error' || t.verdict === 'infra' || t.verdict === 'noise' ? `${t.verdict} (not filed)` : t.verdict;
}

export function faultsCmd(o: { since?: string }) {
  const since = o.since ?? '24h';
  const ms = sinceMs(since);
  const lines = readFaults(Date.now() - ms);
  const groups = groupFaults(lines);
  const marker = readMarker();
  const home = faultsHome();
  const json = { machine: machine(), since, home, lines, groups: groups.map((g) => ({ ...g, triage: marker.groups[g.tmpl] ?? null })) };
  if (!groups.length) return { out: `no faults on ${machine()} in the last ${since} (log: ${home})`, json };
  const cmdText = (g: Group) => (g.cmds.length > 2 ? `${g.cmds.slice(0, 2).join(',')},+${g.cmds.length - 2}` : g.cmds.join(',') || g.src);
  const rows = groups.slice(0, 40).map((g) =>
    `${String(g.count).padStart(6)}  ${g.kind.padEnd(11)} ${cmdText(g).padEnd(16).slice(0, 16)} ${span(g).padEnd(12)} ${g.tmpl}  ${triageWord(marker.groups[g.tmpl])}`);
  return {
    out: [`faults on ${machine()} in the last ${since}: ${lines.length} lines in ${groups.length} groups (log: ${home})`,
      ' count  kind        command          first-last   template         triage', ...rows,
      ...(groups.length > 40 ? [`  ... and ${groups.length - 40} more groups (cb faults --json lists every one)`] : []),
      "each group's message: cb faults --json   ·   judge and file the real ones: cb triage --dry-run, then cb triage"].join('\n'),
    json,
  };
}
