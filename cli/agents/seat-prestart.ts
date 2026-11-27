// The seat prestart helper (#4002 install gates). A non-Claude seat's pane dot-sources kit/seat/prestart.{sh,ps1} before
// herdr starts the agent there; the script drops the Claude-only env from the pane's own shell and then runs this file,
// as a child of that shell, so what it checks is the env the agent will inherit:
//   node seat-prestart.ts secret <machine> <pane> <port>   OpenCode: a new server password, written to the seat's 0600
//                                                            endpoint file and printed on stdout (the shell keeps it in
//                                                            OPENCODE_SERVER_PASSWORD: never on any argv or screen)
//   node seat-prestart.ts check <agent> <machine> <pane> <nonce>   prints cb-seat-ready:<nonce>, or
//                                    cb-seat-refused:<nonce>: <why>. squad up waits for that line (the nonce: never an older
//                                    line in the pane's scrollback) and closes the pane on anything else.
// check refuses (fails closed) when the env still holds a Claude-only name, or the agent's guard would not run: no hook
// entry for the shim, or (agy) a workspace agy has not trusted, since agy loads workspace hooks only after trust. Codex's
// hook trust is not checked here: its launch passes --dangerously-bypass-hook-trust, so the installed hook always runs.
// Names only ever appear in a reason, never a value.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isClaudeOnly } from './env.ts';
import { readOpencodeEndpoint, writeOpencodeEndpoint } from './opencode.ts';

const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
/** The same folder (case-insensitive on Windows, where agy stores native paths). Exact, never a parent: whether agy's trust
 *  of a folder covers the folders under it is not verified, and assuming it would fail open. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => { const r = resolve(p).replace(/[\\/]+$/, ''); return platform === 'win32' ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}

/** Null when the seat may start, else why not. env, cwd and home are the shell's (tests pass their own). */
export function seatRefusal(agent: string, machine: string, pane: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = homedir()): string | null {
  const left = Object.keys(env).filter(isClaudeOnly);
  if (left.length) return `the pane still holds Claude-only env (${left.sort().join(', ')})`;
  if (agent === 'codex') {
    const hooks = read(join(env.CODEX_HOME || join(home, '.codex'), 'hooks.json'));
    if (!hooks || !hooks.includes('shim-codex.mjs') || !hooks.includes('PreToolUse')) return 'no PreToolUse hook for kit/guard/shim-codex.mjs in the Codex hooks.json: install the guard first';
    return null;
  }
  if (agent === 'agy') {
    const hooks = read(join(cwd, '.agents', 'hooks.json'));
    if (!hooks || !hooks.includes('shim-agy.mjs')) return 'no .agents/hooks.json entry for kit/guard/shim-agy.mjs in the seat folder: install the guard first';
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
    const plugin = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'plugins', 'cb-guard.js');
    if (!existsSync(plugin)) return 'no cb-guard plugin in the OpenCode plugins folder: install the guard first';
    return null;
  }
  return `no prestart rule for agent "${agent}"`;
}

const WORD = /^[A-Za-z0-9._:-]{1,64}$/;
export function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s)): number {
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
    const why = seatRefusal(a!, b!, c!);
    out(why ? `cb-seat-refused:${d}: ${why}\n` : `cb-seat-ready:${d}\n`);
    return why ? 1 : 0;
  }
  return 2;
}

// realpath: a linked or junction checkout must still run as the helper (import.meta.url is the real path)
const isMain = () => { const a = process.argv[1]; if (!a) return false; try { return import.meta.url === pathToFileURL(realpathSync(a)).href; } catch { return import.meta.url === pathToFileURL(resolve(a)).href; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
