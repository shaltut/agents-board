// The agy guard shim (#4002 phase 5): hook input in, agy's allow/deny JSON out, failing closed. Pure: no DB, no agy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASK_TOOLS, DENIED_TOOLS, EDIT_TOOLS, PATH_ARGS, READ_TOOLS, SHELL_TOOLS, checkEditPath, normSegment, parseAgyInput, runAgyShim } from '../kit/guard/shim-agy.mjs';
import { agyAdapter } from '../cli/agents/agy.ts';

const SHIM = fileURLToPath(new URL('../kit/guard/shim-agy.mjs', import.meta.url));
const CB_ENV = ['CB_ROLE', 'CB_AGENT', 'CB_PROTECTED_BRANCHES', 'CB_ALLOW_ASK'];
function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (CB_ENV.includes(k.toUpperCase())) delete env[k];
  return { ...env, ...extra };
}
/** A board seat's env: cb squad up always sets CB_AGENT and CB_ROLE. */
const seat = (extra: Record<string, string> = {}) => ({ CB_AGENT: 'agy', CB_ROLE: 'builder', ...extra });
type Out = { decision?: string; reason?: string };
/** One real hook run: exit 0 and JSON on stdout. An empty or unparsable stdout fails the test (agy would deny it). */
function runHook(input: string, env: Record<string, string> = seat(), file = SHIM): Out & { stdout: string } {
  const r = spawnSync(process.execPath, [file], { input, encoding: 'utf8', env: cleanEnv(env) });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return { ...JSON.parse(r.stdout), stdout: r.stdout };
}
const shell = (CommandLine: unknown) => JSON.stringify({ toolCall: { id: 't1', name: 'run_command', args: { CommandLine } }, stepIdx: 3, hookEventName: 'PreToolUse' });
const tool = (name: unknown, args: unknown = { TargetFile: 'a.ts' }, extra: Record<string, unknown> = {}) => JSON.stringify({ toolCall: { name, args }, ...extra });

test('allow prints exactly {"decision":"allow"} (agy counts {} as a deny)', () => {
  assert.equal(runHook(shell('ls -la')).stdout, '{"decision":"allow"}');
  assert.deepEqual(runAgyShim(shell('git status'), seat()), { decision: 'allow' });
});

test('a dangerous command is denied with the guard reason, in agy\'s deny format', () => {
  const r = runHook(shell('git reset --hard'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason ?? '', /^Blocked dangerous command: /);
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)).sort(), ['decision', 'reason']);
});

test('a role block: a builder cannot push to main or merge a PR', () => {
  for (const c of ['git push origin main', 'gh pr merge 1']) {
    const r = runHook(shell(c), seat({ CB_ROLE: 'builder' }));
    assert.equal(r.decision, 'deny', c);
    assert.match(r.reason ?? '', /^Blocked by role \(builder\): /);
  }
  assert.equal(runHook(shell('git push origin feat/x'), seat({ CB_ROLE: 'builder' })).decision, 'allow');
});

test('CB_PROTECTED_BRANCHES is read from the env', () => {
  assert.equal(runHook(shell('git push origin release/1'), seat({ CB_PROTECTED_BRANCHES: 'release/*' })).decision, 'deny');
  assert.equal(runHook(shell('git push origin release/1')).decision, 'allow');
});

test('a pane with neither CB_ROLE nor CB_AGENT is denied, naming the board guard; CB_ROLE is enough', () => {
  for (const raw of [shell('ls'), tool('read_file', {}), tool('write_file')]) {
    const r = runHook(raw, {});
    assert.equal(r.decision, 'deny');
    assert.match(r.reason ?? '', /not a board seat.*board guard/);
  }
  assert.equal(runHook(shell('ls'), { CB_ROLE: 'builder' }).decision, 'allow');
  assert.equal(runHook(shell('ls'), { CB_AGENT: '  ' }).decision, 'deny');
});

test('#4392: CB_AGENT without CB_ROLE is denied for every tool (no role means no secret or fence rule in core)', () => {
  for (const raw of [shell('ls'), shell('cat .env'), tool('read_file', { TargetFile: 'src/a.ts' }, { cwd: ws, workspacePaths: [ws] }), tool('write_file', { TargetFile: 'src/a.ts' }, { cwd: ws, workspacePaths: [ws] })]) {
    for (const env of [{ CB_AGENT: 'agy' }, { CB_AGENT: 'agy', CB_ROLE: '  ' }]) {
      const r = runAgyShim(raw, env);
      assert.equal(r.decision, 'deny', raw);
      assert.match(r.reason ?? '', /CB_ROLE is not set/);
    }
  }
});

test('read-only roles are denied every edit tool; a read tool is allowed to any role', () => {
  for (const name of EDIT_TOOLS) {
    for (const role of ['reviewer', 'qa', 'investigator']) {
      const r = runAgyShim(tool(name), seat({ CB_ROLE: role }));
      assert.equal(r.decision, 'deny', `${name} ${role}`);
      assert.match(r.reason ?? '', /^Blocked by role \(/);
    }
  }
  for (const name of READ_TOOLS) for (const role of ['reviewer', 'builder', 'lead']) assert.deepEqual(runAgyShim(tool(name, { TargetFile: 'src/a.ts' }, { cwd: ws, workspacePaths: [ws] }), seat({ CB_ROLE: role })), { decision: 'allow' }, name);
});

test('ask_question is denied unless CB_ALLOW_ASK=1', () => {
  assert.equal(runAgyShim(tool('ask_question'), seat()).decision, 'deny');
  assert.deepEqual(runAgyShim(tool('ask_question'), seat({ CB_ALLOW_ASK: '1' })), { decision: 'allow' });
});

test('fails closed on malformed input: empty, bad JSON, wrong shapes, missing pieces', () => {
  for (const raw of ['', '   ', 'not json', 'null', '[]', '"x"', '{}', '{"toolCall":null}', '{"toolCall":[]}',
    JSON.stringify({ toolCall: { args: { CommandLine: 'ls' } } }), JSON.stringify({ toolCall: { name: '', args: {} } }),
    JSON.stringify({ toolCall: { name: 5, args: {} } }),
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), // Claude's shape is not agy's
    shell(undefined), shell(5), JSON.stringify({ toolCall: { name: 'run_command' } }), JSON.stringify({ toolCall: { name: 'run_command', args: [] } })]) {
    const r = runAgyShim(raw, seat());
    assert.equal(r.decision, 'deny', JSON.stringify(raw));
    assert.match(r.reason ?? '', /^Blocked: guard could not read hook input/);
  }
  assert.equal(runHook('not json').decision, 'deny');
  assert.equal(parseAgyInput(undefined as any).ok, false);
});

test('an unlisted tool is denied (reads, subagents, MCP, case and spacing variants)', () => {
  for (const name of ['list_dir', 'grep_search', 'search_web', 'invoke_subagent', 'call_mcp_tool', 'manage_task', 'Bash', 'run_command ', 'RUN_COMMAND', 'View_File']) {
    const r = runAgyShim(tool(name), seat());
    assert.equal(r.decision, 'deny', name);
    assert.match(r.reason ?? '', /^Blocked: unrecognized tool /);
  }
});

test('send_command_input is denied for every role (it would feed a running interpreter past core.check)', () => {
  for (const role of ['lead', 'builder', 'reviewer', 'qa', 'investigator', 'architect', 'owner']) {
    const r = runAgyShim(JSON.stringify({ toolCall: { name: 'send_command_input', args: { Input: 'ls\n' } } }), seat({ CB_ROLE: role }));
    assert.equal(r.decision, 'deny', role);
    assert.match(r.reason ?? '', /send_command_input is denied for every role/);
  }
});

test('the shim\'s tool sets and guardInstallSpec agree: a catch-all matcher, sets disjoint, every tool handled', () => {
  const spec = agyAdapter.guardInstallSpec('C:/w/board', 'win32');
  for (const p of ['win32', 'darwin', 'linux'] as const) assert.equal(spec.matchers[p], '.*'); // catch-all: the shim denies what it cannot judge
  const all = [SHELL_TOOLS, EDIT_TOOLS, READ_TOOLS, ASK_TOOLS, DENIED_TOOLS].flat();
  assert.equal(new Set(all).size, all.length, 'a tool name is in two sets');
  assert.ok(DENIED_TOOLS.includes('send_command_input'));
  const re = new RegExp(`^(?:${spec.matchers.win32})$`);
  for (const name of [...all, 'some_tool_nobody_listed']) assert.ok(re.test(name), `matcher misses ${name}`);
  // a handled tool is never the "unrecognized" denial; the denied one never parses
  for (const name of [...SHELL_TOOLS, ...EDIT_TOOLS, ...READ_TOOLS, ...ASK_TOOLS]) assert.equal(parseAgyInput(tool(name, { CommandLine: 'ls' })).ok, true, name);
  for (const name of DENIED_TOOLS) assert.equal(parseAgyInput(tool(name)).ok, false);
});

// Edit confinement: a real workspace on disk so symlink resolution is exercised.
const ws = realpathSync(mkdtempSync(join(tmpdir(), 'agy-ws-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'agy-out-')));
for (const d of ['src', 'kit/guard', 'kit/other', '.git/hooks', '.agents', '.gemini']) mkdirSync(join(ws, d), { recursive: true });
const edit = (args: unknown, extra: Record<string, unknown> = { cwd: ws, workspacePaths: [ws] }, name = 'write_file') => runAgyShim(tool(name, args, extra), seat({ CB_ROLE: 'builder' }));

test('edit confinement: inside the workspace is allowed, for every listed edit tool and path arg', () => {
  for (const name of EDIT_TOOLS) for (const k of PATH_ARGS) {
    assert.deepEqual(edit({ [k]: join(ws, 'src', 'a.ts') }, undefined, name), { decision: 'allow' }, `${name} ${k}`);
  }
  assert.deepEqual(edit({ TargetFile: 'src/new.ts' }), { decision: 'allow' }); // relative: resolved against the cwd
  assert.deepEqual(edit({ TargetFile: join(ws, 'kit', 'other', 'x.mjs') }), { decision: 'allow' });
  assert.deepEqual(edit({ TargetFile: 'a.ts' }, { cwd: join(ws, 'src'), workspacePaths: [ws] }), { decision: 'allow' });
});

test('edit confinement: outside the workspace is denied (absolute, ../ and a sibling with the same prefix)', () => {
  for (const t of [join(outside, 'x'), '../x', '../../etc/x', join(ws + '-sibling', 'x'), ws]) {
    const r = edit({ TargetFile: t });
    assert.equal(r.decision, 'deny', t);
    assert.match(r.reason ?? '', /editing outside the workspace/);
  }
  assert.equal(edit({ TargetFile: '../../x' }, { cwd: join(ws, 'src'), workspacePaths: [ws] }).decision, 'deny');
});

test('edit confinement: .git, .agents, .gemini and kit/guard are denied, at any depth and by any path form', () => {
  for (const t of ['.git/hooks/pre-commit', join(ws, '.git', 'config'), '.agents/hooks.json', '.gemini/config/hooks.json', 'src/.git/x', 'kit/guard/core.mjs', join(ws, 'kit', 'guard', 'shim-agy.mjs'), 'src/../.agents/hooks.json']) {
    const r = edit({ TargetFile: t });
    assert.equal(r.decision, 'deny', t);
    assert.match(r.reason ?? '', /not allowed|outside|fence/); // .agents/hooks.json: core's fence (#4652) says it first
  }
});

// #4652: core's fence (editFence) runs on agy's edit targets too, as on Codex apply_patch and OpenCode write. Before, only
// the shim's own segments were denied, so a repo's Claude settings, opencode.json or .codex config were writable.
// #4663 (PR 109 review M1): agy has no patch tool, so a patch header in an edit's content is text, never a target
test('edit fence (#4663 M1): an apply_patch example in the content of an ordinary file is not a target', () => {
  assert.deepEqual(edit({ TargetFile: 'test/x.test.ts', CodeContent: '*** Begin Patch\n*** Add File: .codex/hooks.json\n+{}\n*** End Patch\n' }, undefined, 'write_to_file'), { decision: 'allow' });
  assert.deepEqual(edit({ TargetFile: 'docs/x.md', ReplacementContent: '*** Update File: .claude/settings.json\n' }, undefined, 'replace_file_content'), { decision: 'allow' });
  assert.deepEqual(edit({ TargetFile: 'docs/y.md', Content: { path: '.claude/settings.json' } }), { decision: 'allow' }, 'a path key inside content is text too');
  assert.equal(edit({ TargetFile: '.claude/settings.json', CodeContent: 'x' }, undefined, 'write_to_file').decision, 'deny', 'the target itself still counts');
});

// PR 110 review S1: agy is a Go binary; Go's JSON decoding matches keys in any case, the last one winning. So a second
// top-level path key in another case is a target too, for the fence (core) and for agy's own .git rule
test('edit fence (PR 110 S1): a top-level path key in any case is a target', () => {
  for (const args of [{ TargetFile: 'src/a.ts', targetFile: '.claude/settings.json' }, { TargetFile: 'src/a.ts', TARGETFILE: '.claude/settings.json' },
    { TargetFile: 'src/a.ts', move_path: '.claude/settings.json' }, { TargetFile: 'src/a.ts', targetfile: '.git/config' }, { TARGETFILE: '.git/config' }])
    assert.equal(edit(args, undefined, 'write_to_file').decision, 'deny', JSON.stringify(args));
});

test('edit fence (#4652): the repo-level fence paths are denied for every edit tool and path form; ordinary .claude work passes', () => {
  for (const t of ['.claude/settings.json', '.claude/settings.local.json', 'opencode.json', '.codex/hooks.json', '.codex/config.toml',
    '.opencode/plugins/x.js', join(ws, '.claude', 'settings.json'), 'src/../.claude/settings.json', '.CLAUDE/Settings.json', '.claude./settings.json']) {
    for (const name of EDIT_TOOLS) {
      const r = edit({ TargetFile: t }, undefined, name);
      assert.equal(r.decision, 'deny', `${name} ${t}`);
      assert.match(r.reason ?? '', /fence/, `${name} ${t}`);
    }
  }
  for (const k of PATH_ARGS) assert.equal(edit({ [k]: '.claude/settings.json' }).decision, 'deny', k);
  // a repo's own .claude skills and agents are ordinary work, as in the shell fence
  assert.deepEqual(edit({ TargetFile: '.claude/skills/a.md' }), { decision: 'allow' });
  assert.deepEqual(edit({ TargetFile: '.claude/agents/foo.md' }), { decision: 'allow' });
});

test('edit confinement: a missing, non-string or empty path denies; so does an unlisted arg name or a missing cwd', () => {
  for (const args of [{}, { TargetFile: 5 }, { TargetFile: '' }, { TargetFile: '   ' }, { TargetFile: ['a'] }, { TargetFile: null }, { File: 'a.ts' }, { target: 'a.ts' }, [], 'x']) {
    const r = edit(args);
    assert.equal(r.decision, 'deny', JSON.stringify(args));
    assert.match(r.reason ?? '', /target path/);
  }
  assert.equal(edit({ TargetFile: join(ws, 'a.ts'), path: 5 }).decision, 'deny'); // every given path arg must pass
  assert.equal(edit({ TargetFile: join(ws, 'a.ts'), path: join(outside, 'x') }).decision, 'deny');
  assert.match(edit({ TargetFile: 'a.ts' }, {}).reason ?? '', /names no cwd or workspace/);
  assert.equal(edit({ TargetFile: join(ws, 'a.ts') }, { cwd: 5, workspacePaths: 'x' }).decision, 'deny');
});

test('edit confinement: a symlink inside the workspace that leads out is denied', (t) => {
  try { symlinkSync(outside, join(ws, 'link'), 'junction'); } catch { t.skip('no symlink right on this machine'); return; }
  const r = edit({ TargetFile: 'link/x.txt' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason ?? '', /outside the workspace/);
});

const read = (args: unknown, extra: Record<string, unknown> = { cwd: ws, workspacePaths: [ws] }, name = 'read_file', role = 'reviewer') => runAgyShim(tool(name, args, extra), seat({ CB_ROLE: role }));

test('read confinement: inside the workspace is allowed (.git too), outside is denied, for every read tool and path arg', () => {
  for (const name of READ_TOOLS) for (const k of PATH_ARGS) {
    assert.deepEqual(read({ [k]: join(ws, 'src', 'a.ts') }, undefined, name), { decision: 'allow' }, `${name} ${k}`);
  }
  assert.deepEqual(read({ TargetFile: 'src/a.ts' }), { decision: 'allow' });
  assert.deepEqual(read({ TargetFile: '.git/config' }), { decision: 'allow' }); // reading .git stays allowed
  assert.deepEqual(read({ TargetFile: join(ws, '.git', 'HEAD') }, undefined, 'view_file', 'builder'), { decision: 'allow' });
  for (const t of [join(outside, 'x'), '../x', '../../etc/passwd', join(ws + '-sibling', 'x'), ws]) {
    const r = read({ TargetFile: t });
    assert.equal(r.decision, 'deny', t);
    assert.match(r.reason ?? '', /reading outside the workspace/);
  }
});

test('read confinement: .gemini, .agents and kit/guard are denied like edits; a missing path or cwd denies', () => {
  for (const t of ['.gemini/config/hooks.json', '.agents/hooks.json', 'kit/guard/core.mjs', 'src/.agents/x', '.GEMINI/x']) {
    const r = read({ TargetFile: t });
    assert.equal(r.decision, 'deny', t);
    assert.match(r.reason ?? '', /reading inside .* is not allowed/);
  }
  for (const args of [{}, { TargetFile: 5 }, { TargetFile: '' }, { File: 'a' }, null, []]) {
    const r = read(args);
    assert.equal(r.decision, 'deny', JSON.stringify(args));
    assert.match(r.reason ?? '', /target path/);
  }
  assert.match(read({ TargetFile: 'a.ts' }, {}).reason ?? '', /names no cwd or workspace/);
});

test('read confinement: a symlink inside the workspace that points out is denied', (t) => {
  try { symlinkSync(outside, join(ws, 'rlink'), 'junction'); } catch { t.skip('no symlink right on this machine'); return; }
  const r = read({ TargetFile: 'rlink/secret.txt' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason ?? '', /reading outside the workspace/);
});

test('#4392: a secret file is never read or edited natively, by name or through a link; templates and look-alikes pass', (t) => {
  for (const f of ['.env', '.env.local', 'src/.env.production', join(ws, '.env'), 'id_rsa', 'certs/server.key', '.npmrc', 'deploy/.ENV']) {
    for (const name of [...READ_TOOLS, 'write_file', 'edit_file']) {
      const r = READ_TOOLS.includes(name) ? read({ TargetFile: f }, undefined, name, 'builder') : edit({ TargetFile: f }, undefined, name);
      assert.equal(r.decision, 'deny', `${name} ${f}`);
      assert.match(r.reason ?? '', /secret file/, `${name} ${f}`);
    }
  }
  assert.equal(read({ TargetFile: 'src/a.ts', path: '.env' }).decision, 'deny'); // every given path arg is judged
  for (const f of ['.env.example', '.env.d.ts', 'src/env.ts', 'docs/keys.md']) {
    assert.deepEqual(read({ TargetFile: f }), { decision: 'allow' }, f);
    assert.deepEqual(edit({ TargetFile: f }), { decision: 'allow' }, f);
  }
  writeFileSync(join(ws, '.env'), 'X=1\n');
  try { symlinkSync(join(ws, '.env'), join(ws, 'notes.txt'), 'file'); } catch { t.skip('no symlink right on this machine'); return; }
  assert.match(read({ TargetFile: 'notes.txt' }).reason ?? '', /secret file/);
  assert.match(edit({ TargetFile: 'notes.txt' }).reason ?? '', /secret file/);
});

test('deny segments fold case on every platform: .GIT and .Agents', () => {
  assert.equal(normSegment('.GIT', 'linux'), '.git');
  assert.equal(normSegment('.Agents', 'darwin'), '.agents');
  for (const t of ['.GIT/config', '.Agents/hooks.json', '.GeMiNi/x', 'KIT/Guard/core.mjs']) assert.equal(edit({ TargetFile: t }).decision, 'deny', t);
  for (const t of ['.Agents/hooks.json', '.GEMINI/x']) assert.equal(read({ TargetFile: t }).decision, 'deny', t);
});

test('deny segments on Windows: trailing dots and spaces, and NTFS streams, are stripped before comparing', () => {
  assert.equal(normSegment('.git.', 'win32'), '.git');
  assert.equal(normSegment('.GIT. . ', 'win32'), '.git');
  assert.equal(normSegment('.agents::$INDEX_ALLOCATION', 'win32'), '.agents');
  assert.equal(normSegment('file.txt:stream', 'win32'), 'file.txt');
  assert.equal(normSegment('.git.', 'linux'), '.git.'); // a real name on POSIX
  // the platform parameter reaches the path check on any host
  const input = { cwd: ws, workspacePaths: [ws] };
  assert.match(checkEditPath({ args: { TargetFile: '.git./config' } }, input, 'win32') ?? '', /not allowed/);
  assert.equal(checkEditPath({ args: { TargetFile: '.git./config' } }, input, 'linux'), null);
  assert.match(checkEditPath({ args: { TargetFile: '.agents:s/x' } }, input, 'win32') ?? '', /not allowed/);
  assert.equal(checkEditPath({ args: { TargetFile: 'src/file.txt:stream' } }, input, 'win32'), null);
  if (process.platform === 'win32') for (const t of ['.agents /x', '.gemini:stream\\x', '.GIT::$INDEX_ALLOCATION\\config']) assert.match(edit({ TargetFile: t }).reason ?? '', /not allowed/, t);
});

test('an unknown CB_ROLE denies, shell and edit alike', () => {
  assert.equal(runAgyShim(shell('ls'), seat({ CB_ROLE: 'wizard' })).decision, 'deny');
  assert.equal(runAgyShim(tool('write_file', { TargetFile: join(ws, 'a') }, { cwd: ws }), seat({ CB_ROLE: 'wizard' })).decision, 'deny');
});

test('a shim copied without core.mjs, or beside a broken one, still denies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-agy-'));
  try {
    mkdirSync(join(dir, 'alone')); copyFileSync(SHIM, join(dir, 'alone', 'shim-agy.mjs'));
    const alone = runHook(shell('ls'), seat(), join(dir, 'alone', 'shim-agy.mjs'));
    assert.equal(alone.decision, 'deny');
    assert.match(alone.reason ?? '', /^Blocked: guard failed to load core/);
    mkdirSync(join(dir, 'broken')); copyFileSync(SHIM, join(dir, 'broken', 'shim-agy.mjs'));
    writeFileSync(join(dir, 'broken', 'core.mjs'), 'export const x = ;\n');
    assert.match(runHook(shell('ls'), seat(), join(dir, 'broken', 'shim-agy.mjs')).reason ?? '', /^Blocked: guard failed to load core/);
    mkdirSync(join(dir, 'mixed')); copyFileSync(SHIM, join(dir, 'mixed', 'shim-agy.mjs'));
    const hosts = 'export const localHosts = () => [];\n'; // the shim asks core for these before evaluate (#4707)
    writeFileSync(join(dir, 'mixed', 'core.mjs'), hosts + 'export const evaluate = () => { throw new Error("boom"); };\n');
    const mixed = runHook(shell('ls'), seat(), join(dir, 'mixed', 'shim-agy.mjs'));
    assert.equal(mixed.decision, 'deny');
    assert.match(mixed.reason ?? '', /^Blocked: guard error \(boom\)/);
    writeFileSync(join(dir, 'mixed', 'core.mjs'), hosts + 'export const evaluate = () => undefined;\n'); // no verdict is not an allow
    const silent = runHook(shell('ls'), seat(), join(dir, 'mixed', 'shim-agy.mjs'));
    assert.equal(silent.decision, 'deny');
    assert.match(silent.reason ?? '', /gave no decision/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cleanup', () => { rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
