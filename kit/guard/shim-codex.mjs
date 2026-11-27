// Codex PreToolUse hook (#4002 phase 2), wired in ~/.codex/hooks.json by node kit/guard/install.mjs --agents codex with a
// catch-all matcher (#4609): every tool reaches this file, and one it does not judge is denied. Reads the hook input on stdin and CB_ROLE, CB_PROTECTED_BRANCHES and CB_ALLOW_ASK from its pane's env,
// asks core.mjs, and prints {} (allow: Codex rejects an explicit permissionDecision:allow) or Codex's deny object, exit 0:
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
// Fails closed exactly like shim-claude.mjs: empty or unreadable input, a hook event other than PreToolUse, an unknown tool
// (including a missing tool_name: Codex always sends one), a missing or broken core.mjs, or any error blocks. No static local
// imports: core.mjs loads dynamically, so a shim copied without it still blocks. Deploy with the installer (see the design note).
// What Codex 0.160 really sends (#4618, read from its source at rust-v0.160.0; pinned in test/guard-codex.test.ts):
// exec_command, its one shell tool on every platform, arrives as tool_name Bash with { command: <raw string> } (there is
// no unified_exec or PowerShell tool); apply_patch as { command: <patch text> }; write_stdin fires no hook at all, since
// it feeds a session whose command already passed here as Bash; every other function tool arrives under its own name.
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let core = null;
let loadErr = null;
try {
  core = await import('./core.mjs');
} catch (e) {
  loadErr = e;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'Write']);
const ASK_TOOLS = new Set(['request_user_input']);
/** Every tool name this shim judges; any other tool is denied (the installer's matcher is a catch-all, #4609). */
export const HANDLED_TOOLS = [...SHELL_TOOLS, ...EDIT_TOOLS, ...ASK_TOOLS];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const detail = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);
const unreadable = (why) => ({ ok: false, reason: `guard could not read hook input (${why})` });
export const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

// The hook input as { ok: true, tool, command? } or { ok: false, reason }.
export function parseCodexInput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return unreadable('empty stdin');
  let p;
  try {
    p = JSON.parse(raw);
  } catch (e) {
    return unreadable(`invalid JSON: ${detail(e)}`);
  }
  if (!isObject(p)) return unreadable(`the input is ${p === null ? 'null' : Array.isArray(p) ? 'an array' : `a ${typeof p}`}, not an object`);
  if (p.hook_event_name !== undefined && p.hook_event_name !== 'PreToolUse') return unreadable(`hook_event_name is ${JSON.stringify(p.hook_event_name)?.slice(0, 40)}, not PreToolUse`);
  const input = p.tool_input;
  if (!isObject(input)) return unreadable(`tool_input is ${input === undefined ? 'missing' : 'not an object'}`);
  const name = p.tool_name;
  if (SHELL_TOOLS.has(name)) {
    if (typeof input.command !== 'string') return unreadable(`tool_input.command is ${input.command === undefined ? 'missing' : 'not a string'}`);
    return { ok: true, tool: 'shell', command: input.command };
  }
  if (EDIT_TOOLS.has(name)) return { ok: true, tool: 'edit', input, cwd: typeof p.cwd === 'string' ? p.cwd : null };
  if (ASK_TOOLS.has(name)) return { ok: true, tool: 'ask' };
  return { ok: false, reason: `unrecognized tool ${String(JSON.stringify(name)).slice(0, 80)}: this guard reads Bash, apply_patch and request_user_input` };
}

// An edit's targets as given, resolved against the hook's cwd (a relative hooks.json run from ~/.codex is the fence too),
// and through the real path of their nearest existing folder (review 68-I2: ./, ../ and links are judged where they land).
const FS = { resolve, dirname, basename, join, realpathSync };
export function editPaths(input, cwd) {
  return [...new Set(core.editTargets(input).flatMap((t) => core.editPathForms(t, cwd, FS)))];
}

// One hook run: raw stdin and an env (CB_ROLE, CB_AGENT, CB_PROTECTED_BRANCHES, CB_ALLOW_ASK) in, the hook's JSON object out.
// CB_AGENT without CB_ROLE blocks (a broken seat launch, #4002); neither set: a hand-started Codex, base rules only.
export function runCodexShim(raw, env = process.env) {
  try {
    if (!core) return deny(`Blocked: guard failed to load core (${detail(loadErr)})`);
    const p = parseCodexInput(raw);
    if (!p.ok) return deny(`Blocked: ${p.reason}`);
    const role = String(env.CB_ROLE ?? '').trim();
    const protectedBranches = String(env.CB_PROTECTED_BRANCHES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const agent = String(env.CB_AGENT ?? '').trim() || null;
    const paths = p.tool === 'edit' ? editPaths(p.input, p.cwd) : undefined;
    const v = core.evaluate({ tool: p.tool, command: p.command, role: role || null, protectedBranches, allowAsk: env.CB_ALLOW_ASK === '1', agent, paths });
    if (v?.allow === true) return {};
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
    out = runCodexShim(readFileSync(0, 'utf8'), process.env);
  } catch (e) {
    out = deny(`Blocked: guard could not read hook input (${detail(e)})`);
  }
  process.stdout.write(JSON.stringify(out));
}
