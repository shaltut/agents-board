// Installs the guard (#4002): node kit/guard/install.mjs [--target <dir>] [--agents codex,agy,opencode [--seat <dir>]...] [--check]
// Copies core.mjs and shim-claude.mjs to <target>.new, runs 6 hook probes against the staged shim with CB_ROLE, CB_AGENT,
// CB_PROTECTED_BRANCHES and CB_ALLOW_ASK cleared, and moves them into <target> only when all 6 pass. --check compares
// SHA-256 hashes with this checkout and writes nothing (exit 1 on drift); with the default target (or --settings) it also
// checks the hook wiring in ~/.claude/settings.json (checkWiring, #4348).
// The default target, ~/.claude-board/guard, is what every Claude session's PreToolUse hook runs: install there only
// with Ahmed's yes.
// --agents (#4609) also copies each named agent's shim beside core.mjs, probes it there before the swap, and wires it:
// Codex's hooks.json + [features] hooks = true (CODEX_HOME or ~/.codex), agy's .agents/hooks.json in each --seat folder
// (kept out of git), OpenCode's plugins/cb-guard.js (XDG_CONFIG_HOME or ~/.config). Every hook runs the installed copy,
// never the checkout, so a git pull cannot change a live guard unprobed. Other hook entries are never touched, and a
// second run changes nothing. Seats never write these files (the fence keeps them out); a person runs this.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// core first: on an update the shim loads core.mjs on every run, and an old shim with a new core still blocks on error
export const GUARD_FILES = ['core.mjs', 'shim-claude.mjs'];
/** Each agent's shim, installed beside core.mjs only when --agents names it (a Claude-only install and check are unchanged). */
export const AGENT_SHIMS = Object.freeze({ codex: 'shim-codex.mjs', agy: 'shim-agy.mjs', opencode: 'shim-opencode.mjs' });
/** The hook matchers the installer writes; the adapters' guardInstallSpec says the same (test/guard-install-agents.test.ts).
 *  Both catch-alls: a tool the matcher does not name is never guarded, while the shim denies a tool it does not know. */
export const AGENT_MATCHERS = Object.freeze({ codex: '.*', agy: '.*' });
const agentFiles = (agents = []) => agents.map((a) => {
  if (!Object.hasOwn(AGENT_SHIMS, a)) throw new Error(`unknown agent "${a}" (known: ${Object.keys(AGENT_SHIMS).join(', ')})`);
  return AGENT_SHIMS[a];
});
const CB_ENV = ['CB_ROLE', 'CB_AGENT', 'CB_PROTECTED_BRANCHES', 'CB_ALLOW_ASK'];
const DANGER = 'Blocked dangerous command: ';
const BUILDER = 'Blocked by role (builder): ';
const PROBES = [
  { name: 'ls with tool_name omitted passes', input: { tool_input: { command: 'ls' } }, allow: true },
  { name: 'git reset --hard blocks', input: { tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }, prefix: DANGER },
  { name: 'PowerShell Remove-Item -Recurse -Force C:\\ blocks', input: { tool_name: 'PowerShell', tool_input: { command: 'Remove-Item -Recurse -Force C:\\' } }, prefix: DANGER },
  { name: 'a builder pushing to main blocks', env: { CB_ROLE: 'builder' }, input: { tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, prefix: BUILDER },
  { name: 'a builder merging a PR blocks', env: { CB_ROLE: 'builder' }, input: { tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } }, prefix: BUILDER },
  { name: 'malformed input blocks', raw: 'not json', prefix: 'Blocked: ' },
];

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

// The shell Claude Code runs a hook command in: sh elsewhere; on Windows Git Bash (review I1: cmd.exe quotes, expands
// and fails differently, and exits 1, not 127, for a missing program), falling back to cmd.exe only with no Git Bash.
function hookShell() {
  if (process.platform !== 'win32') return null;
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')];
  return candidates.find((b) => b && existsSync(b)) ?? null;
}

// Run one hook: `how` is a shim path (run with this node) or { command } (a hook's command string, run through a shell
// as the agent CLI does). The env is this process's minus every CB_* the guard reads (any case: Windows env names are
// case-insensitive), so a squad seat running the installer cannot change what the probes see, plus the probe's own.
// { text } with the trimmed stdout, or { fail }.
function runHook(how, raw, extraEnv, name) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (CB_ENV.includes(k.toUpperCase())) delete env[k];
  Object.assign(env, extraEnv);
  const opts = { input: raw, encoding: 'utf8', env, timeout: 15_000, windowsHide: true };
  const bash = typeof how === 'string' ? null : hookShell();
  const r = typeof how === 'string' ? spawnSync(process.execPath, [how], opts)
    : bash ? spawnSync(bash, ['-c', how.command], opts) : spawnSync(how.command, { ...opts, shell: true });
  if (r.error || r.status !== 0) return { fail: `${name}: exit ${r.status}${r.error ? ` (${r.error.message})` : ''} ${String(r.stderr ?? '').trim().slice(0, 200)}` };
  return { text: String(r.stdout).trim() };
}

// The Claude probe's failure, or null.
function probe(shim, p) {
  const r = runHook(shim, p.raw ?? JSON.stringify(p.input), p.env, p.name);
  if (r.fail) return r.fail;
  const text = r.text;
  if (p.allow) return text === '{}' ? null : `${p.name}: expected {}, got ${text.slice(0, 200)}`;
  let out = null;
  try { out = JSON.parse(text); } catch {}
  return out?.decision === 'block' && typeof out.reason === 'string' && out.reason.startsWith(p.prefix)
    ? null : `${p.name}: expected a block starting "${p.prefix}", got ${text.slice(0, 200)}`;
}

// Each agent's probes: an allowed ls, git reset --hard, a tool the shim does not know, and malformed input. `want` reads
// the parsed answer: 'allow', or the prefix a refusal's reason must start with. Each shim answers in its CLI's own shape.
const AGENT_PROBES = {
  codex: {
    env: {},
    answer: (o) => (o && typeof o === 'object' && Object.keys(o).length === 0 ? { allow: true }
      : o?.hookSpecificOutput?.permissionDecision === 'deny' ? { reason: String(o.hookSpecificOutput.permissionDecisionReason ?? '') } : null),
    cases: [
      { name: 'codex: ls passes', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, want: 'allow' },
      { name: 'codex: git reset --hard blocks', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }, want: DANGER },
      { name: 'codex: a tool the shim does not know blocks', input: { hook_event_name: 'PreToolUse', tool_name: 'cb_unlisted_tool_probe', tool_input: {} }, want: 'Blocked: ' },
      { name: 'codex: malformed input blocks', raw: 'not json', want: 'Blocked: ' },
    ],
  },
  agy: {
    // agy's shim denies a pane with no role (the hook is per seat), so its probes run as a builder seat
    env: { CB_ROLE: 'builder', CB_AGENT: 'agy' },
    answer: (o) => (o?.decision === 'allow' ? { allow: true } : o?.decision === 'deny' ? { reason: String(o.reason ?? '') } : null),
    cases: [
      { name: 'agy: ls passes', input: { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } }, cwd: '/' }, want: 'allow' },
      { name: 'agy: git reset --hard blocks', input: { toolCall: { name: 'run_command', args: { CommandLine: 'git reset --hard' } }, cwd: '/' }, want: DANGER },
      { name: 'agy: a tool the shim does not know blocks', input: { toolCall: { name: 'cb_unlisted_tool_probe', args: {} }, cwd: '/' }, want: 'Blocked: ' },
      { name: 'agy: malformed input blocks', raw: 'not json', want: 'Blocked: ' },
    ],
  },
  opencode: {
    env: {},
    answer: (o) => (o && typeof o === 'object' && Object.keys(o).length === 0 ? { allow: true } : o?.decision === 'block' ? { reason: String(o.reason ?? '') } : null),
    cases: [
      { name: 'opencode: ls passes', input: { tool: 'bash', args: { command: 'ls' }, sessionID: 'probe' }, want: 'allow' },
      { name: 'opencode: git reset --hard blocks', input: { tool: 'bash', args: { command: 'git reset --hard' }, sessionID: 'probe' }, want: DANGER },
      { name: 'opencode: a tool the shim does not know blocks', input: { tool: 'cb_unlisted_tool_probe', args: {}, sessionID: 'probe' }, want: 'Blocked: ' },
      { name: 'opencode: malformed input blocks', raw: 'not json', want: 'Blocked: ' },
    ],
  },
};
// The failures of one agent's probes through `how` (a shim path or { command }).
function agentProbeFailures(agent, how) {
  const spec = AGENT_PROBES[agent];
  return spec.cases.map((c) => {
    const r = runHook(how, c.raw ?? JSON.stringify(c.input), spec.env, c.name);
    if (r.fail) return r.fail;
    let o = null;
    try { o = JSON.parse(r.text); } catch {}
    const a = spec.answer(o);
    if (c.want === 'allow') return a?.allow ? null : `${c.name}: expected an allow, got ${r.text.slice(0, 200)}`;
    return a && !a.allow && a.reason.startsWith(c.want) ? null : `${c.name}: expected a refusal starting "${c.want}", got ${r.text.slice(0, 200)}`;
  }).filter(Boolean);
}

// Install (or with checkOnly, compare) the guard files from srcDir into targetDir: GUARD_FILES, plus each agent's shim
// when `agents` names it. Returns { ok, target, probes, failures } (install) or { ok, target, drift } (check).
export function installGuard(srcDir, targetDir, { checkOnly = false, agents = [] } = {}) {
  const src = resolve(srcDir);
  const target = resolve(targetDir);
  const files = [...GUARD_FILES, ...agentFiles(agents)];
  if (checkOnly) {
    const drift = files.filter((f) => !existsSync(join(target, f)) || sha(join(src, f)) !== sha(join(target, f)));
    return { ok: drift.length === 0, target, drift };
  }
  const stage = `${target}.new`;
  rmSync(stage, { recursive: true, force: true }); // a stale stage from an interrupted run
  try {
    mkdirSync(stage, { recursive: true });
    for (const f of files) copyFileSync(join(src, f), join(stage, f));
    const failures = PROBES.map((p) => probe(join(stage, 'shim-claude.mjs'), p)).filter(Boolean);
    for (const a of agents) failures.push(...agentProbeFailures(a, join(stage, AGENT_SHIMS[a])));
    const total = PROBES.length + agents.reduce((n, a) => n + AGENT_PROBES[a].cases.length, 0);
    if (failures.length) return { ok: false, target, probes: total - failures.length, failures };
    // The swap never leaves the hook path missing (a missing file is a hook error, which the CLI treats as allow): a
    // first install renames the whole folder in; an update renames each file over the old one (atomic per file).
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      renameSync(stage, target);
    } else {
      for (const f of files) renameSync(join(stage, f), join(target, f));
    }
    return { ok: true, target, probes: total, failures: [] };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// #4348: the hook wiring in a Claude settings file. Matching files prove nothing if no hook runs them, so: a PreToolUse
// command hook that runs <target>/shim-claude.mjs, with an absolute node that is a file (a bare `node` missing from the
// hook shell's PATH exits 127, which Claude Code treats as allow), a matcher covering Bash (and PowerShell on Windows),
// no timeout short enough to fail open, hooks not turned off in this file, and, unless probes is false, the 6 probes
// through that exact command string. Several entries may run the shim: wired when one of them passes everything (a
// hook that errors is not a block, so only a good one protects). Only this file is read: settings.local.json, project
// settings and managed policy are other layers. Returns { ok, problems, probes }.
const MIN_TIMEOUT_S = 15;
// A path from a hook command as one comparable form (review I2): ~, $HOME and ${HOME} expanded; on Windows Git Bash's
// /c/... read as c:/..., backslashes as slashes, case folded.
export function hookPath(p, win, home = homedir()) {
  let s = p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[\\/]|$)/, home);
  if (!win) return s;
  s = s.replace(/\\/g, '/').replace(/^\/([a-z])(?=\/)/i, '$1:');
  return s.toLowerCase();
}
const covers = (matcher, tool) => {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(tool); } catch { return matcher === tool; }
};
// the quoted or bare words of a command, so each path in it can be compared whole
export const words = (command) => [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };

export function checkWiring(settingsFile, targetDir, { platform = process.platform, probes = true, home = homedir() } = {}) {
  const win = platform === 'win32';
  const shim = join(resolve(targetDir), 'shim-claude.mjs');
  const want = hookPath(shim, win, home);
  const fix = `point it at "${process.execPath}" "${shim}" (docs/ops/maintain.md, Installing the guard)`;
  let settings;
  try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch (e) {
    return { ok: false, probes: 0, problems: [`cannot read ${settingsFile}: ${e?.code ?? e?.message ?? e}`] };
  }
  if (settings?.disableAllHooks === true) {
    return { ok: false, probes: 0, problems: [`${settingsFile} sets disableAllHooks: true, so no hook runs, the guard included: remove it`] };
  }
  const entries = Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  const found = entries.flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : []).map((h) => ({ matcher: e.matcher, command: h?.command, type: h?.type, timeout: h?.timeout })))
    .filter((h) => h.type === 'command' && typeof h.command === 'string' && words(h.command).some((w) => hookPath(w, win, home) === want));
  if (!found.length) return { ok: false, probes: 0, problems: [`no PreToolUse hook runs ${shim} (as a command hook) in ${settingsFile}: ${fix}`] };
  let best = null;
  for (const h of found) {
    const r = checkHook(h, { win, home, probes, fix });
    if (r.problems.length === 0) return { ok: true, probes: r.probes, problems: [] };
    if (!best) best = r;
  }
  return { ok: false, probes: best.probes, problems: best.problems };
}

function checkHook(h, { win, home, probes, fix }) {
  const problems = [];
  const exe = words(h.command)[0] ?? '';
  const exePath = hookPath(exe, win, home);
  if (!/^(?:\/|[a-z]:[\\/])/i.test(exePath)) {
    problems.push(`the hook runs bare \`${exe}\`: where it is not on the hook shell's PATH the hook exits 127, which Claude Code treats as allow; ${fix}`);
  } else if (!existsSync(exePath)) {
    problems.push(`the hook's node ${exe} does not exist: ${fix}`);
  } else if (!isFile(exePath)) {
    problems.push(`the hook's node ${exe} is not a file: ${fix}`);
  }
  for (const tool of win ? ['Bash', 'PowerShell'] : ['Bash']) {
    if (!covers(h.matcher, tool)) problems.push(`the hook's matcher "${h.matcher}" misses ${tool}: set it to "${win ? 'Bash|PowerShell' : 'Bash'}"`);
  }
  if (h.timeout !== undefined && !(Number(h.timeout) >= MIN_TIMEOUT_S)) {
    problems.push(`the hook's timeout ${h.timeout} s is too short: a hook that times out counts as allow; remove it or set it to ${MIN_TIMEOUT_S} or more`);
  }
  let ran = 0;
  if (probes) {
    for (const p of PROBES) {
      const f = probe({ command: h.command }, p);
      if (f) problems.push(`probe ${f}`); else ran++;
    }
  }
  return { problems, probes: ran };
}

// ---- #4609: wiring Codex, agy and OpenCode seats to the installed guard ----

/** A key repeated in one JSON object, or null (review 70-M3: JSON.parse keeps the last one, while Codex's parser may
 *  refuse the file or keep another, so the check and the agent could read different hooks). Keys compare decoded, so
 *  "hooks" and "hooks" are the same key. Expects text JSON.parse accepts. (Shared with the seat prestart.) */
export function duplicateJsonKey(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.key) {
        const k = JSON.parse(text.slice(i, j + 1));
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

// a basic """ string ends at """ with no escaping backslash before it (a\""" is an escaped quote and "": round 2 minor 3)
const tomlCloses = (s, d) => (d === '"""' ? /(?<!\\)(?:\\\\)*"""/ : /'''/).test(s);

/** What a Codex config.toml says about hooks: `hooks`, its top-level [features] hooks (true, false, or undefined when
 *  unset); `profile`, the profile its top level selects; `profiles`, each profile's [profiles.<name>.features] hooks.
 *  Reads tables, dotted keys and inline tables. Review 70-M4: the text of a multi-line string ("""...""" or '''...''') is
 *  never read as keys, and profile counts only before the first table (after one, it is that table's key). (Shared with
 *  the seat prestart, #4609.) */
export function readCodexToml(toml) {
  const out = { hooks: undefined, profile: undefined, profiles: new Map() };
  const inlineHooks = (v) => { const m = /\bhooks\s*=\s*(\w+)/.exec(v); return m ? m[1] === 'true' : undefined; };
  let section = '', inTable = false, open = null;
  for (const raw of toml.split(/\r?\n/)) {
    if (open) { if (tomlCloses(raw, open)) open = null; continue; } // inside a multi-line string: text, not keys
    const line = raw.replace(/\s+#.*$|^#.*$/, '').trim();
    const head = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line); // [table] or [[array.of.tables]] (PR 77 review M2)
    if (head) { section = head[1].replace(/["'\s]/g, ''); inTable = true; continue; }
    const kv = /^([\w."' -]+?)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = [section, kv[1].replace(/["'\s]/g, '')].filter(Boolean).join('.'), val = kv[2].trim();
    // a multi-line string that runs on past this line: only a value that starts with one (a triple quote inside a
    // one-line string of the other kind, msg = "it'''s", opens nothing: PR 77 review M2)
    const ml = /^("""|''')/.exec(val);
    if (ml && !tomlCloses(val.slice(3), ml[1])) open = ml[1];
    let m;
    if (key === 'features.hooks') out.hooks = val === 'true';
    else if (key === 'features') { const h = inlineHooks(val); if (h !== undefined) out.hooks = h; }
    else if (key === 'profile' && !inTable) out.profile = val.replace(/^(["'])(.*)\1$/, '$2');
    else if ((m = /^profiles\.(.+)\.features\.hooks$/.exec(key))) out.profiles.set(m[1], val === 'true');
    else if ((m = /^profiles\.(.+?)(?:\.features)?$/.exec(key))) { const h = inlineHooks(val); if (h !== undefined) out.profiles.set(m[1], h); }
  }
  return out;
}
/** [features] hooks in a Codex config.toml: true, false, or undefined when it does not set it. */
export const codexHooksFeature = (toml) => readCodexToml(toml).hooks;

// config.toml with hooks = true, as { toml } (unchanged when it is already on) or { problem }. An explicit false and an
// inline features table are the owner's to change: never flipped or rewritten here.
function codexTomlWithHooks(toml) {
  const r = readCodexToml(toml);
  if (r.profile !== undefined && r.profiles.get(r.profile) === false) return { problem: `selects profile "${r.profile}", which sets hooks = false: that is a choice made on this machine, so change it by hand` };
  if (r.hooks === true) return { toml };
  if (r.hooks === false) return { problem: 'sets [features] hooks = false: that is a choice made on this machine, so change it to true by hand' };
  const lines = toml.split(/\r?\n/);
  let section = '', open = null;
  for (let i = 0; i < lines.length; i++) {
    if (open) { if (tomlCloses(lines[i], open)) open = null; continue; } // a multi-line string's text is not a table header
    const line = lines[i].replace(/\s+#.*$|^#.*$/, '').trim();
    const ml = /=\s*("""|''')(.*)$/.exec(line);
    if (ml && !tomlCloses(ml[2], ml[1])) { open = ml[1]; continue; }
    const head = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (head) {
      section = head[1].replace(/["'\s]/g, '');
      // the [features] table: hooks = true goes on the line after its header
      if (section === 'features') { lines.splice(i + 1, 0, 'hooks = true'); return { toml: lines.join('\n') }; }
      continue;
    }
    if (!section && /^features\s*=/.test(line)) return { problem: 'has an inline features = { ... } table: add hooks = true to it by hand' };
  }
  // dotted top-level keys (features.x = ...) forbid a later [features] table: add one more dotted key at the top
  if (lines.some((l) => /^\s*features\s*\./.test(l))) return { toml: `features.hooks = true\n${toml}` };
  return { toml: `${toml}${toml && !toml.endsWith('\n') ? '\n' : ''}${toml ? '\n' : ''}[features]\nhooks = true\n` };
}

const fwd = (p) => p.replace(/\\/g, '/');
const quoteIfSpaced = (p) => (/\s/.test(p) ? `"${p}"` : p);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readText = (f) => { try { return readFileSync(f, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
// write only when the text changes, through a temp file and a rename (a reader never sees half a file)
function writeIfChanged(file, text, changed) {
  if (readText(file) === text) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.cb-new`, text);
  renameSync(`${file}.cb-new`, file);
  changed.push(file);
}
const runsFile = (command, file, win, home) => typeof command === 'string' && words(command).some((w) => hookPath(w, win, home) === hookPath(fwd(file), win, home));
const namesShim = (command, shim) => typeof command === 'string' && words(command).some((w) => basename(fwd(w)).toLowerCase() === shim);
const codexDir = (env, home) => env.CODEX_HOME || join(home, '.codex');
const opencodePlugin = (env, home) => join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'plugins', 'cb-guard.js');
const codexCommand = (node, shim) => `${quoteIfSpaced(fwd(node))} ${quoteIfSpaced(fwd(shim))}`;
// agy runs hooks through cmd /c on Windows: forward slashes, no quotes, and node from PATH (a missing node is a deny there)
const agyCommand = (shim) => `node ${fwd(shim)}`;
const renderPlugin = (node, shim) => {
  const tpl = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'opencode-plugin.js'), 'utf8');
  return tpl.replace('"__CB_NODE__"', JSON.stringify(fwd(node))).replace('"__CB_SHIM__"', JSON.stringify(fwd(shim)));
};

// The info/exclude a seat folder's repo reads, and the seat's path from that repo's root, or null outside git. Handles a
// worktree (.git is a file naming its gitdir, whose commondir holds the shared info/exclude).
function seatExclude(seat) {
  for (let dir = seat; ; dir = dirname(dir)) {
    const dot = join(dir, '.git');
    let st = null;
    try { st = statSync(dot); } catch {}
    if (st) {
      let gitdir = dot;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dot, 'utf8'));
        if (!m) return null;
        gitdir = resolve(dir, m[1]);
        const common = readText(join(gitdir, 'commondir'));
        if (common !== null && common.trim()) gitdir = resolve(gitdir, common.trim());
      }
      return { file: join(gitdir, 'info', 'exclude'), rel: fwd(relative(dir, seat)) };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Point each named agent's hook at the installed guard in targetDir (installGuard with the same agents first). Returns
 *  { ok, changed: [files written], problems: [why an agent was not wired] }. An agent with a problem writes nothing. */
export function wireAgents(targetDir, { agents = [], seats = [], env = process.env, home = homedir(), platform = process.platform, node = process.execPath } = {}) {
  const target = resolve(targetDir), win = platform === 'win32';
  const changed = [], problems = [];
  agentFiles(agents);
  for (const a of agents) if (!existsSync(join(target, AGENT_SHIMS[a]))) problems.push(`${a}: ${join(target, AGENT_SHIMS[a])} is not installed: run node kit/guard/install.mjs --agents ${a} first`);
  if (problems.length) return { ok: false, changed, problems };

  if (agents.includes('codex')) (() => {
    const dir = codexDir(env, home), hooksFile = join(dir, 'hooks.json'), tomlFile = join(dir, 'config.toml');
    let doc = {};
    try {
      const t = readText(hooksFile);
      if (t !== null && t.trim()) doc = JSON.parse(t);
      const dup = t === null ? null : duplicateJsonKey(t);
      if (dup !== null) return problems.push(`codex: ${hooksFile} repeats the key "${dup}": rewriting it would drop one, so fix it by hand`);
    } catch (e) { return problems.push(`codex: ${hooksFile} is not JSON or cannot be read (${e?.message ?? e}): fix it by hand, then run this again`); }
    if (!isObj(doc) || (doc.hooks !== undefined && !isObj(doc.hooks)) || (doc.hooks?.PreToolUse !== undefined && !Array.isArray(doc.hooks.PreToolUse))) {
      return problems.push(`codex: ${hooksFile} does not have the { "hooks": { "PreToolUse": [...] } } shape: fix it by hand`);
    }
    const toml = codexTomlWithHooks(readText(tomlFile) ?? '');
    if (toml.problem) return problems.push(`codex: ${tomlFile} ${toml.problem}`);
    // every guard entry (an earlier install, or one pointing at a checkout) goes; every other hook stays as it was
    const pre = (doc.hooks?.PreToolUse ?? []).flatMap((e) => {
      if (!isObj(e) || !Array.isArray(e.hooks)) return [e];
      const kept = e.hooks.filter((h) => !namesShim(h?.command, AGENT_SHIMS.codex));
      return kept.length === e.hooks.length ? [e] : kept.length ? [{ ...e, hooks: kept }] : [];
    });
    pre.push({ matcher: AGENT_MATCHERS.codex, hooks: [{ type: 'command', command: codexCommand(node, join(target, AGENT_SHIMS.codex)), timeout: 30 }] });
    writeIfChanged(hooksFile, `${JSON.stringify({ ...doc, hooks: { ...(doc.hooks ?? {}), PreToolUse: pre } }, null, 2)}\n`, changed);
    writeIfChanged(tomlFile, toml.toml, changed);
  })();

  if (agents.includes('agy')) (() => {
    if (!seats.length) return problems.push('agy: name each seat folder with --seat <folder>: its hook lives in <folder>/.agents/hooks.json, per seat');
    const shim = fwd(join(target, AGENT_SHIMS.agy));
    if (/\s/.test(shim)) return problems.push(`agy: the guard path ${shim} has a space, and agy runs a hook command with no quotes (cmd /c on Windows): install the guard where the path has none (--target)`);
    for (const s of seats.map((x) => resolve(x))) {
      const file = join(s, '.agents', 'hooks.json');
      let doc = {};
      try {
        const t = readText(file);
        if (t !== null && t.trim()) doc = JSON.parse(t);
        const dup = t === null ? null : duplicateJsonKey(t);
        if (dup !== null) { problems.push(`agy: ${file} repeats the key "${dup}": rewriting it would drop one, so fix it by hand`); continue; }
      } catch (e) { problems.push(`agy: ${file} is not JSON or cannot be read (${e?.message ?? e}): fix it by hand`); continue; }
      if (!isObj(doc)) { problems.push(`agy: ${file} is not a JSON object: fix it by hand`); continue; }
      const group = { PreToolUse: [{ matcher: AGENT_MATCHERS.agy, hooks: [{ type: 'command', command: agyCommand(shim), timeout: 10 }] }] };
      writeIfChanged(file, `${JSON.stringify({ ...doc, 'cb-guard': group }, null, 2)}\n`, changed);
      // the hook file never shows up as a change in the seat's repo
      const ex = seatExclude(s);
      if (ex) {
        const line = `/${ex.rel ? `${ex.rel}/` : ''}.agents/`;
        const text = readText(ex.file) ?? '';
        if (!text.split(/\r?\n/).includes(line)) writeIfChanged(ex.file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`, changed);
      }
    }
  })();

  if (agents.includes('opencode')) writeIfChanged(opencodePlugin(env, home), renderPlugin(node, join(target, AGENT_SHIMS.opencode)), changed);
  return { ok: problems.length === 0, changed, problems };
}

/** --check for the agents: each wiring is in place, runs the installed shim, and passes the agent's probes through its
 *  own command (OpenCode: the plugin is exactly what this checkout writes, and the shim passes them). { ok, problems, probes } */
export function checkAgentWiring(targetDir, { agents = [], seats = [], env = process.env, home = homedir(), platform = process.platform, node = process.execPath } = {}) {
  const target = resolve(targetDir), win = platform === 'win32';
  const problems = [];
  let probes = 0;
  const probeThrough = (a, how) => { const f = agentProbeFailures(a, how); probes += AGENT_PROBES[a].cases.length - f.length; problems.push(...f); };
  const fix = (a) => `run node kit/guard/install.mjs --agents ${a}${a === 'agy' ? ' --seat <folder>' : ''}`;
  const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
  const guardHooks = (entries, shim) => (Array.isArray(entries) ? entries : []).filter((e) => isObj(e) && e.enabled !== false && e.matcher === '.*')
    .flatMap((e) => (Array.isArray(e.hooks) ? e.hooks : [])).filter((h) => isObj(h) && h.enabled !== false && (h.type ?? 'command') === 'command' && runsFile(h.command, shim, win, home));

  if (agents.includes('codex')) {
    const dir = codexDir(env, home), shim = join(target, AGENT_SHIMS.codex);
    const t = readCodexToml(readText(join(dir, 'config.toml')) ?? '');
    if (t.hooks !== true) problems.push(`codex: ${join(dir, 'config.toml')} does not set [features] hooks = true: ${fix('codex')}`);
    if (t.profile !== undefined && t.profiles.get(t.profile) === false) problems.push(`codex: ${join(dir, 'config.toml')} selects profile "${t.profile}", which sets hooks = false: change it by hand`);
    const hooks = guardHooks(readJson(join(dir, 'hooks.json'))?.hooks?.PreToolUse, shim);
    if (!hooks.length) problems.push(`codex: no PreToolUse hook with matcher .* in ${join(dir, 'hooks.json')} runs ${shim}: ${fix('codex')}`);
    else probeThrough('codex', { command: hooks[0].command });
  }
  if (agents.includes('agy')) {
    const shim = join(target, AGENT_SHIMS.agy);
    if (!seats.length) problems.push('agy: name each seat folder to check with --seat <folder>');
    for (const s of seats.map((x) => resolve(x))) {
      const file = join(s, '.agents', 'hooks.json');
      const group = readJson(file)?.['cb-guard'];
      const hooks = isObj(group) && group.enabled !== false ? guardHooks(group.PreToolUse, shim) : [];
      if (!hooks.length) problems.push(`agy: no cb-guard PreToolUse hook with matcher .* in ${file} runs ${shim}: ${fix('agy')}`);
      else probeThrough('agy', { command: hooks[0].command });
    }
  }
  if (agents.includes('opencode')) {
    const file = opencodePlugin(env, home), shim = join(target, AGENT_SHIMS.opencode);
    const text = readText(file);
    if (text === null) problems.push(`opencode: no ${file}: ${fix('opencode')}`);
    else if (text !== renderPlugin(node, shim)) problems.push(`opencode: ${file} is not the plugin this checkout writes for ${shim}: ${fix('opencode')}`);
    else probeThrough('opencode', shim);
  }
  return { ok: problems.length === 0, problems, probes };
}

let main = false;
if (process.argv[1]) {
  try {
    main = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    main = import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  }
}
if (main) {
  const usage = 'usage: node kit/guard/install.mjs [--target <dir>] [--agents codex,agy,opencode [--seat <folder>]...] [--check [--settings <file> | --no-wiring]]';
  const args = process.argv.slice(2);
  const defaultTarget = join(homedir(), '.claude-board', 'guard');
  let target = defaultTarget;
  let settingsFile = null;
  let checkOnly = false;
  let noWiring = false;
  let bad = false;
  let agents = [];
  const seats = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') checkOnly = true;
    else if (args[i] === '--no-wiring') noWiring = true;
    else if (args[i] === '--target' && args[i + 1] && !args[i + 1].startsWith('-')) target = args[++i];
    else if (args[i] === '--settings' && args[i + 1] && !args[i + 1].startsWith('-')) settingsFile = args[++i];
    else if (args[i] === '--agents' && args[i + 1] && !args[i + 1].startsWith('-')) agents = [...new Set(args[++i].split(',').map((a) => a.trim().toLowerCase()).filter(Boolean))];
    else if (args[i] === '--seat' && args[i + 1] && !args[i + 1].startsWith('-')) seats.push(args[++i]);
    else bad = true;
  }
  // #4609: only known agents; agy's hook is per seat folder, and a seat folder means nothing without agy
  if (agents.some((a) => !Object.hasOwn(AGENT_SHIMS, a)) || (agents.includes('agy') !== (seats.length > 0))) bad = true;
  // the wiring is this machine's ~/.claude/settings.json for the default target; for another target only when named
  // --no-wiring: the Claude settings file is not checked (CI, a machine with no ~/.claude); named agents always are
  if (checkOnly && !noWiring && !settingsFile && resolve(target) === resolve(defaultTarget)) settingsFile = join(homedir(), '.claude', 'settings.json');
  if (bad) {
    console.error(usage);
    if (agents.some((a) => !Object.hasOwn(AGENT_SHIMS, a))) console.error(`known agents: ${Object.keys(AGENT_SHIMS).join(', ')}`);
    if (agents.includes('agy') && !seats.length) console.error('agy needs --seat <folder> for each seat folder (its hook lives in <folder>/.agents/hooks.json)');
    if (seats.length && !agents.includes('agy')) console.error('--seat is for agy: add agy to --agents');
    process.exitCode = 2;
  } else {
    try {
      const r = installGuard(dirname(fileURLToPath(import.meta.url)), target, { checkOnly, agents });
      const files = [...GUARD_FILES, ...agents.map((a) => AGENT_SHIMS[a])].join(', ');
      if (checkOnly) {
        if (r.ok) console.log(`guard at ${r.target}: matches this checkout (${files})`);
        else console.log(`guard at ${r.target}: differs from this checkout: ${r.drift.join(', ')}; run node kit/guard/install.mjs --target ${r.target}${agents.length ? ` --agents ${agents.join(',')}` : ''}`);
        if (settingsFile) {
          const w = checkWiring(settingsFile, target);
          if (w.ok) console.log(`hook in ${settingsFile}: runs ${join(r.target, 'shim-claude.mjs')}, ${w.probes} probes passed`);
          else for (const p of w.problems) console.log(`hook: ${p}`);
          r.ok = r.ok && w.ok;
        }
        if (agents.length) {
          const a = checkAgentWiring(target, { agents, seats });
          if (a.ok) console.log(`agents ${agents.join(', ')}: wired to ${r.target}, ${a.probes} probes passed`);
          else for (const p of a.problems) console.log(`agent: ${p}`);
          r.ok = r.ok && a.ok;
        }
      } else if (r.ok) {
        console.log(`guard installed at ${r.target}: ${r.probes} probes passed`);
        if (agents.length) {
          const w = wireAgents(target, { agents, seats });
          for (const f of w.changed) console.log(`wired: ${f}`);
          if (!w.changed.length) console.log(`agents ${agents.join(', ')}: already wired, nothing changed`);
          for (const p of w.problems) console.error(`NOT wired: ${p}`);
          if (agents.includes('agy') && w.ok) console.log('agy loads a seat folder\'s hooks only once agy trusts that folder: trust each seat folder in agy');
          r.ok = w.ok;
        }
      } else {
        console.error(`guard NOT installed at ${r.target} (left as it was): ${r.failures.length} of ${r.probes + r.failures.length} probes failed`);
        for (const f of r.failures) console.error(`  - ${f}`);
      }
      process.exitCode = r.ok ? 0 : 1;
    } catch (e) {
      console.error(`guard install failed (target left as it was or partly updated: run --check): ${e?.message ?? e}`);
      process.exitCode = 1;
    }
  }
}
