// Antigravity (agy) PreToolUse hook (#4002 phase 5). Reads the hook input on stdin (camelCase protojson: toolCall {name,
// args}, cwd, workspacePaths; a shell command's text is args.CommandLine of tool run_command) and CB_ROLE, CB_AGENT,
// CB_PROTECTED_BRANCHES and CB_ALLOW_ASK from its pane's env, asks core.mjs, and prints {"decision":"allow"} or
// {"decision":"deny","reason":"..."}, exit 0. agy treats anything else as a deny, and {} is not an allow, so allow is
// printed explicitly. agy's "allow" means auto-approve this call (docs/hooks.md in agy's builtin skill), not Claude's
// "no opinion": so every allow here is a decision, and a tool this shim cannot judge is a deny, never an allow.
// The hook is installed per seat with a catch-all matcher (guardInstallSpec in cli/agents/agy.ts), so EVERY tool reaches
// this file. It fails closed like shim-claude.mjs: empty or unreadable input, a missing toolCall, an unlisted tool, a
// shell call without a string CommandLine, an unknown CB_ROLE, a missing or broken core.mjs, or any error denies. No
// static local imports: core.mjs loads dynamically, so a shim copied without it still denies.
// A pane with neither CB_ROLE nor CB_AGENT is not a board seat: this hook is deployed per seat, so it denies and names
// the board guard rather than auto-approving a hand-started session. A pane with CB_AGENT but no CB_ROLE is denied too
// (#4392): cb squad up always sets both, and core applies no secret or fence rule to a null role.
// agy reads and edits files natively, so core.evaluate never sees those paths: secretPath (core, #4347) is checked here on
// every path arg, as given and as resolved (a link named notes.txt can lead to .env).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

let core = null;
let loadErr = null;
try {
  core = await import('./core.mjs');
} catch (e) {
  loadErr = e;
}

// Evidence per name: run_command (agy hooks.md); write_file, edit_file, read_file (agy builtin skills: native tool names);
// write_to_file, view_file (agy builtin skills and hooks.md examples). replace_file_content and multi_replace_file_content
// are strings in agy.exe, not confirmed as tools. The FIRST LIVE CHECK must capture the real tool names from a hook log and
// fill these sets; until then a seat is refused tools it needs, on purpose.
export const SHELL_TOOLS = Object.freeze(['run_command']);
export const EDIT_TOOLS = Object.freeze(['write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content']);
export const READ_TOOLS = Object.freeze(['read_file', 'view_file']);
export const ASK_TOOLS = Object.freeze(['ask_question']);
// Known and denied for every role: send_command_input writes stdin into a running command (an interpreter or ssh started
// by an allowed run_command would take git push or a kill from it, past core.check). It can be evaluated as shell once a
// hook log confirms its text field.
export const DENIED_TOOLS = Object.freeze(['send_command_input']);
// The edit target's argument name is unconfirmed too: only these are read; none present or a non-string denies.
export const PATH_ARGS = Object.freeze(['TargetFile', 'AbsolutePath', 'FilePath', 'path', 'file_path']);
const WRITE_DENY_SEGMENTS = ['.git', '.agents', '.gemini'];
const WRITE_DENY_PREFIXES = [['kit', 'guard']];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const detail = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);
const unreadable = (why) => ({ ok: false, reason: `guard could not read hook input (${why})` });
const deny = (reason) => ({ decision: 'deny', reason });

// The hook input as { ok: true, tool, command?, call, input } or { ok: false, reason }.
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
  if (SHELL_TOOLS.includes(name)) {
    const cmd = isObject(call.args) ? call.args.CommandLine : undefined;
    if (typeof cmd !== 'string') return unreadable(`toolCall.args.CommandLine is ${cmd === undefined ? 'missing' : 'not a string'}`);
    return { ok: true, tool: 'shell', command: cmd, call, input: p };
  }
  if (EDIT_TOOLS.includes(name)) return { ok: true, tool: 'edit', call, input: p };
  if (READ_TOOLS.includes(name)) return { ok: true, tool: 'read', call, input: p };
  if (ASK_TOOLS.includes(name)) return { ok: true, tool: 'ask', call, input: p };
  if (DENIED_TOOLS.includes(name)) return { ok: false, reason: `tool ${name} is denied for every role until a hook log confirms its text field` };
  return { ok: false, reason: `unrecognized tool ${String(JSON.stringify(name)).slice(0, 80)}: this guard judges ${[...SHELL_TOOLS, ...EDIT_TOOLS, ...READ_TOOLS, ...ASK_TOOLS].join(', ')} only` };
}

// realpath of the nearest existing ancestor plus the rest: a symlink inside the workspace cannot lead a write out of it.
function real(p) {
  let head = p;
  const tail = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return p;
    tail.unshift(head.slice(up.length).replace(/^[\\/]+/, ''));
    head = up;
  }
  try { return resolve(realpathSync(head), ...tail); } catch { return p; }
}
// A path segment as the guard compares it: folded to lower case on every platform; on Windows also without trailing dots
// and spaces (NTFS drops them: ".git." is ".git") and without anything from ":" on (an NTFS stream: ".git::$INDEX_ALLOCATION").
export function normSegment(seg, platform = process.platform) {
  let s = seg.toLowerCase();
  if (platform === 'win32') s = s.replace(/:.*$/, '').replace(/[. ]+$/, '');
  return s;
}

// null when the access may go ahead, else the reason. Resolved against the seat's cwd; only PATH_ARGS names are read.
// mode 'edit': denied inside .git, .agents, .gemini and kit/guard. mode 'read': .git stays readable, the rest follows the edit rule.
export function checkPath(call, input, mode = 'edit', platform = process.platform) {
  const verb = mode === 'read' ? 'reading' : 'editing';
  const denySegs = mode === 'read' ? WRITE_DENY_SEGMENTS.filter((s) => s !== '.git') : WRITE_DENY_SEGMENTS;
  const args = isObject(call.args) ? call.args : {};
  const given = PATH_ARGS.filter((k) => args[k] !== undefined);
  if (given.length === 0) return `the ${mode}'s target path is missing (read: ${PATH_ARGS.join(', ')})`;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : null;
  const ws = Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string' && input.workspacePaths[0] ? input.workspacePaths[0] : null;
  const root0 = ws ?? cwd;
  if (!root0) return `the hook input names no cwd or workspace to confine ${mode}s to`;
  const root = real(resolve(root0));
  const base = resolve(cwd ?? root0);
  for (const k of given) {
    const v = args[k];
    if (typeof v !== 'string' || !v.trim()) return `the ${mode}'s target path (${k}) is not a non-empty string`;
    const abs = real(isAbsolute(v) ? resolve(v) : resolve(base, v));
    const rel = relative(root, abs);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `${verb} outside the workspace (${k})`;
    const segs = rel.split(sep).filter(Boolean).map((s) => normSegment(s, platform));
    if (segs.some((s) => denySegs.includes(s))) return `${verb} inside ${denySegs.join(', ')} is not allowed (${k})`;
    for (const pre of WRITE_DENY_PREFIXES) if (pre.every((s, i) => segs[i] === s)) return `${verb} inside ${pre.join('/')} is not allowed (${k})`;
  }
  return null;
}
export const checkEditPath = (call, input, platform = process.platform) => checkPath(call, input, 'edit', platform);

// null, or the reason a read or edit names a secret file. Runs after checkPath, which has confirmed a string path and a cwd.
function secretTarget(call, input, mode) {
  if (typeof core.secretPath !== 'function') return 'the guard core has no secretPath check';
  const args = isObject(call.args) ? call.args : {};
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : null;
  const ws = Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string' ? input.workspacePaths[0] : null;
  const base = resolve(cwd ?? ws ?? '.');
  for (const k of PATH_ARGS) {
    const v = args[k];
    if (typeof v !== 'string') continue;
    if (core.secretPath(v) || core.secretPath(real(isAbsolute(v) ? resolve(v) : resolve(base, v)))) {
      return `${mode === 'read' ? 'reading' : 'editing'} a secret file (${k}): what a seat reads goes to the model provider (#4347), so no seat opens .env, a private key or a credentials file. Use the file where it lives and name where a value lives instead; .env.example shows the keys. A value you need: cb ask`;
    }
  }
  return null;
}

// #4652: an edit's targets in every spelling core judges (as given, resolved against the cwd, through real paths), so
// core's fence and secret rule run on agy's edits as on Codex's and OpenCode's. Before, evaluate got no paths and only
// this shim's own segments were denied: a repo's .claude/settings.json, opencode.json or .codex config stayed writable.
const FS = { resolve, dirname, basename, join, realpathSync };
export function editPaths(call, input) {
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd
    : Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string' ? input.workspacePaths[0] : '.';
  return [...new Set(core.editTargets(isObject(call.args) ? call.args : {}).flatMap((t) => core.editPathForms(t, cwd, FS)))];
}

// One hook run: raw stdin and an env (CB_ROLE, CB_AGENT, CB_PROTECTED_BRANCHES, CB_ALLOW_ASK) in, the hook's JSON object out.
export function runAgyShim(raw, env = process.env) {
  try {
    if (!core) return deny(`Blocked: guard failed to load core (${detail(loadErr)})`);
    const p = parseAgyInput(raw);
    if (!p.ok) return deny(`Blocked: ${p.reason}`);
    const role = String(env.CB_ROLE ?? '').trim();
    if (!role && !String(env.CB_AGENT ?? '').trim()) {
      return deny('Blocked: this pane is not a board seat (neither CB_ROLE nor CB_AGENT is set), and the board guard is deployed per seat: start the session with cb squad up, or run agy without this hook file');
    }
    if (!role) return deny('Blocked: CB_ROLE is not set in this board seat (CB_AGENT is), so no role rule could apply: start the session with cb squad up, which sets both');
    if (p.tool === 'read') { // a listed read tool: core has no rule for it, so path confinement and secretPath are the check
      const why = checkPath(p.call, p.input, 'read') ?? secretTarget(p.call, p.input, 'read');
      return why ? deny(`Blocked: ${why}`) : { decision: 'allow' };
    }
    const protectedBranches = String(env.CB_PROTECTED_BRANCHES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const v = core.evaluate({ tool: p.tool, command: p.command, role, protectedBranches, allowAsk: env.CB_ALLOW_ASK === '1',
      paths: p.tool === 'edit' ? editPaths(p.call, p.input) : undefined });
    if (v?.allow === true) {
      if (p.tool === 'edit') {
        const why = checkEditPath(p.call, p.input) ?? secretTarget(p.call, p.input, 'edit');
        if (why) return deny(`Blocked: ${why}`);
      }
      return { decision: 'allow' };
    }
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
