// cb squad show's text: one line per role, then the repos (home first) and the areas. Pure, so it is tested without a
// board. #4002: a Claude role prints exactly as before; another agent shows in brackets after its model, and a fallback
// and the seat overrides only when the squad has them (one indented line per seat).
type Pick = { agent?: string; model: string; effort?: string };
type Spec = { agent?: string; model?: string; effort?: string; fallback?: Pick[] };
const ROLES = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'];

const runs = (p: Pick, shown: boolean) => `${p.model}${p.effort ? ` effort ${p.effort}` : ''}${shown ? ` (${p.agent ?? 'claude'})` : ''}`;
// a fallback is a switch to another agent or model: each one names its agent
const fallback = (f?: Pick[]) => (f?.length ? `; fallback ${f.map((x) => runs(x, true)).join(', ')}` : '');

export function squadShow(sq: any): string {
  // with repos, builder and reviewer counts are per repo ({"api": 2}) and areas are {name, repo}
  const count = (c: any) => (typeof c === 'object' ? Object.entries(c).map(([k, n]) => `${k} ${n}`).join(', ') : c);
  const lines = ROLES.filter((r) => sq.roles[r]).flatMap((r) => {
    const role = sq.roles[r], agent: string = role.agent ?? 'claude';
    const seats = Object.entries((role.seats ?? {}) as Record<string, Spec>).map(([k, s]) => {
      const a = s.agent ?? agent; // a seat names its agent when it is not claude or not its role's
      const effort = s.effort ?? (a === agent ? role.effort : undefined); // as seatSpec (cli/squad-up.ts)
      return `  seat ${k}: ${runs({ agent: a, model: s.model ?? role.model, effort }, a !== 'claude' || a !== agent)}${fallback(s.fallback)}`;
    });
    return [`${r}  ${r === 'owner' ? sq.areas.length : count(role.count)} × ${runs({ agent, model: role.model, effort: role.effort }, agent !== 'claude')} on ${role.machine}${fallback(role.fallback)}`, ...seats];
  });
  const repos = sq.repos ? [`repos: ${Object.entries(sq.repos).sort(([a, x]: any, [b, y]: any) => (y.home - x.home) || a.localeCompare(b))
    .map(([k, v]: any) => v.home ? `${k} (home)` : k).join(', ')}`] : [];
  const prot = sq.protected?.length ? [`protected: ${sq.protected.join(', ')}`] : []; // #3779: not only with --json
  return [...lines, ...repos, `areas: ${sq.areas.length ? sq.areas.map((a: any) => a.name ?? a).join(', ') : 'none'}`, ...prot].join('\n');
}
