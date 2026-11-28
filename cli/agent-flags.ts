// cb doctor (#4607, from #4576): does each agent CLI installed here still take the flags its adapter launches with?
// Codex 0.160 dropped --full-auto: a seat started with it printed "unexpected argument", exited, and herdr only timed out.
// Read-only: it builds a sample launch per adapter (nothing starts) and runs `<cli> --version` and `<cli> --help`, never a
// session. A CLI not on PATH is skipped. A flag the help text hides reads as missing: the line says so, so it can be checked.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { ADAPTERS, AGENT_KINDS, type AgentKind } from './agents/index.ts';

/** What a probe found: path null = not installed here; error = installed, but its help could not be read. */
export type AgentProbe = (kind: AgentKind) => { path: string | null; version?: string; help?: string; error?: string };

// A sample launch per adapter: values only an adapter's own checks need (a model it accepts, OpenCode's port), and an
// effort so that a CLI that drops its effort flag shows here; the
// flags, not the values, are what is checked. Builder and a read-only role: a read-only seat gets other flags (codex -s).
const SAMPLE: Record<AgentKind, { model: string; effort?: string; env?: Record<string, string> }> = {
  claude: { model: 'sonnet', effort: 'high' }, codex: { model: 'gpt-5' }, opencode: { model: 'openai/gpt-5', env: { CB_OPENCODE_PORT: '4999' } },
  agy: { model: 'gemini-3-pro', effort: 'high' },
};
const ROLES = ['builder', 'reviewer'];
const FLAG = /^-{1,2}[A-Za-z]/;
const BOARD = resolve(import.meta.dirname, '..');

/** The flags (never their values) an adapter's launches pass, in order, once each; `pairs`, each flag with the plain
 *  word after it (a value, checked only where the help lists the flag's possible values); `env`, the launch env (the
 *  probe takes its update-off names); error when it would not build one. */
export function launchFlags(kind: AgentKind, board: string, cwd: string): { flags: string[]; pairs: [string, string][]; env: Record<string, string>; error?: string } {
  const flags = new Set<string>(), pairs = new Map<string, [string, string]>();
  let env: Record<string, string> = {};
  try {
    for (const role of ROLES) {
      const spec = ADAPTERS[kind].buildLaunch({ name: `doctor-${role}`, role, repo: 'main', agent: kind, model: SAMPLE[kind].model, effort: SAMPLE[kind].effort,
        board, cwd, env: { ...(SAMPLE[kind].env ?? {}) } });
      env = { ...env, ...(spec.env ?? {}) };
      spec.args.forEach((a, i) => {
        if (!FLAG.test(a)) return;
        flags.add(a.replace(/=.*$/s, ''));
        const v = spec.args[i + 1];
        if (!a.includes('=') && v !== undefined && /^\w[\w.-]*$/.test(v)) pairs.set(`${a} ${v}`, [a, v]);
      });
    }
  } catch (e: any) { return { flags: [...flags], pairs: [...pairs.values()], env, error: String(e?.message ?? e) }; }
  return { flags: [...flags], pairs: [...pairs.values()], env };
}

// An option line starts with a flag (-x or --xx, no space after the dash: clap's "- never:" value bullets are not one);
// its flag column is what comes before the first run of two spaces, where the description starts.
const OPTION_LINE = /^\s*-{1,2}[A-Za-z]/;
const flagColumn = (line: string) => line.trim().split(/\s{2,}|\t/)[0]!;
const flagIn = (flag: string) => new RegExp(`(?:^|[\\s,\\[(|])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,=\\]<)|.:;]|$)`);

/** Is the flag in an option line's flag column, as a whole word (-m, --model <M>, --settings=<f>, -s|--sandbox)? A flag
 *  named only in a description or a usage line is not listed (PR 95 review F4), --mode is not --model, and -a is not the
 *  start of --auto. */
export function helpLists(help: string, flag: string): boolean {
  const re = flagIn(flag);
  return help.split(/\r?\n/).some((l) => OPTION_LINE.test(l) && re.test(flagColumn(l)));
}

/** The values the help lists for a flag (clap: "[possible values: a, b]", or a "Possible values:" list of "- a: ..."
 *  bullets in its long help; commander: "(choices: "a", "b")"), or null when it lists none (PR 95 review F3). */
export function helpValues(help: string, flag: string): string[] | null {
  const re = flagIn(flag), block: string[] = [];
  let inBlock = false;
  for (const l of help.split(/\r?\n/)) {
    if (OPTION_LINE.test(l)) { if (inBlock) break; inBlock = re.test(flagColumn(l)); }
    if (inBlock) block.push(l);
  }
  const text = block.join('\n');
  const inline = /\[possible values: ([^\]]*)\]/i.exec(text);
  if (inline) return inline[1]!.split(',').map((s) => s.trim()).filter(Boolean);
  // commander (claude): (choices: "a", "b", default: ...), wrapped over the description's lines
  const choices = /\(choices:([^)]*)\)/i.exec(text.replace(/\s+/g, ' '));
  if (choices) { const v = [...choices[1]!.split(/,?\s*default:/i)[0]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!); if (v.length) return v; }
  const at = block.findIndex((l) => /^\s*possible values:\s*$/i.test(l));
  if (at < 0) return null;
  const vals = block.slice(at + 1).map((l) => /^\s*-\s+([\w.-]+)/.exec(l)?.[1]).filter((v): v is string => !!v);
  return vals.length ? vals : null;
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

// PR 95 review F1: run in a child node, which kills the CLI's whole tree on the timeout and then returns. spawnSync's own
// timeout kills only what it started (cmd.exe for an npm .cmd shim), and waits on as long as the real CLI, its child,
// holds the output pipe. Here the CLI gets its own pipes, so this runner's exit always ends the wait. F5: with a shell
// (a .cmd or .bat file) the command is one string, never an argument list. The arguments are fixed words, never input.
// PR 95 review N1: the runner's command line carries only { file, args, shell, ms }. The environment goes in through
// spawnSync's env option and the CLI inherits it, so no env value (a token) is readable from a process listing, and a big
// environment cannot push the command line past Windows' 32,767 chars. L1: one runner per CLI runs both calls at once,
// each with its own timeout and tree kill.
const RUNNER = `
const { spawn, spawnSync } = require('node:child_process');
const { file, args, shell, ms } = JSON.parse(process.argv[1]);
const win = process.platform === 'win32';
const run = (arg) => new Promise((resolve) => {
  const child = shell ? spawn('"' + file + '" ' + arg, { shell: true, windowsHide: true, detached: !win })
    : spawn(file, [arg], { windowsHide: true, detached: !win });
  let out = '', err = '', done = false, timedOut = false, timer;
  const add = (s, d) => (s.length > 262144 ? s : s + d);
  child.stdout.on('data', (d) => { out = add(out, d); });
  child.stderr.on('data', (d) => { err = add(err, d); });
  const finish = (status, error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve({ status, out, err, error: timedOut ? 'ETIMEDOUT' : error });
  };
  child.on('error', (e) => finish(null, e.code || e.message));
  child.on('close', (code) => finish(code, null));
  timer = setTimeout(() => {
    timedOut = true;
    try { if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    setTimeout(() => finish(null, 'ETIMEDOUT'), 1000);
  }, ms);
});
Promise.all(args.map(run)).then((r) => { process.stdout.write(JSON.stringify(r)); process.exit(0); });
`;
type Ran = { status: number | null; out: string; err: string; error: string | null };
/** spawnSync's shape as the probe uses it; a test passes its own to see what the runner is started with. */
export type SpawnSyncFn = (cmd: string, args: string[], opts: { encoding: 'utf8'; timeout: number; windowsHide: boolean; maxBuffer: number; env: NodeJS.ProcessEnv }) => { stdout: string; status: number | null; error?: Error };
function runCli(file: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv, spawn: SpawnSyncFn): Ran[] {
  const shell = /\.(?:cmd|bat)$/i.test(file);
  const r = spawn(process.execPath, ['-e', RUNNER, JSON.stringify({ file, args, shell, ms: timeoutMs })],
    { encoding: 'utf8', timeout: timeoutMs + 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env });
  try {
    const ran = JSON.parse(r.stdout) as Ran[];
    if (Array.isArray(ran) && ran.length === args.length) return ran;
  } catch { /* below */ }
  const error = r.error ? String(r.error.message) : `the probe runner failed (exit ${r.status})`;
  return args.map(() => ({ status: null, out: '', err: '', error }));
}

/** A probe: --version and --help of the CLI on PATH, at once, `timeoutMs` each (15 s), with the seats' update-off env
 *  (F6: the names in the adapter's own launch env, so a probe never starts an update the seats turn off). */
export function makeProbe(o: { timeoutMs?: number; env?: NodeJS.ProcessEnv; spawn?: SpawnSyncFn } = {}): AgentProbe {
  const timeoutMs = o.timeoutMs ?? 15_000, base = o.env ?? process.env, spawn = o.spawn ?? (spawnSync as unknown as SpawnSyncFn);
  return (kind) => {
    const path = findOnPath(kind, base);
    if (!path) return { path: null };
    const updateOff = Object.fromEntries(Object.entries(launchFlags(kind, BOARD, BOARD).env).filter(([k]) => /AUTO_?UPDATE/i.test(k)));
    const env = { ...base, ...updateOff };
    const [v, h] = runCli(path, ['--version', '--help'], timeoutMs, env, spawn) as [Ran, Ran];
    const help = `${h.out}\n${h.err}`.trim();
    if (h.error || !help) return { path, error: h.error === 'ETIMEDOUT' ? `timed out after ${timeoutMs / 1000} s` : h.error ?? `--help printed nothing (exit ${h.status})` };
    const version = `${v.out}\n${v.err}`.split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 60) ?? '';
    return { path, version, help };
  };
}
export const realProbe: AgentProbe = makeProbe();

/** One line per agent. A CLI that no longer lists a launch flag, or no longer offers a value the adapter passes, fails;
 *  so does a check that cannot run (its launch not built, its help unreadable: PR 95 review F2). */
export function agentFlagsReport(o: { root: string; probe: AgentProbe }) {
  const lines: string[] = [];
  const json: Record<string, any> = {};
  let problems = 0;
  for (const kind of AGENT_KINDS) {
    const p = o.probe(kind);
    if (!p.path) { json[kind] = { installed: false }; lines.push(`agents: ${kind} not installed here, skipped`); continue; }
    const lf = launchFlags(kind, o.root, o.root);
    if (lf.error) {
      problems++;
      json[kind] = { installed: true, path: p.path, error: lf.error };
      lines.push(`agents: ${kind}: launch flags not built (cb's own adapter refused its sample launch): ${lf.error}`);
      continue;
    }
    if (p.error || !p.help) {
      problems++;
      json[kind] = { installed: true, path: p.path, error: p.error };
      lines.push(`agents: ${kind}: launch flags not checked: ${p.error ?? 'no help text'}. Run \`${kind} --help\` by hand`);
      continue;
    }
    const missing = lf.flags.filter((f) => !helpLists(p.help!, f));
    const badValues = lf.pairs.filter(([f, v]) => { const vals = helpValues(p.help!, f); return vals !== null && !vals.includes(v); }).map(([f, v]) => `${f} ${v}`);
    const name = p.version ? `${kind} ${p.version}` : kind;
    json[kind] = { installed: true, path: p.path, version: p.version ?? null, flags: lf.flags, missing, badValues };
    if (!missing.length && !badValues.length) { lines.push(`agents: ${name} lists all ${lf.flags.length} launch flags`); continue; }
    problems++;
    const what = [missing.length ? `--help does not list ${missing.join(', ')}` : '', badValues.length ? `--help does not offer ${badValues.join(', ')}` : ''].filter(Boolean).join('; ');
    lines.push(`agents: ${name}: ${what}: a seat started with ${missing.length + badValues.length === 1 ? 'it' : 'them'} may exit at start (#4576). `
      + `Check \`${kind} --help\` (a hidden flag reads as missing); if it is gone, update cli/agents/${kind}.ts or pin ${kind} to a version that has it`);
  }
  return { ok: problems === 0, problems, lines, json };
}
