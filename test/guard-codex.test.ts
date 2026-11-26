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
  assert.equal(run(call('apply_patch', { command: '*** Begin Patch\n*** End Patch' }), { CB_ROLE: 'builder' }).stdout, '{}');
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
  for (const cmd of ['git commit -m x', 'git push origin feat/x']) {
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
  for (const t of ['apply_patch', 'Edit', 'Write']) assert.deepEqual(parseCodexInput(call(t, {})), { ok: true, tool: 'edit' });
  assert.deepEqual(parseCodexInput(call('request_user_input', {})), { ok: true, tool: 'ask' });
  assert.deepEqual(runCodexShim(bash('ls'), {}), {});
  assert.deepEqual(runCodexShim(bash('git reset --hard'), {}), denial('Blocked dangerous command: git reset --hard'));
  assert.deepEqual(runCodexShim(undefined as any, {}), denial('Blocked: guard could not read hook input (empty stdin)'));
});
