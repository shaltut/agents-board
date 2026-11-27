// The seat prestart helper (#4002 install gates). A non-Claude seat's pane dot-sources kit/seat/prestart.{sh,ps1} before
// herdr starts the agent there; the script drops the Claude-only env from the pane's own shell and then runs this file,
// as a child of that shell, so what it checks is the env the agent will inherit:
//   node seat-prestart.ts secret <machine> <pane> <port>   OpenCode: a new server password, written to the seat's 0600
//                                                            endpoint file and printed on stdout (the shell keeps it in
//                                                            OPENCODE_SERVER_PASSWORD: never on any argv or screen)
//   node seat-prestart.ts check <agent> <machine> <pane> <nonce>   prints cb-seat-ready:<nonce>, or
//                                    cb-seat-refused:<nonce>: <why>. squad up waits for that line (the nonce: never an older
//                                    line in the pane's scrollback) and closes the pane on anything else.
//                                    On ready it also starts the seat's relay (#4610; CB_SEAT_RELAY=off skips it).
// check refuses (fails closed) when the env still holds a Claude-only name, or the agent's guard would not run. The guard
// files are parsed, never substring-matched (review 70-I3): a PreToolUse entry whose matcher covers every tool the shim
// judges, and a command that is exactly node plus an existing shim with core.mjs beside it. Codex also needs
// [features] hooks = true in its config.toml and no project config turning hooks off; agy needs the seat folder trusted,
// since agy loads workspace hooks only after trust. Codex's hook trust is not checked: its launch passes
// --dangerously-bypass-hook-trust, so the installed hook always runs. Names only ever appear in a reason, never a value.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hookPath, words } from '../../kit/guard/install.mjs';
import { HANDLED_TOOLS } from '../../kit/guard/shim-codex.mjs';
import { ASK_TOOLS, EDIT_TOOLS, READ_TOOLS, SHELL_TOOLS } from '../../kit/guard/shim-agy.mjs';
import { isClaudeOnly } from './env.ts';
import { readOpencodeEndpoint, writeOpencodeEndpoint } from './opencode.ts';

const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const json = (f: string): unknown => { const t = read(f); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFile = (f: string) => { try { return statSync(f).isFile(); } catch { return false; } };
const isAbs = (p: string) => /^(?:\/|[a-z]:[\\/])/i.test(p);

/** The matcher, read as an anchored regex, matches every name (anchored is the strict reading: a matcher that passes here
 *  also passes unanchored). Not a string, empty or not a regex: covers nothing. */
export function coversAll(matcher: unknown, names: readonly string[]): boolean {
  if (typeof matcher !== 'string' || !matcher) return false;
  let re: RegExp;
  try { re = new RegExp(`^(?:${matcher})$`); } catch { return false; }
  return names.every((n) => re.test(n));
}

/** The hook command runs exactly `node <shim>`: two words, the first node (an absolute file unless bareNode: a bare node
 *  missing from PATH fails the hook, which Codex treats as allow, while agy treats it as deny), the second an absolute,
 *  existing file named `shim` with core.mjs beside it. Anything else (an echo, a chain, a missing file) is not the guard. */
export function runsShim(command: unknown, shim: string, o: { bareNode?: boolean; platform?: NodeJS.Platform; home?: string } = {}): boolean {
  if (typeof command !== 'string') return false;
  const win = (o.platform ?? process.platform) === 'win32', home = o.home ?? homedir();
  const w: string[] = words(command);
  if (w.length !== 2) return false;
  const [exe, file] = w.map((x) => hookPath(x, win, home) as string) as [string, string];
  if (!/^node(?:\.exe)?$/i.test(basename(exe))) return false;
  if (isAbs(exe) ? !isFile(exe) : !(o.bareNode && exe === basename(exe))) return false;
  return isAbs(file) && basename(file).toLowerCase() === shim && isFile(file) && isFile(join(dirname(file), 'core.mjs'));
}

/** What a Codex config.toml says about [features] hooks: true, false, or undefined when it does not set it. Reads a
 *  [features] table, a dotted features.hooks key and an inline features = { hooks = ... } table. */
export function codexHooksFeature(toml: string): boolean | undefined {
  let section = '', found: boolean | undefined;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$|^#.*$/, '').trim();
    const head = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (head) { section = head[1]!.replace(/["'\s]/g, ''); continue; }
    const kv = /^([\w."' -]+?)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = [section, kv[1]!.replace(/["'\s]/g, '')].filter(Boolean).join('.'), val = kv[2]!.trim();
    if (key === 'features.hooks') found = val === 'true';
    else if (key === 'features') { const m = /\bhooks\s*=\s*(\w+)/.exec(val); if (m) found = m[1] === 'true'; }
  }
  return found;
}

const hookEntries = (list: unknown) => (Array.isArray(list) ? list.filter(isObject) : []);
const runs = (e: Record<string, unknown>, shim: string, o: Parameters<typeof runsShim>[2]) =>
  e.enabled !== false && hookEntries(e.hooks).some((h) => (h.type === undefined || h.type === 'command') && h.enabled !== false && runsShim(h.command, shim, o));

function codexRefusal(env: NodeJS.ProcessEnv, cwd: string, home: string, platform: NodeJS.Platform): string | null {
  const dir = env.CODEX_HOME || join(home, '.codex');
  if (codexHooksFeature(read(join(dir, 'config.toml')) ?? '') !== true) return 'the Codex config.toml does not set [features] hooks = true, so no hook (the guard included) would run';
  if (codexHooksFeature(read(join(cwd, '.codex', 'config.toml')) ?? '') === false) return 'the seat folder\'s .codex/config.toml turns Codex hooks off, so the guard would not run';
  const want = platform === 'win32' ? HANDLED_TOOLS : HANDLED_TOOLS.filter((t: string) => t !== 'PowerShell');
  const doc = json(join(dir, 'hooks.json'));
  const pre = isObject(doc) && isObject(doc.hooks) ? hookEntries(doc.hooks.PreToolUse) : [];
  if (!pre.some((e) => coversAll(e.matcher, want) && runs(e, 'shim-codex.mjs', { platform, home }))) {
    return `no PreToolUse hook in the Codex hooks.json whose matcher covers ${want.join(', ')} and whose command is an absolute node running an existing kit/guard/shim-codex.mjs: install the guard first`;
  }
  return null;
}

// Every tool shim-agy judges, plus a name it has never seen: its hook is a catch-all, since it denies what it does not list.
const AGY_PROBE = [...SHELL_TOOLS, ...EDIT_TOOLS, ...READ_TOOLS, ...ASK_TOOLS, 'cb_unlisted_tool_probe'];
function agyHookRefusal(cwd: string, home: string, platform: NodeJS.Platform): string | null {
  const doc = json(join(cwd, '.agents', 'hooks.json'));
  const groups = isObject(doc) ? Object.values(doc).filter(isObject).filter((g) => g.enabled !== false) : [];
  const ok = groups.some((g) => hookEntries(g.PreToolUse).some((e) => coversAll(e.matcher, AGY_PROBE) && runs(e, 'shim-agy.mjs', { bareNode: true, platform, home })));
  return ok ? null : 'no enabled PreToolUse hook in the seat folder\'s .agents/hooks.json with a catch-all matcher whose command is node running an existing kit/guard/shim-agy.mjs: install the guard first';
}

/** The OpenCode plugin is the board's cb-guard.js: it registers tool.execute.before and runs an existing shim-opencode.mjs
 *  (a quoted absolute path in its source, core.mjs beside it). Files in the plugins folder load without a config entry. */
function opencodePluginRefusal(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string | null {
  const src = read(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'plugins', 'cb-guard.js'));
  if (src === null) return 'no cb-guard plugin in the OpenCode plugins folder: install the guard first';
  const win = platform === 'win32';
  const shims = [...src.matchAll(/["'`]([^"'`\r\n]*shim-opencode\.mjs)["'`]/g)].map((m) => hookPath(m[1]!, win, home) as string);
  const ok = /tool\.execute\.before/.test(src) && shims.some((f) => isAbs(f) && isFile(f) && isFile(join(dirname(f), 'core.mjs')));
  return ok ? null : 'the OpenCode cb-guard plugin does not register tool.execute.before with an existing kit/guard/shim-opencode.mjs: reinstall the guard';
}

/** The same folder (case-insensitive on Windows, where agy stores native paths). Exact, never a parent: whether agy's trust
 *  of a folder covers the folders under it is not verified, and assuming it would fail open. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => { const r = resolve(p).replace(/[\\/]+$/, ''); return platform === 'win32' ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}

/** Null when the seat may start, else why not. env, cwd and home are the shell's (tests pass their own). */
export function seatRefusal(agent: string, machine: string, pane: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = homedir(), platform: NodeJS.Platform = process.platform): string | null {
  const left = Object.keys(env).filter(isClaudeOnly);
  if (left.length) return `the pane still holds Claude-only env (${left.sort().join(', ')})`;
  if (agent === 'codex') return codexRefusal(env, cwd, home, platform);
  if (agent === 'agy') {
    const hook = agyHookRefusal(cwd, home, platform);
    if (hook) return hook;
    let trusted: unknown;
    try { trusted = JSON.parse(read(join(home, '.gemini', 'antigravity-cli', 'settings.json')) ?? 'null')?.trustedWorkspaces; } catch { trusted = null; }
    if (!Array.isArray(trusted) || !trusted.some((t) => typeof t === 'string' && t && samePath(cwd, t))) {
      return 'agy has not trusted this folder (its exact path in trustedWorkspaces), and agy loads workspace hooks only after trust: the guard would not run. A person trusts it in agy first';
    }
    return null;
  }
  if (agent === 'opencode') {
    if (!env.OPENCODE_SERVER_PASSWORD) return 'no OpenCode server password in the pane (the secret step failed)';
    if (readOpencodeEndpoint(machine, pane)?.password !== env.OPENCODE_SERVER_PASSWORD) return 'the OpenCode endpoint file does not hold the pane\'s password';
    return opencodePluginRefusal(env, home, platform);
  }
  return `no prestart rule for agent "${agent}"`;
}

/** #4610: start the seat's relay (cli/relay.ts beside this folder, by the path this helper was started with, so a release
 *  flip restarts it into the new code as the Claude hook's does). Launcher mode: it re-launches itself detached and exits;
 *  the child waits for the agent herdr starts next (relay-seat.ts) and leaves at once when another relay holds the seat.
 *  It inherits this shell's env: the Claude-only names are gone, CB_ROLE, CB_AGENT and CB_MCP_GATE_OK are there. */
function startRelay(agent: string, pane: string) {
  if (process.env.CB_SEAT_RELAY === 'off') return; // tests that run the real scripts: no relay against any board
  const here = process.argv[1] ? dirname(resolve(process.argv[1])) : import.meta.dirname;
  spawn(process.execPath, [join(here, '..', 'relay.ts'), '--pane', pane, '--agent', agent], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const WORD = /^[A-Za-z0-9._:-]{1,64}$/;
// deps: for tests, the refusal check and the relay start
export function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s),
  deps: { refusal?: typeof seatRefusal; startRelay?: (agent: string, pane: string) => void } = {}): number {
  const [cmd, a, b, c, d] = argv;
  if (cmd === 'secret') {
    const port = Number(c);
    if (!WORD.test(a ?? '') || !WORD.test(b ?? '') || !Number.isInteger(port)) return 2;
    const password = randomBytes(24).toString('base64url');
    try { writeOpencodeEndpoint(a!, b!, { port, password }); } catch { return 1; }
    out(password);
    return 0;
  }
  if (cmd === 'check') {
    if (![a, b, c, d].every((x) => WORD.test(x ?? ''))) { out(`cb-seat-refused:${WORD.test(d ?? '') ? d : 'none'}: bad arguments\n`); return 2; }
    const why = (deps.refusal ?? seatRefusal)(a!, b!, c!);
    // the relay brings the board's answers, messages and card changes to this seat (#4610); one that cannot start never
    // refuses the seat (the relay log says why; cb relay in the pane starts it by hand)
    if (!why) try { (deps.startRelay ?? startRelay)(a!, c!); } catch {}
    out(why ? `cb-seat-refused:${d}: ${why}\n` : `cb-seat-ready:${d}\n`);
    return why ? 1 : 0;
  }
  return 2;
}

// realpath: a linked or junction checkout must still run as the helper (import.meta.url is the real path)
const isMain = () => { const a = process.argv[1]; if (!a) return false; try { return import.meta.url === pathToFileURL(realpathSync(a)).href; } catch { return import.meta.url === pathToFileURL(resolve(a)).href; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
