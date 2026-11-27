// OpenCode guard shim (#4002 phase 3). A plugin in ~/.config/opencode/plugins/ (tool.execute.before) runs this with
// {"tool":"<opencode tool id>","args":{...},"sessionID":"..."} on stdin, and CB_ROLE, CB_PROTECTED_BRANCHES and CB_ALLOW_ASK
// in the env. It prints {} (allow) or {"decision":"block","reason":"..."}, exit 0; the plugin throws Error(reason) on a block
// and must itself throw when this process fails or prints anything else. Same fail-closed rules as shim-claude.mjs: empty or
// unreadable input, an unknown tool or CB_ROLE, a missing or broken core.mjs, or any error blocks. The plugin must forward
// only bash, powershell, the edit family, the read family (read, grep, glob, list) and question: every other tool name is
// blocked here, never allowed by default. CB_AGENT without CB_ROLE blocks too (#4002): cb squad up always sets both.
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

const SHELL_TOOLS = new Set(['bash', 'powershell']);
const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit']);
// native reads (#4002 install gate): a path naming a secret file blocks for a role seat, as a shell read does
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'list']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const detail = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);
const unreadable = (why) => ({ ok: false, reason: `guard could not read hook input (${why})` });
const block = (reason) => ({ decision: 'block', reason });

// The input as { ok: true, tool, command? } or { ok: false, reason }.
export function parseOpencodeInput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return unreadable('empty stdin');
  let p;
  try {
    p = JSON.parse(raw);
  } catch (e) {
    return unreadable(`invalid JSON: ${detail(e)}`);
  }
  if (!isObject(p)) return unreadable(`the input is ${p === null ? 'null' : Array.isArray(p) ? 'an array' : `a ${typeof p}`}, not an object`);
  const name = typeof p.tool === 'string' ? p.tool.toLowerCase() : p.tool;
  if (SHELL_TOOLS.has(name)) {
    if (!isObject(p.args)) return unreadable(`args is ${p.args === undefined ? 'missing' : 'not an object'}`);
    if (typeof p.args.command !== 'string') return unreadable(`args.command is ${p.args.command === undefined ? 'missing' : 'not a string'}`);
    return { ok: true, tool: 'shell', command: p.args.command };
  }
  if (EDIT_TOOLS.has(name)) return { ok: true, tool: 'edit', args: p.args };
  if (READ_TOOLS.has(name)) return { ok: true, tool: 'read', args: p.args };
  if (name === 'question') return { ok: true, tool: 'ask' };
  return { ok: false, reason: `unrecognized tool ${String(JSON.stringify(p.tool)).slice(0, 80)}: this guard reads bash, powershell, edit, write, patch, apply_patch, multiedit, read, grep, glob, list and question` };
}

export function runOpencodeShim(raw, env = process.env) {
  try {
    if (!core) return block(`Blocked: guard failed to load core (${detail(loadErr)})`);
    const p = parseOpencodeInput(raw);
    if (!p.ok) return block(`Blocked: ${p.reason}`);
    const role = String(env.CB_ROLE ?? '').trim();
    const protectedBranches = String(env.CB_PROTECTED_BRANCHES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // CB_AGENT without CB_ROLE blocks (a broken seat launch, #4002); an edit carries its targets for the fence and secret rule
    const agent = String(env.CB_AGENT ?? '').trim() || null;
    const paths = p.tool === 'edit' || p.tool === 'read' ? core.editTargets(p.args ?? null) : undefined;
    const v = core.evaluate({ tool: p.tool, command: p.command, role: role || null, protectedBranches, allowAsk: env.CB_ALLOW_ASK === '1', agent, paths });
    if (v?.allow === true) return {};
    const prefix = v?.kind === 'dangerous' ? 'Blocked dangerous command: ' : v?.kind === 'role' ? `Blocked by role (${role}): ` : 'Blocked: ';
    return block(prefix + (typeof v?.reason === 'string' && v.reason ? v.reason : 'the guard gave no decision'));
  } catch (e) {
    return block(`Blocked: guard error (${detail(e)})`);
  }
}

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
    out = runOpencodeShim(readFileSync(0, 'utf8'), process.env);
  } catch (e) {
    out = block(`Blocked: guard could not read hook input (${detail(e)})`);
  }
  process.stdout.write(JSON.stringify(out));
}
