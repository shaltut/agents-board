// Installs the guard (#4002): node kit/guard/install.mjs [--target <dir>] [--check]
// Copies core.mjs and shim-claude.mjs to <target>.new, runs 6 hook probes against the staged shim with CB_ROLE, CB_AGENT,
// CB_PROTECTED_BRANCHES and CB_ALLOW_ASK cleared, and moves them into <target> only when all 6 pass. --check compares
// SHA-256 hashes with this checkout and writes nothing (exit 1 on drift); with the default target (or --settings) it also
// checks the hook wiring in ~/.claude/settings.json (checkWiring, #4348).
// The default target, ~/.claude-board/guard, is what every Claude session's PreToolUse hook runs: install there only
// with Ahmed's yes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// core first: on an update the shim loads core.mjs on every run, and an old shim with a new core still blocks on error
export const GUARD_FILES = ['core.mjs', 'shim-claude.mjs'];
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

// The probe's failure, or null. The env is this process's minus every CB_* the guard reads (any case: Windows env
// names are case-insensitive), so a squad seat running the installer cannot change what the probes see. `shim` is the
// shim's path (run with this node), or { command } to run a hook's command string through a shell, as Claude Code does.
function probe(shim, p) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (CB_ENV.includes(k.toUpperCase())) delete env[k];
  Object.assign(env, p.env);
  const opts = { input: p.raw ?? JSON.stringify(p.input), encoding: 'utf8', env, timeout: 15_000, windowsHide: true };
  const r = typeof shim === 'string' ? spawnSync(process.execPath, [shim], opts) : spawnSync(shim.command, { ...opts, shell: true });
  if (r.error || r.status !== 0) return `${p.name}: exit ${r.status}${r.error ? ` (${r.error.message})` : ''} ${String(r.stderr ?? '').trim().slice(0, 200)}`;
  const text = String(r.stdout).trim();
  if (p.allow) return text === '{}' ? null : `${p.name}: expected {}, got ${text.slice(0, 200)}`;
  let out = null;
  try { out = JSON.parse(text); } catch {}
  return out?.decision === 'block' && typeof out.reason === 'string' && out.reason.startsWith(p.prefix)
    ? null : `${p.name}: expected a block starting "${p.prefix}", got ${text.slice(0, 200)}`;
}

// Install (or with checkOnly, compare) the guard files from srcDir into targetDir.
// Returns { ok, target, probes, failures } (install) or { ok, target, drift } (check).
export function installGuard(srcDir, targetDir, { checkOnly = false } = {}) {
  const src = resolve(srcDir);
  const target = resolve(targetDir);
  if (checkOnly) {
    const drift = GUARD_FILES.filter((f) => !existsSync(join(target, f)) || sha(join(src, f)) !== sha(join(target, f)));
    return { ok: drift.length === 0, target, drift };
  }
  const stage = `${target}.new`;
  rmSync(stage, { recursive: true, force: true }); // a stale stage from an interrupted run
  try {
    mkdirSync(stage, { recursive: true });
    for (const f of GUARD_FILES) copyFileSync(join(src, f), join(stage, f));
    const failures = PROBES.map((p) => probe(join(stage, 'shim-claude.mjs'), p)).filter(Boolean);
    if (failures.length) return { ok: false, target, probes: PROBES.length - failures.length, failures };
    // The swap never leaves the hook path missing (a missing file is a hook error, which the CLI treats as allow): a
    // first install renames the whole folder in; an update renames each file over the old one (atomic per file).
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      renameSync(stage, target);
    } else {
      for (const f of GUARD_FILES) renameSync(join(stage, f), join(target, f));
    }
    return { ok: true, target, probes: PROBES.length, failures: [] };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// #4348: the hook wiring in a Claude settings file. Matching files prove nothing if no hook runs them, so: a PreToolUse
// entry whose command runs <target>/shim-claude.mjs, with an absolute node that exists (a bare `node` missing from the
// hook shell's PATH exits 127, which Claude Code treats as allow), a matcher covering Bash (and PowerShell on Windows),
// and, unless probes is false, the 6 probes through that exact command string. Returns { ok, problems, probes }.
const slash = (s, win) => (win ? s.replace(/\\/g, '/').toLowerCase() : s);
const covers = (matcher, tool) => {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(tool); } catch { return matcher === tool; }
};
export function checkWiring(settingsFile, targetDir, { platform = process.platform, probes = true } = {}) {
  const win = platform === 'win32';
  const shim = join(resolve(targetDir), 'shim-claude.mjs');
  const fix = `point it at "${process.execPath}" "${shim}" (docs/ops/maintain.md, Installing the guard)`;
  let settings;
  try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch (e) {
    return { ok: false, probes: 0, problems: [`cannot read ${settingsFile}: ${e?.code ?? e?.message ?? e}`] };
  }
  const entries = Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  const found = entries.flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : []).map((h) => ({ matcher: e.matcher, command: h?.command })))
    .find((h) => typeof h.command === 'string' && slash(h.command, win).includes(slash(shim, win)));
  if (!found) return { ok: false, probes: 0, problems: [`no PreToolUse hook runs ${shim} in ${settingsFile}: ${fix}`] };
  const problems = [];
  const node = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(found.command);
  const exe = node?.[1] ?? node?.[2] ?? node?.[3] ?? '';
  if (!/^(?:\/|[a-z]:[\\/])/i.test(exe)) {
    problems.push(`the hook runs bare \`${exe}\`: where it is not on the hook shell's PATH the hook exits 127, which Claude Code treats as allow; ${fix}`);
  } else if (!existsSync(exe)) {
    problems.push(`the hook's node ${exe} does not exist: ${fix}`);
  }
  for (const tool of win ? ['Bash', 'PowerShell'] : ['Bash']) {
    if (!covers(found.matcher, tool)) problems.push(`the hook's matcher "${found.matcher}" misses ${tool}: set it to "${win ? 'Bash|PowerShell' : 'Bash'}"`);
  }
  let ran = 0;
  if (probes) {
    for (const p of PROBES) {
      const f = probe({ command: found.command }, p);
      if (f) problems.push(`probe ${f}`); else ran++;
    }
  }
  return { ok: problems.length === 0, probes: ran, problems };
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
  const usage = 'usage: node kit/guard/install.mjs [--target <dir>] [--check [--settings <file>]]';
  const args = process.argv.slice(2);
  const defaultTarget = join(homedir(), '.claude-board', 'guard');
  let target = defaultTarget;
  let settingsFile = null;
  let checkOnly = false;
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') checkOnly = true;
    else if (args[i] === '--target' && args[i + 1] && !args[i + 1].startsWith('-')) target = args[++i];
    else if (args[i] === '--settings' && args[i + 1] && !args[i + 1].startsWith('-')) settingsFile = args[++i];
    else bad = true;
  }
  // the wiring is this machine's ~/.claude/settings.json for the default target; for another target only when named
  if (checkOnly && !settingsFile && resolve(target) === resolve(defaultTarget)) settingsFile = join(homedir(), '.claude', 'settings.json');
  if (bad) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    try {
      const r = installGuard(dirname(fileURLToPath(import.meta.url)), target, { checkOnly });
      if (checkOnly) {
        if (r.ok) console.log(`guard at ${r.target}: matches this checkout (${GUARD_FILES.join(', ')})`);
        else console.log(`guard at ${r.target}: differs from this checkout: ${r.drift.join(', ')}; run node kit/guard/install.mjs --target ${r.target}`);
        if (settingsFile) {
          const w = checkWiring(settingsFile, target);
          if (w.ok) console.log(`hook in ${settingsFile}: runs ${join(r.target, 'shim-claude.mjs')}, ${w.probes} probes passed`);
          else for (const p of w.problems) console.log(`hook: ${p}`);
          r.ok = r.ok && w.ok;
        }
      } else if (r.ok) {
        console.log(`guard installed at ${r.target}: ${r.probes} probes passed`);
      } else {
        console.error(`guard NOT installed at ${r.target} (left as it was): ${r.failures.length} of ${PROBES.length} probes failed`);
        for (const f of r.failures) console.error(`  - ${f}`);
      }
      process.exitCode = r.ok ? 0 : 1;
    } catch (e) {
      console.error(`guard install failed (target left as it was or partly updated: run --check): ${e?.message ?? e}`);
      process.exitCode = 1;
    }
  }
}
