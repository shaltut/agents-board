// Antigravity (agy) PreToolUse hook (#4002 phase 5). Reads the hook input on stdin (camelCase protojson: toolCall {name,
// args}; a shell command's text is args.CommandLine of tool run_command) and CB_ROLE, CB_PROTECTED_BRANCHES and
// CB_ALLOW_ASK from its pane's env, asks core.mjs, and prints {"decision":"allow"} or {"decision":"deny","reason":"..."},
// exit 0. agy treats anything else as a deny, and {} is not an allow, so allow is printed explicitly.
// Note that agy's "allow" means auto-approve this call (docs/hooks.md in agy's builtin skill), not "no opinion".
// It fails closed exactly like shim-claude.mjs: empty or unreadable input, a missing toolCall, an unknown tool, a shell
// call without a string CommandLine, an unknown CB_ROLE, a missing or broken core.mjs, or any error blocks. No static
// local imports: core.mjs loads dynamically, so a shim copied without it still blocks. The hooks.json matcher should
// list only the tools below (guardInstallSpec in cli/agents/agy.ts); a tool outside it that reaches here is blocked.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let core = null;
let loadErr = null;
try {
  core = await import('./core.mjs');
} catch (e) {
  loadErr = e;
}

const SHELL_TOOLS = new Set(['run_command']);
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const ASK_TOOLS = new Set(['ask_question']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const detail = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);
const unreadable = (why) => ({ ok: false, reason: `guard could not read hook input (${why})` });
const deny = (reason) => ({ decision: 'deny', reason });

// The hook input as { ok: true, tool, command? } or { ok: false, reason }.
export function parseAgyInput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return unreadable('empty stdin');
  let p;
  try {
    p = JSON.parse(raw);
  } catch (e) {
    return unreadable(`invalid JSON: ${detail(e)}`);
  }
  if (!isObject(p)) return unreadable(`the input is ${p === null ? 'null' : Array.isArray(p) ? 'an array' : `a ${typeof p}`}, not an object`);
  const call = p.toolCall;
  if (!isObject(call)) return unreadable(`toolCall is ${call === undefined ? 'missing' : 'not an object'}`);
  const name = call.name;
  if (typeof name !== 'string' || !name) return unreadable('toolCall.name is missing or not a string');
  if (SHELL_TOOLS.has(name)) {
    const cmd = isObject(call.args) ? call.args.CommandLine : undefined;
    if (typeof cmd !== 'string') return unreadable(`toolCall.args.CommandLine is ${cmd === undefined ? 'missing' : 'not a string'}`);
    return { ok: true, tool: 'shell', command: cmd };
  }
  if (EDIT_TOOLS.has(name)) return { ok: true, tool: 'edit' };
  if (ASK_TOOLS.has(name)) return { ok: true, tool: 'ask' };
  return { ok: false, reason: `unrecognized tool ${String(JSON.stringify(name)).slice(0, 80)}: this guard reads run_command, ${[...EDIT_TOOLS].join(', ')} and ask_question` };
}

// One hook run: raw stdin and an env (CB_ROLE, CB_PROTECTED_BRANCHES, CB_ALLOW_ASK) in, the hook's JSON object out.
export function runAgyShim(raw, env = process.env) {
  try {
    if (!core) return deny(`Blocked: guard failed to load core (${detail(loadErr)})`);
    const p = parseAgyInput(raw);
    if (!p.ok) return deny(`Blocked: ${p.reason}`);
    const role = String(env.CB_ROLE ?? '').trim();
    const protectedBranches = String(env.CB_PROTECTED_BRANCHES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const v = core.evaluate({ tool: p.tool, command: p.command, role: role || null, protectedBranches, allowAsk: env.CB_ALLOW_ASK === '1' });
    if (v?.allow === true) return { decision: 'allow' };
    const prefix = v?.kind === 'dangerous' ? 'Blocked dangerous command: ' : v?.kind === 'role' ? `Blocked by role (${role}): ` : 'Blocked: ';
    return deny(prefix + (typeof v?.reason === 'string' && v.reason ? v.reason : 'the guard gave no decision'));
  } catch (e) {
    return deny(`Blocked: guard error (${detail(e)})`);
  }
}

// realpath: a symlinked or junction install must still run as the hook (import.meta.url is the real path).
function isMain() {
  const a = process.argv[1];
  if (!a) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(a)).href;
  } catch {
    return import.meta.url === pathToFileURL(resolve(a)).href;
  }
}

if (isMain()) {
  let out;
  try {
    out = runAgyShim(readFileSync(0, 'utf8'), process.env);
  } catch (e) {
    out = deny(`Blocked: guard could not read hook input (${detail(e)})`);
  }
  process.stdout.write(JSON.stringify(out));
}
