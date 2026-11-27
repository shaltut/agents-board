// cb squad trust (#4575): Ahmed runs it once per project on each machine, in his own terminal. It marks the squad's seat
// folders trusted in each agent's own config (the adapters' trustSpec().preseed), so cb squad up never stops at a
// folder-trust dialog, and no seat ever answers one. Squad seats may not run it: the guard blocks it and so does this file.
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS, type AgentKind } from './agents/index.ts';
import { reposOf, type Launch, type Squad } from './squad-up.ts';

/** Why squad up may not start this seat yet, or null. */
export type TrustCheck = (l: Launch, project: string) => string | null;

/** The machine's seat folders (every repo's folder there: a seat starts in its repo's folder; worktrees are made later from
 *  inside a running session) and every agent a role on it, a seat override or a fallback names, in squad order. */
export function trustTargets(squad: Squad, machine: string): { paths: string[]; agents: AgentKind[] } {
  const agents = new Set<AgentKind>();
  for (const role of Object.values(squad.roles)) {
    if (role.machine !== machine) continue;
    agents.add(role.agent ?? 'claude');
    for (const f of role.fallback ?? []) agents.add(f.agent);
    for (const s of Object.values(role.seats ?? {})) {
      if (s.agent) agents.add(s.agent);
      for (const f of s.fallback ?? []) agents.add(f.agent);
    }
  }
  const paths = [...new Set(Object.values(reposOf(squad)).map((r) => r.paths[machine] ?? '').filter(Boolean))];
  return { paths, agents: [...agents] };
}

/** squad up's check, read only: a seat on this machine (no herdr label) whose agent's config does not trust its folder.
 *  A missing or unreadable config claims nothing (that agent never ran here; its own start says what is wrong). */
export function homeTrust(home = homedir(), platform: NodeJS.Platform = process.platform): TrustCheck {
  return (l, project) => {
    const p = l.herdr ? undefined : ADAPTERS[l.agent]?.trustSpec([l.cwd], platform).preseed;
    if (!p || !l.cwd) return null;
    const file = join(home, p.file);
    let state: ReturnType<typeof p.state>;
    try { state = p.state(readFileSync(file, 'utf8'), l.cwd); } catch { return null; }
    if (state === 'trusted') return null;
    if (state === 'untrusted') return `${l.cwd} is marked untrusted for ${l.agent} (${file}): change it there by hand`;
    return `${l.cwd} is not trusted for ${l.agent} yet (${file}): run once in your own terminal: cb squad trust ${project}`;
  };
}

const sleep = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** Edit a config file another program also writes (a running Claude rewrites ~/.claude.json often): edit what is there,
 *  write it beside the file with the file's own mode (0600 for ~/.claude.json: it holds sign-in data), read the file
 *  again and start over if it changed meanwhile, then rename over it, so a reader never sees half a file and a save made
 *  during the edit is not lost. A symlinked dotfile is followed: the target is replaced, the link kept. Windows refuses
 *  the rename while another process holds the file open for a moment: retried, then the error. Returns the text written
 *  (the same text: nothing written). */
export function editFile(file: string, edit: (text: string) => string): string {
  const real = realpathSync(file), tmp = `${real}.cb-trust-${process.pid}.tmp`;
  for (let attempt = 1; ; attempt++) {
    const before = readFileSync(real, 'utf8'), after = edit(before);
    if (after === before) return before;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, after, { mode: statSync(real).mode & 0o777, flag: 'wx' });
    if (readFileSync(real, 'utf8') !== before) {
      rmSync(tmp, { force: true });
      if (attempt >= 5) throw new Error('the file kept changing while it was edited: run cb squad trust again');
      continue;
    }
    for (let i = 1; ; i++) {
      try { renameSync(tmp, real); return after; } catch (e) {
        if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) { rmSync(tmp, { force: true }); throw e; }
        sleep(100);
      }
    }
  }
}

export type TrustOpts = { machine?: string; dryRun?: boolean; home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv;
  callFn: (fn: string, a: any) => Promise<unknown> };

export async function squadTrust(project: string, o: TrustOpts): Promise<string> {
  const env = o.env ?? process.env;
  if (env.CB_ROLE || env.CB_AGENT)
    throw new Error('cb squad trust writes the agents\' own config files, which no squad seat touches (the fence): Ahmed runs it in his own terminal');
  const squad = await o.callFn('squad_get', { project }) as Squad | null;
  if (!squad) throw new Error(`${project} has no squad yet: write one with cb squad set ${project} -f <file>`);
  const keys = Object.keys(squad.machines), local = keys.filter((k) => squad.machines[k]!.herdr === null);
  const machine = o.machine ?? (local.length === 1 ? local[0]! : undefined);
  if (!machine) throw new Error(`name the machine this is: cb squad trust ${project} --machine <one of ${keys.join(', ')}>`);
  if (!squad.machines[machine]) throw new Error(`no machine ${machine} in ${project}'s squad: one of ${keys.join(', ')}`);
  const home = o.home ?? homedir(), platform = o.platform ?? process.platform;
  const { paths, agents } = trustTargets(squad, machine);
  const lines = [`${project} on ${machine}: ${paths.join(', ') || 'no seat folders'}`];
  for (const agent of agents) {
    const p = ADAPTERS[agent].trustSpec(paths, platform).preseed;
    if (!p || !paths.length) continue; // no folder-trust dialog (OpenCode)
    const file = join(home, p.file);
    if (!existsSync(file)) { lines.push(`skip ${agent}: ${file} not found: start ${agent} once on this machine, then run again`); continue; }
    try {
      let mine: string[] = []; // the last pass's lines: editFile runs the edit again if the file changed meanwhile
      const edit = (before: string) => {
        let text = before;
        mine = [];
        for (const path of paths) {
          const s = p.state(text, path);
          if (s === 'trusted') mine.push(`already ${agent}: ${path}`);
          else if (s === 'untrusted') mine.push(`left ${agent}: ${path} is marked untrusted in ${file}: change it there by hand`);
          else { text = p.add(text, path); mine.push(`${o.dryRun ? 'would add' : 'added'} ${agent}: ${path} (${file})`); }
        }
        return text;
      };
      if (o.dryRun) edit(readFileSync(file, 'utf8')); else editFile(file, edit);
      lines.push(...mine); // only once the file is written: a path that fails leaves it as it was
    } catch (e) { lines.push(`skip ${agent}: ${file}: ${(e as Error).message}`); }
  }
  for (const k of keys) if (k !== machine && trustTargets(squad, k).agents.length) lines.push(`on ${k}: cb squad trust ${project} --machine ${k}`);
  return lines.join('\n');
}
