// cb usage (#4349): the session token ledger, read-only. The numbers come from each session's Stop hook
// (hooks/usage-stop.mjs → cb.usage_report); this only reads cb.usage_summary. Logic here, cb.ts only dispatches.
// Not in the web's RPC list: nothing on the web reads it, and with no project it covers every project.

import { call } from './board.ts';

const UNITS: Record<string, string> = { m: 'minutes', h: 'hours', d: 'days', w: 'weeks' };

/** --since 24h | 30m | 7d | 2w → a Postgres interval. */
export function sinceInterval(s: string | undefined): string {
  const m = /^(\d{1,5})([mhdw])$/.exec(s ?? '24h');
  if (!m) throw new Error(`--since takes a number and m, h, d or w (e.g. --since 24h, --since 7d), not "${s}"`);
  return `${m[1]} ${UNITS[m[2]!]}`;
}

const n = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : String(v));
const usd = (v: unknown) => (v == null ? '' : `$${Number(v).toFixed(2)}`);
const tokens = (r: any) => `in ${n(r.input_tokens)} · out ${n(r.output_tokens)} · cache read ${n(r.cache_read_tokens)} · cache write ${n(r.cache_write_tokens)}`;

export async function usageCmd(sql: any, project: string | null, since: string | undefined): Promise<{ out: string; json: unknown }> {
  const s = await call('usage_summary', { project, since: sinceInterval(since) }, sql);
  const t = s.totals;
  const where = s.project ? `in ${s.project}` : 'on every project';
  const head = `${t.sessions} session${t.sessions === 1 ? '' : 's'} ${where} active in the last ${since ?? '24h'} (each row is that session's total so far, not only the window)`;
  if (!t.sessions) return { out: `${head}. Nothing recorded: the usage hook may be off on these machines (docs/ops/maintain.md, "Usage ledger").`, json: s };
  const cost = t.costed ? ` · ${usd(t.cost_usd)} (${t.costed} of ${t.sessions} reported a cost)` : ' · no cost reported';
  const rows = s.sessions.map((r: any) =>
    `  ${r.actor ?? `${r.pane || '?'}@${r.machine}`} ${String(r.session_id).slice(0, 8)}${r.model ? ` ${r.model}` : ''}: ${tokens(r)}${r.cost_usd != null ? ` · ${usd(r.cost_usd)}` : ''}`);
  return { out: [head, `  ${tokens(t)}${cost}`, ...rows].join('\n'), json: s };
}
