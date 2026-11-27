// Claude Code PreToolUse hook (#4002): matcher Bash|PowerShell on Windows, Bash on the Mac. Reads the hook input on
// stdin and CB_ROLE, CB_PROTECTED_BRANCHES and CB_ALLOW_ASK from its pane's env (never the board: a hook has <100 ms),
// asks core.mjs, and prints {} (allow) or {"decision":"block","reason":"..."}, exit 0.
// It fails closed: empty or unreadable input, an unknown tool or CB_ROLE, a missing or broken core.mjs, or any error
// blocks; nothing here ever allows by default. No static local imports: core.mjs loads dynamically, so a shim copied
// without it still blocks. Deploy with node kit/guard/install.mjs.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let core = null;
let loadErr = null;
try {
  core = await import('./core.mjs');
} catch (e) {
  loadErr = e;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const detail = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);
const unreadable = (why) => ({ ok: false, reason: `guard could not read hook input (${why})` });
const block = (reason) => ({ decision: 'block', reason });

// The hook input as { ok: true, tool, command? } or { ok: false, reason }. A plain object with a plain-object tool_input;
// tool_name omitted with a string command is a shell command (the hook's contract before tool names, docs/ops/maintain.md).
export function parseClaudeInput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return unreadable('empty stdin');
  let p;
  try {
    p = JSON.parse(raw);
  } catch (e) {
    return unreadable(`invalid JSON: ${detail(e)}`);
  }
  if (!isObject(p)) return unreadable(`the input is ${p === null ? 'null' : Array.isArray(p) ? 'an array' : `a ${typeof p}`}, not an object`);
  const input = p.tool_input;
  if (!isObject(input)) return unreadable(`tool_input is ${input === undefined ? 'missing' : 'not an object'}`);
  const name = p.tool_name;
  if (name === undefined || SHELL_TOOLS.has(name)) {
    if (typeof input.command !== 'string') return unreadable(`tool_input.command is ${input.command === undefined ? 'missing' : 'not a string'}`);
    return { ok: true, tool: 'shell', command: input.command, ...(typeof p.cwd === 'string' && p.cwd ? { cwd: p.cwd } : {}) };
  }
  if (EDIT_TOOLS.has(name)) return { ok: true, tool: 'edit' };
  if (name === 'AskUserQuestion') return { ok: true, tool: 'ask' };
  return { ok: false, reason: `unrecognized tool ${String(JSON.stringify(name)).slice(0, 80)}: this guard reads Bash, PowerShell, Edit, Write, NotebookEdit and AskUserQuestion` };
}

// #4669: an older core.mjs beside this shim (a hand copy, or mid-update) has no scriptReader: judge without the script read
const readerFor = (cwd) => (typeof core?.scriptReader === 'function' ? core.scriptReader(cwd, { readFileSync, statSync, resolve }) : null);

// One hook run: raw stdin and an env (CB_ROLE, CB_PROTECTED_BRANCHES, CB_ALLOW_ASK) in, the hook's JSON object out.
export function runClaudeShim(raw, env = process.env) {
  try {
    if (!core) return block(`Blocked: guard failed to load core (${detail(loadErr)})`);
    const p = parseClaudeInput(raw);
    if (!p.ok) return block(`Blocked: ${p.reason}`);
    const role = String(env.CB_ROLE ?? '').trim();
    const protectedBranches = String(env.CB_PROTECTED_BRANCHES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // #4669: a shell script the command runs is read from the hook's cwd and judged too; ssh to this machine's own name counts
    const v = core.evaluate({ tool: p.tool, command: p.command, role: role || null, protectedBranches, allowAsk: env.CB_ALLOW_ASK === '1',
      readScript: readerFor(p.cwd ?? process.cwd()), hosts: core.localHosts(hostname(), networkInterfaces()), deployHost: env.VPS });
    if (v?.allow === true) return {};
    const prefix = v?.kind === 'dangerous' ? 'Blocked dangerous command: ' : v?.kind === 'role' ? `Blocked by role (${role}): ` : 'Blocked: ';
    return block(prefix + (typeof v?.reason === 'string' && v.reason ? v.reason : 'the guard gave no decision'));
  } catch (e) {
    return block(`Blocked: guard error (${detail(e)})`);
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
    out = runClaudeShim(readFileSync(0, 'utf8'), process.env);
  } catch (e) {
    out = block(`Blocked: guard could not read hook input (${detail(e)})`);
  }
  process.stdout.write(JSON.stringify(out));
}
