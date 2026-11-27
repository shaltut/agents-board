// cb doctor (#4607, from #4576): does each agent CLI installed here still list the flags its adapter launches with?
// Codex 0.160 dropped --full-auto: a seat started with it printed "unexpected argument", exited, and herdr only timed out.
// Read-only: it builds a sample launch per adapter (nothing starts) and runs `<cli> --version` and `<cli> --help`, never a
// session. A CLI not on PATH is skipped. A flag the help text hides reads as missing: the line says so, so it can be checked.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ADAPTERS, AGENT_KINDS, type AgentKind } from './agents/index.ts';

/** What a probe found: path null = not installed here; error = installed, but its help could not be read. */
export type AgentProbe = (kind: AgentKind) => { path: string | null; version?: string; help?: string; error?: string };

// A sample launch per adapter: values only an adapter's own checks need (a model it accepts, OpenCode's port); the
// flags, not the values, are what is checked. Builder and a read-only role: a read-only seat gets other flags (codex -s).
const SAMPLE: Record<AgentKind, { model: string; env?: Record<string, string> }> = {
  claude: { model: 'sonnet' }, codex: { model: 'gpt-5' }, opencode: { model: 'openai/gpt-5', env: { CB_OPENCODE_PORT: '4999' } },
  agy: { model: 'gemini-3-pro' },
};
const ROLES = ['builder', 'reviewer'];
const FLAG = /^-{1,2}[A-Za-z]/;

/** The flags (never their values) an adapter's launches pass, in order, once each; error when it would not build one. */
export function launchFlags(kind: AgentKind, board: string, cwd: string): { flags: string[]; error?: string } {
  const flags = new Set<string>();
  try {
    for (const role of ROLES) {
      const { args } = ADAPTERS[kind].buildLaunch({ name: `doctor-${role}`, role, repo: 'main', agent: kind, model: SAMPLE[kind].model,
        board, cwd, env: { ...(SAMPLE[kind].env ?? {}) } });
      for (const a of args) if (FLAG.test(a)) flags.add(a.replace(/=.*$/s, ''));
    }
  } catch (e: any) { return { flags: [...flags], error: String(e?.message ?? e) }; }
  return { flags: [...flags] };
}

/** Is the flag in the help text as a whole word (-m, --model <M>, --settings=<f>, [--auto], -s|--sandbox)? --mode is not
 *  --model, and -a is not the start of --auto. */
export function helpLists(help: string, flag: string): boolean {
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,\\[(|])${esc}(?=[\\s,=\\]<)|.:;]|$)`, 'm').test(help);
}

/** The CLI's file on PATH (PATHEXT on Windows), or null. */
export function findOnPath(exe: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, exe + ext);
      try { if (existsSync(p) && statSync(p).isFile()) return p; } catch { /* unreadable: next */ }
    }
  }
  return null;
}

/** The real probe: --version and --help of the CLI on PATH, 15 s each, no window. An npm .cmd shim needs a shell on
 *  Windows; the arguments are fixed words, never input. */
export const realProbe: AgentProbe = (kind) => {
  const path = findOnPath(kind);
  if (!path) return { path: null };
  const shell = /\.(?:cmd|bat)$/i.test(path);
  const run = (arg: string) => spawnSync(shell ? `"${path}"` : path, [arg], { encoding: 'utf8', timeout: 15_000, windowsHide: true, shell });
  const v = run('--version'), h = run('--help');
  const help = `${h.stdout ?? ''}\n${h.stderr ?? ''}`.trim();
  if (h.error || !help) return { path, error: h.error ? String((h.error as any).code === 'ETIMEDOUT' ? 'timed out after 15 s' : h.error.message) : `--help printed nothing (exit ${h.status})` };
  const version = `${v.stdout ?? ''}\n${v.stderr ?? ''}`.split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 60) ?? '';
  return { path, version, help };
};

/** One line per agent; a CLI that no longer lists a launch flag is a failed check. */
export function agentFlagsReport(o: { root: string; probe: AgentProbe }) {
  const lines: string[] = [];
  const json: Record<string, any> = {};
  let problems = 0;
  for (const kind of AGENT_KINDS) {
    const p = o.probe(kind);
    if (!p.path) { json[kind] = { installed: false }; lines.push(`agents: ${kind} not installed here, skipped`); continue; }
    const lf = launchFlags(kind, o.root, o.root);
    if (lf.error) { json[kind] = { installed: true, path: p.path, error: lf.error }; lines.push(`agents: ${kind}: launch flags not built: ${lf.error}`); continue; }
    if (p.error || !p.help) { json[kind] = { installed: true, path: p.path, error: p.error }; lines.push(`agents: ${kind}: launch flags not checked: ${p.error ?? 'no help text'}`); continue; }
    const missing = lf.flags.filter((f) => !helpLists(p.help!, f));
    const name = p.version ? `${kind} ${p.version}` : kind;
    json[kind] = { installed: true, path: p.path, version: p.version ?? null, flags: lf.flags, missing };
    if (!missing.length) { lines.push(`agents: ${name} lists all ${lf.flags.length} launch flags`); continue; }
    problems++;
    lines.push(`agents: ${name}: --help does not list ${missing.join(', ')}: a seat started with ${missing.length === 1 ? 'it' : 'them'} may exit at start (#4576). `
      + `Check \`${kind} --help\` (a hidden flag reads as missing); if it is gone, update cli/agents/${kind}.ts or pin ${kind} to a version that has it`);
  }
  return { ok: problems === 0, problems, lines, json };
}
