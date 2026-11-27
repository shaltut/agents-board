// The Codex PreToolUse shim (#4002 phase 2): allow, block, malformed input, unknown tool, role blocks, exact output format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deny, parseCodexInput, runCodexShim } from '../kit/guard/shim-codex.mjs';

const GUARD = fileURLToPath(new URL('../kit/guard/', import.meta.url));
const SHIM = join(GUARD, 'shim-codex.mjs');
const CB_ENV = ['CB_ROLE', 'CB_AGENT', 'CB_PROTECTED_BRANCHES', 'CB_ALLOW_ASK'];
function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (CB_ENV.includes(k.toUpperCase())) delete env[k];
  return { ...env, ...extra };
}
// One real hook run: exit 0, and stdout is the whole answer (an empty stdout would be an allow, so JSON.parse failing fails the test)
function run(input: string, env: Record<string, string> = {}, file = SHIM) {
  const r = spawnSync(process.execPath, [file], { input, encoding: 'utf8', env: cleanEnv(env) });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return { stdout: r.stdout, out: JSON.parse(r.stdout) };
}
const call = (tool_name: string, tool_input: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 's', turn_id: 't', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u', ...extra });
const bash = (command: string) => call('Bash', { command });
const denial = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

test('allow prints exactly {} (Codex rejects an explicit permissionDecision:allow)', () => {
  assert.equal(run(bash('ls -la')).stdout, '{}');
  assert.equal(run(bash('git push origin feat/x'), { CB_ROLE: 'builder' }).stdout, '{}');
  assert.equal(run(call('apply_patch', { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' }), { CB_ROLE: 'builder' }).stdout, '{}');
  assert.equal(run(call('apply_patch', {})).stdout, '{}'); // no role: only the base rules
});

test('a dangerous command blocks with the exact Codex deny object', () => {
  const r = run(bash('git reset --hard'));
  assert.deepEqual(r.out, denial('Blocked dangerous command: git reset --hard'));
  assert.deepEqual(Object.keys(r.out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(r.out.hookSpecificOutput), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
  assert.equal(deny('x').hookSpecificOutput.permissionDecisionReason, 'x');
});

test('PowerShell tool name reads as shell too; a protected-branch push blocks from CB_PROTECTED_BRANCHES', () => {
  assert.equal(run(call('PowerShell', { command: 'Remove-Item -Recurse -Force C:\\' })).out.hookSpecificOutput.permissionDecision, 'deny');
  const r = run(bash('git push origin develop'), { CB_PROTECTED_BRANCHES: 'develop,release' });
  assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /^Blocked dangerous command: /);
});

test('role blocks: a builder cannot push to main or merge; a reviewer cannot commit, push or patch', () => {
  const b = run(bash('git push origin main'), { CB_ROLE: 'builder' }).out.hookSpecificOutput;
  assert.equal(b.permissionDecision, 'deny');
  assert.match(b.permissionDecisionReason, /^Blocked (?:dangerous command|by role \(builder\)): /);
  assert.match(run(bash('gh pr merge 12'), { CB_ROLE: 'builder' }).out.hookSpecificOutput.permissionDecisionReason, /^Blocked by role \(builder\): /);
  // #4638: an alias, commit plumbing and a gh api merge are judged in the Codex seat the same way
  assert.match(run(bash('gh api -X PUT repos/o/r/pulls/5/merge'), { CB_ROLE: 'builder' }).out.hookSpecificOutput.permissionDecisionReason, /^Blocked by role \(builder\): /);
  assert.match(run(bash('S=push; git $S origin main'), { CB_ROLE: 'lead' }).out.hookSpecificOutput.permissionDecisionReason, /^Blocked by role \(lead\): /);
  for (const cmd of ['git commit -m x', 'git push origin feat/x', 'git -c alias.c=commit c -m x', 'git commit-tree HEAD^{tree} -m x',
    'git update-ref refs/heads/x HEAD', 'gh api -X PUT repos/o/r/pulls/5/merge',
    // #4661
    'git subtree push -P x origin feat/x', 'GIT_EXEC_PATH=/tmp/evil git status', 'gh merge 5']) {
    for (const role of ['reviewer', 'qa', 'investigator']) {
      assert.match(run(bash(cmd), { CB_ROLE: role }).out.hookSpecificOutput.permissionDecisionReason, new RegExp(`^Blocked by role \\(${role}\\): `), `${role} ${cmd}`);
    }
  }
  const edit = run(call('apply_patch', { command: '*** Begin Patch' }), { CB_ROLE: 'reviewer' }).out.hookSpecificOutput;
  assert.equal(edit.permissionDecision, 'deny');
  assert.match(edit.permissionDecisionReason, /^Blocked by role \(reviewer\): editing files/);
  assert.equal(run(bash('git log --oneline'), { CB_ROLE: 'reviewer' }).stdout, '{}');
});

test('request_user_input is denied unless CB_ALLOW_ASK=1, with the cb ask pointer', () => {
  const r = run(call('request_user_input', { questions: [] })).out.hookSpecificOutput;
  assert.equal(r.permissionDecision, 'deny');
  assert.match(r.permissionDecisionReason, /cb ask/);
  assert.equal(run(call('request_user_input', { questions: [] }), { CB_ALLOW_ASK: '1' }).stdout, '{}');
});

test('an unknown CB_ROLE blocks', () => {
  const r = run(bash('ls'), { CB_ROLE: 'wizard' }).out.hookSpecificOutput;
  assert.equal(r.permissionDecision, 'deny');
  assert.match(r.permissionDecisionReason, /unknown CB_ROLE/);
});

test('fail closed on unreadable input: every case is a deny object, exit 0', () => {
  for (const input of ['', '   ', 'not json', 'null', '[]', '5', '{}', '{"tool_name":"Bash"}', '{"tool_name":"Bash","tool_input":{}}',
    '{"tool_name":"Bash","tool_input":{"command":["ls"]}}', '{"tool_name":"Bash","tool_input":[]}', '{"tool_name":"Bash","tool_input":"ls"}']) {
    const r = run(input).out.hookSpecificOutput;
    assert.equal(r.permissionDecision, 'deny', JSON.stringify(input));
    assert.match(r.permissionDecisionReason, /^Blocked: guard could not read hook input/, JSON.stringify(input));
  }
});

test('unknown tools block, including a missing tool_name and an MCP tool; the Claude-style omitted tool_name is not accepted', () => {
  for (const input of [call('', { command: 'ls' }), call('mcp__postman__run', { command: 'ls' }), call('bash', { command: 'ls' }), call('UnknownTool', {}),
    JSON.stringify({ tool_input: { command: 'ls' } }), JSON.stringify({ tool_name: null, tool_input: { command: 'ls' } }), JSON.stringify({ tool_name: 5, tool_input: { command: 'ls' } })]) {
    const r = run(input).out.hookSpecificOutput;
    assert.equal(r.permissionDecision, 'deny', input);
    assert.match(r.permissionDecisionReason, /^Blocked: unrecognized tool/, input);
  }
});

test('a hook event other than PreToolUse blocks', () => {
  const r = run(call('Bash', { command: 'ls' }, { hook_event_name: 'PostToolUse' })).out.hookSpecificOutput;
  assert.match(r.permissionDecisionReason, /not PreToolUse/);
});

test('a shim copied without core.mjs still blocks (never fails open)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-codex-'));
  try {
    copyFileSync(SHIM, join(dir, 'shim-codex.mjs'));
    const r = run(bash('ls'), {}, join(dir, 'shim-codex.mjs')).out.hookSpecificOutput;
    assert.equal(r.permissionDecision, 'deny');
    assert.match(r.permissionDecisionReason, /^Blocked: guard failed to load core/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the parser: shell, edit and ask map to core tools; the in-process run matches the process', () => {
  assert.deepEqual(parseCodexInput(bash('ls')), { ok: true, tool: 'shell', command: 'ls' });
  for (const t of ['apply_patch', 'Edit', 'Write']) assert.deepEqual(parseCodexInput(call(t, {})), { ok: true, tool: 'edit', input: {}, cwd: null });
  assert.deepEqual(parseCodexInput(call('request_user_input', {})), { ok: true, tool: 'ask' });
  assert.deepEqual(runCodexShim(bash('ls'), {}), {});
  assert.deepEqual(runCodexShim(bash('git reset --hard'), {}), denial('Blocked dangerous command: git reset --hard'));
  assert.deepEqual(runCodexShim(undefined as any, {}), denial('Blocked: guard could not read hook input (empty stdin)'));
});

// #4618: the shapes Codex 0.160 really sends, read from its source at tag rust-v0.160.0 (codex-rs/core/src/tools):
// - exec_command, its only shell tool on every platform (PowerShell on Windows included), reaches the hook as
//   tool_name "Bash" with tool_input { command: <the raw command string> } (exec_command.rs pre_tool_use_payload,
//   HookToolName::bash()); there is no tool named unified_exec (that is the feature) and none named PowerShell
// - write_stdin sends no PreToolUse at all (write_stdin.rs: it continues a command that already ran PreToolUse as Bash)
// - apply_patch reaches it as tool_name "apply_patch" with tool_input { command: <the patch text> }
// - every other function tool reaches it under its own name with its JSON arguments (registry.rs default payload); the
//   catch-all matcher (#4609) sends them all here, and each is denied: pinned by name, so allowing one is a deliberate change
const real = (tool_name: string, tool_input: unknown) =>
  call(tool_name, tool_input, { cwd: 'C:/w/scratch', model: 'gpt-5', permission_mode: 'bypassPermissions', transcript_path: null });

test('Codex 0.160 exec_command, as the hook sees it (Bash + raw command): judged like a shell command, PowerShell forms too', () => {
  assert.equal(run(real('Bash', { command: 'git status' }), { CB_ROLE: 'builder' }).stdout, '{}');
  assert.equal(run(real('Bash', { command: 'Get-ChildItem -Force' }), { CB_ROLE: 'builder' }).stdout, '{}');
  for (const [command, env, why] of [
    ['git reset --hard', {}, /^Blocked dangerous command: /],
    ['Remove-Item -Recurse -Force C:\\', {}, /^Blocked dangerous command: /],
    ['git push origin main', { CB_ROLE: 'builder' }, /^Blocked by role \(builder\): /],
    ['git commit -m x', { CB_ROLE: 'reviewer' }, /^Blocked by role \(reviewer\): /],
    ['Get-Content .env', { CB_ROLE: 'builder' }, /^Blocked/],
    ['Set-Content -Path C:\\Users\\me\\.codex\\hooks.json -Value x', { CB_ROLE: 'builder' }, /^Blocked/],
  ] as const) {
    const out = run(real('Bash', { command }), env as Record<string, string>).out;
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, why, command);
  }
});

test('Codex 0.160 apply_patch, as the hook sees it ({ command: patch }): its file lines are the fence and secret targets', () => {
  const patch = (body: string) => real('apply_patch', { command: `*** Begin Patch\n${body}\n*** End Patch` });
  assert.equal(run(patch('*** Update File: src/a.ts\n@@\n-a\n+b'), { CB_ROLE: 'builder' }).stdout, '{}');
  for (const body of ['*** Add File: .env\n+X=1', '*** Update File: .codex/hooks.json\n@@\n-a\n+b', '*** Delete File: C:/Users/me/.claude-board/guard/core.mjs']) {
    assert.equal(run(patch(body), { CB_ROLE: 'builder' }).out.hookSpecificOutput?.permissionDecision, 'deny', body);
  }
});

test('Codex 0.160\'s other tools reach the catch-all hook under their own names: each is denied, by name (#4618)', () => {
  const OTHERS: [string, unknown][] = [
    ['update_plan', { plan: [{ step: 'x', status: 'pending' }] }], ['view_image', { path: 'a.png' }], ['spawn_agent', { message: 'x' }],
    ['send_input', { id: 'a', message: 'x' }], ['wait_agent', { ids: ['a'] }], ['close_agent', { id: 'a' }], ['request_permissions', {}],
    ['list_mcp_resources', {}], ['read_mcp_resource', { server: 's', uri: 'u' }], ['tool_search', { query: 'x' }],
    ['exec_command', { cmd: 'git reset --hard' }], ['write_stdin', { session_id: 1, chars: 'git push origin main\n' }], ['unified_exec', { cmd: 'ls' }],
  ];
  for (const [name, input] of OTHERS) {
    const out = run(real(name, input), { CB_ROLE: 'builder' }).out;
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', name);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Blocked: unrecognized tool/, name);
  }
});
