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
// judges, and a command that is exactly node plus a shim that, with the core.mjs it loads, is byte for byte this board's
// kit/guard copy (#4551, review 70-M2); a hook file that repeats a key in one object is refused (70-M3). Codex also needs
// [features] hooks = true in its config.toml, no project config turning hooks off and no selected profile turning them
// off (70-M4); agy needs the seat folder trusted,
// since agy loads workspace hooks only after trust. Codex's hook trust is not checked: its launch passes
// --dangerously-bypass-hook-trust, so the installed hook always runs. Names only ever appear in a reason, never a value.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hookPath, words } from '../../kit/guard/install.mjs';
import { HANDLED_TOOLS } from '../../kit/guard/shim-codex.mjs';
import { ASK_TOOLS, EDIT_TOOLS, READ_TOOLS, SHELL_TOOLS } from '../../kit/guard/shim-agy.mjs';
import { isClaudeOnly } from './env.ts';
import { readOpencodeEndpoint, writeOpencodeEndpoint } from './opencode.ts';

const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
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

// this board's own guard files: an installed shim must be these bytes (review 70-M2)
const KIT_GUARD = fileURLToPath(new URL('../../kit/guard/', import.meta.url));
const sha256 = (f: string) => { try { return createHash('sha256').update(readFileSync(f)).digest('hex'); } catch { return null; } };

/** The shim, and the core.mjs it loads, are byte for byte this board's kit/guard copies (review 70-M2: a lookalike folder
 *  or a link to a fake passed on names alone). core.mjs is read beside the shim's REAL path: node resolves the shim's
 *  ./core.mjs from there, so a link to a real shim beside a fake core is caught too. */
export function sameAsKitGuard(file: string, shim: string, kit = KIT_GUARD): boolean {
  let real: string;
  try { real = realpathSync(file); } catch { return false; }
  const a = sha256(real), b = sha256(join(dirname(real), 'core.mjs'));
  return a !== null && b !== null && a === sha256(join(kit, shim)) && b === sha256(join(kit, 'core.mjs'));
}

/** The hook command runs exactly `node <shim>`: two words, the first node (an absolute file unless bareNode: a bare node
 *  missing from PATH fails the hook, which Codex treats as allow, while agy treats it as deny), the second an absolute,
 *  existing file named `shim` that, with the core.mjs it loads, is this board's kit/guard copy. Anything else (an echo, a
 *  chain, a missing file, a stale or changed copy) is not the guard. */
export function runsShim(command: unknown, shim: string, o: { bareNode?: boolean; platform?: NodeJS.Platform; home?: string } = {}): boolean {
  if (typeof command !== 'string') return false;
  const win = (o.platform ?? process.platform) === 'win32', home = o.home ?? homedir();
  const w: string[] = words(command);
  if (w.length !== 2) return false;
  const [exe, file] = w.map((x) => hookPath(x, win, home) as string) as [string, string];
  if (!/^node(?:\.exe)?$/i.test(basename(exe))) return false;
  if (isAbs(exe) ? !isFile(exe) : !(o.bareNode && exe === basename(exe))) return false;
  return isAbs(file) && basename(file).toLowerCase() === shim && isFile(file) && sameAsKitGuard(file, shim);
}

/** A key repeated in one JSON object, or null (review 70-M3: JSON.parse keeps the last one, while Codex's parser may
 *  refuse the file or keep another, so the check and the agent could read different hooks). Keys compare decoded, so
 *  "hooks" and "hooks" are the same key. Expects text JSON.parse accepts. */
export function duplicateJsonKey(text: string): string | null {
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.key) {
        const k = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(k)) return k;
        top.keys.add(k);
        top.key = false;
      }
      i = j;
    } else if (c === '{') stack.push({ keys: new Set(), key: true });
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') { const top = stack[stack.length - 1]; if (top) top.key = true; }
  }
  return null;
}

/** What a Codex config.toml says about hooks: `hooks`, its top-level [features] hooks (true, false, or undefined when
 *  unset); `profile`, the profile its top level selects; `profiles`, each profile's [profiles.<name>.features] hooks.
 *  Reads tables, dotted keys and inline tables. Review 70-M4: the text of a multi-line string ("""...""" or '''...''') is
 *  never read as keys, and profile counts only before the first table (after one, it is that table's key). */
export function readCodexToml(toml: string): { hooks: boolean | undefined; profile: string | undefined; profiles: Map<string, boolean> } {
  const out = { hooks: undefined as boolean | undefined, profile: undefined as string | undefined, profiles: new Map<string, boolean>() };
  const inlineHooks = (v: string) => { const m = /\bhooks\s*=\s*(\w+)/.exec(v); return m ? m[1] === 'true' : undefined; };
  // a basic """ string ends at """ with no escaping backslash before it (a\""" is an escaped quote and "": round 2 minor 3)
  const closes = (s: string, d: string) => (d === '"""' ? /(?<!\\)(?:\\\\)*"""/ : /'''/).test(s);
  let section = '', inTable = false, open: string | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    if (open) { if (closes(raw, open)) open = null; continue; } // inside a multi-line string: text, not keys
    const line = raw.replace(/\s+#.*$|^#.*$/, '').trim();
    const head = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line); // [table] or [[array.of.tables]] (PR 77 review M2)
    if (head) { section = head[1]!.replace(/["'\s]/g, ''); inTable = true; continue; }
    const kv = /^([\w."' -]+?)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = [section, kv[1]!.replace(/["'\s]/g, '')].filter(Boolean).join('.'), val = kv[2]!.trim();
    // a multi-line string that runs on past this line: only a value that starts with one (a triple quote inside a
    // one-line string of the other kind, msg = "it'''s", opens nothing: PR 77 review M2)
    const ml = /^("""|''')/.exec(val);
    if (ml && !closes(val.slice(3), ml[1]!)) open = ml[1]!;
    let m: RegExpExecArray | null;
    if (key === 'features.hooks') out.hooks = val === 'true';
    else if (key === 'features') { const h = inlineHooks(val); if (h !== undefined) out.hooks = h; }
    else if (key === 'profile' && !inTable) out.profile = val.replace(/^(["'])(.*)\1$/, '$2');
    else if ((m = /^profiles\.(.+)\.features\.hooks$/.exec(key))) out.profiles.set(m[1]!, val === 'true');
    else if ((m = /^profiles\.(.+?)(?:\.features)?$/.exec(key))) { const h = inlineHooks(val); if (h !== undefined) out.profiles.set(m[1]!, h); }
  }
  return out;
}
/** [features] hooks in a Codex config.toml: true, false, or undefined when it does not set it. */
export const codexHooksFeature = (toml: string): boolean | undefined => readCodexToml(toml).hooks;

const hookEntries = (list: unknown) => (Array.isArray(list) ? list.filter(isObject) : []);
const runs = (e: Record<string, unknown>, shim: string, o: Parameters<typeof runsShim>[2]) =>
  e.enabled !== false && hookEntries(e.hooks).some((h) => (h.type === undefined || h.type === 'command') && h.enabled !== false && runsShim(h.command, shim, o));

/** A hook file's JSON, or a refusal when it repeats a key in one object (review 70-M3). Unreadable or not JSON: null doc. */
function hookFile(f: string, what: string): { doc: unknown; refusal: string | null } {
  const text = read(f);
  let doc: unknown = null;
  try { doc = text === null ? null : JSON.parse(text); } catch { return { doc: null, refusal: null }; }
  const dup = text === null ? null : duplicateJsonKey(text);
  return { doc, refusal: dup === null ? null : `${what} repeats the key "${dup.slice(0, 40)}" in one object, so the agent and this check could read different hooks: keep one` };
}

function codexRefusal(env: NodeJS.ProcessEnv, cwd: string, home: string, platform: NodeJS.Platform): string | null {
  const dir = env.CODEX_HOME || join(home, '.codex');
  const user = readCodexToml(read(join(dir, 'config.toml')) ?? ''), seat = readCodexToml(read(join(cwd, '.codex', 'config.toml')) ?? '');
  if (user.hooks !== true) return 'the Codex config.toml does not set [features] hooks = true, so no hook (the guard included) would run';
  if (seat.hooks === false) return 'the seat folder\'s .codex/config.toml turns Codex hooks off, so the guard would not run';
  // review 70-M4: a profile = "<name>" at the top of either file makes that profile's features win
  for (const name of [user.profile, seat.profile]) {
    if (name !== undefined && (user.profiles.get(name) === false || seat.profiles.get(name) === false)) {
      return 'the Codex profile that config.toml selects (profile = ...) sets [profiles.<name>.features] hooks = false, so the guard would not run';
    }
  }
  const want = platform === 'win32' ? HANDLED_TOOLS : HANDLED_TOOLS.filter((t: string) => t !== 'PowerShell');
  const { doc, refusal } = hookFile(join(dir, 'hooks.json'), 'the Codex hooks.json');
  if (refusal) return refusal;
  const pre = isObject(doc) && isObject(doc.hooks) ? hookEntries(doc.hooks.PreToolUse) : [];
  if (!pre.some((e) => coversAll(e.matcher, want) && runs(e, 'shim-codex.mjs', { platform, home }))) {
    return `no PreToolUse hook in the Codex hooks.json whose matcher covers ${want.join(', ')} and whose command is an absolute node running this board's kit/guard/shim-codex.mjs (the same bytes, with its core.mjs): install or reinstall the guard`;
  }
  return null;
}

// Every tool shim-agy judges, plus a name it has never seen: its hook is a catch-all, since it denies what it does not list.
const AGY_PROBE = [...SHELL_TOOLS, ...EDIT_TOOLS, ...READ_TOOLS, ...ASK_TOOLS, 'cb_unlisted_tool_probe'];
function agyHookRefusal(cwd: string, home: string, platform: NodeJS.Platform): string | null {
  const { doc, refusal } = hookFile(join(cwd, '.agents', 'hooks.json'), 'the seat folder\'s .agents/hooks.json');
  if (refusal) return refusal;
  const groups = isObject(doc) ? Object.values(doc).filter(isObject).filter((g) => g.enabled !== false) : [];
  const ok = groups.some((g) => hookEntries(g.PreToolUse).some((e) => coversAll(e.matcher, AGY_PROBE) && runs(e, 'shim-agy.mjs', { bareNode: true, platform, home })));
  return ok ? null : 'no enabled PreToolUse hook in the seat folder\'s .agents/hooks.json with a catch-all matcher whose command is node running this board\'s kit/guard/shim-agy.mjs (the same bytes, with its core.mjs): install or reinstall the guard';
}

/** The OpenCode plugin is the board's cb-guard.js: it registers tool.execute.before and runs this board's shim-opencode.mjs
 *  (a quoted absolute path in its source; the same bytes as kit/guard's, with its core.mjs, review 70-M2). Files in the plugins folder load without a config entry. */
function opencodePluginRefusal(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string | null {
  const src = read(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'plugins', 'cb-guard.js'));
  if (src === null) return 'no cb-guard plugin in the OpenCode plugins folder: install the guard first';
  const win = platform === 'win32';
  const shims = [...src.matchAll(/["'`]([^"'`\r\n]*shim-opencode\.mjs)["'`]/g)].map((m) => hookPath(m[1]!, win, home) as string);
  const ok = /tool\.execute\.before/.test(src) && shims.some((f) => isAbs(f) && isFile(f) && sameAsKitGuard(f, 'shim-opencode.mjs'));
  return ok ? null : 'the OpenCode cb-guard plugin does not register tool.execute.before with this board\'s kit/guard/shim-opencode.mjs (the same bytes, with its core.mjs): reinstall the guard';
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
