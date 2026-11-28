// Codex PreToolUse hook (#4002 phase 2), wired in ~/.codex/hooks.json by node kit/guard/install.mjs --agents codex with a
// catch-all matcher (#4609): every tool reaches this file. In a board seat (CB_ROLE or CB_AGENT set) a tool it does not
// judge is denied; outside one it passes, and Codex gets exactly what Claude gets there (PR 96 review I3, r2). Reads the hook input on
// stdin and CB_ROLE, CB_AGENT, CB_PROTECTED_BRANCHES and CB_ALLOW_ASK from its pane's env,
// asks core.mjs, and prints {} (allow: Codex rejects an explicit permissionDecision:allow) or Codex's deny object, exit 0:
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
// Fails closed exactly like shim-claude.mjs: empty or unreadable input, a hook event other than PreToolUse, an unknown tool
// (including a missing tool_name: Codex always sends one), a missing or broken core.mjs, or any error blocks. No static local
// imports: core.mjs loads dynamically, so a shim copied without it still blocks. Deploy with the installer (see the design note).
// What Codex 0.160 really sends (#4618, read from its source at rust-v0.160.0; pinned in test/guard-codex.test.ts):
// exec_command, its one shell tool on every platform, arrives as tool_name Bash with { command: <raw string> } (there is
// no unified_exec or PowerShell tool); apply_patch as { command: <patch text> }; write_stdin fires no hook at all, since
// it feeds a session whose command already passed here as Bash; every other function tool arrives under its own name.
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
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
// #4626: update_plan changes nothing outside the session (like Claude's plan tool); view_image reads a file into the
// context, so it gets the secret-file rule of a read. spawn_agent stays unrecognized (blocked) until a live check shows a
// sub-agent's own tools reach this hook (#4612).
const PLAN_TOOLS = new Set(['update_plan']);
const READ_TOOLS = new Set(['view_image']);
/** Every tool name this shim judges; in a board seat any other tool is denied (the installer's matcher is a catch-all, #4609). */
export const HANDLED_TOOLS = [...SHELL_TOOLS, ...EDIT_TOOLS, ...ASK_TOOLS, ...PLAN_TOOLS, ...READ_TOOLS];
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
    return { ok: true, tool: 'shell', command: input.command, ...(typeof p.cwd === 'string' && p.cwd ? { cwd: p.cwd } : {}) };
  }
  if (EDIT_TOOLS.has(name)) return { ok: true, tool: 'edit', input, cwd: typeof p.cwd === 'string' ? p.cwd : null };
  if (ASK_TOOLS.has(name)) return { ok: true, tool: 'ask' };
  if (PLAN_TOOLS.has(name)) return { ok: true, tool: 'plan' };
  if (READ_TOOLS.has(name)) {
    if (typeof input.path !== 'string' || !input.path.trim()) return unreadable(`tool_input.path is ${input.path === undefined ? 'missing' : 'not a path'}`);
    return { ok: true, tool: 'read', path: input.path, cwd: typeof p.cwd === 'string' ? p.cwd : null };
  }
  return { ok: false, unknown: typeof name === 'string' && name !== '', reason: `unrecognized tool ${String(JSON.stringify(name)).slice(0, 80)}: this guard reads Bash, apply_patch, request_user_input, update_plan and view_image` };
}

// An edit's targets as given, resolved against the hook's cwd (a relative hooks.json run from ~/.codex is the fence too),
// and through the real path of their nearest existing folder (review 68-I2: ./, ../ and links are judged where they land).
const FS = { resolve, dirname, basename, join, realpathSync };
// #4669: an older core.mjs beside this shim (a hand copy, or mid-update) has no scriptReader: judge without the script read
const readerFor = (cwd) => (typeof core?.scriptReader === 'function' ? core.scriptReader(cwd, { readFileSync, statSync, resolve, openSync, readSync, closeSync }) : null);
export function editPaths(input, cwd) {
  return [...new Set(core.editTargets(input).flatMap((t) => core.editPathForms(t, cwd, FS)))];
}

// One hook run: raw stdin and an env (CB_ROLE, CB_AGENT, CB_PROTECTED_BRANCHES, CB_ALLOW_ASK) in, the hook's JSON object out.
// CB_AGENT without CB_ROLE blocks (a broken seat launch, #4002); neither set: a hand-started Codex, base rules only.
export function runCodexShim(raw, env = process.env) {
  try {
    if (!core) return deny(`Blocked: guard failed to load core (${detail(loadErr)})`);
    const p = parseCodexInput(raw);
    const role = String(env.CB_ROLE ?? '').trim();
    const agent = String(env.CB_AGENT ?? '').trim() || null;
    // PR 96 review I3 and its r2 ruling: the hook is machine-wide (~/.codex/hooks.json), so outside a board seat (neither
    // CB_ROLE nor CB_AGENT) Codex gets exactly what Claude gets there: a tool this shim does not judge passes (Claude's
    // other tools never reach the guard), shell commands get the dangerous-command rules only, and a question follows
    // CB_ALLOW_ASK as AskUserQuestion does
    const seat = !!(role || agent);
    if (!p.ok) return !seat && p.unknown ? {} : deny(`Blocked: ${p.reason}`);
    const protectedBranches = String(env.CB_PROTECTED_BRANCHES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const paths = p.tool === 'edit' ? editPaths(p.input, p.cwd) : p.tool === 'read' ? [...new Set(core.editPathForms(p.path, p.cwd, FS))] : undefined;
    // #4669: a shell script the command runs is read from the hook's cwd and judged too; ssh to this machine's own name counts
    // stdin: Codex's exec_command keeps a process's input open for write_stdin, which no hook sees (#4626)
    const v = core.evaluate({ tool: p.tool, command: p.command, role: role || null, protectedBranches, allowAsk: env.CB_ALLOW_ASK === '1', agent, paths,
      readScript: readerFor(p.cwd ?? process.cwd()), hosts: core.localHosts(hostname(), networkInterfaces()), deployHost: env.VPS, stdin: p.tool === 'shell' });
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
