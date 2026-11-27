// The OpenCode guard shim: tool mapping, the exact output format, and fail-closed behaviour. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOpencodeInput, runOpencodeShim } from '../kit/guard/shim-opencode.mjs';

const SHIM = fileURLToPath(new URL('../kit/guard/shim-opencode.mjs', import.meta.url));
const CB = ['CB_ROLE', 'CB_AGENT', 'CB_PROTECTED_BRANCHES', 'CB_ALLOW_ASK'];
function run(input: string, env: Record<string, string> = {}) {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(base)) if (CB.includes(k.toUpperCase())) delete base[k];
  const r = spawnSync(process.execPath, [SHIM], { input, encoding: 'utf8', env: { ...base, ...env } });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return { raw: r.stdout, out: JSON.parse(r.stdout) as { decision?: string; reason?: string } };
}
const bash = (command: string, env: Record<string, string> = {}, tool = 'bash') => run(JSON.stringify({ tool, args: { command }, sessionID: 's1' }), env);

test('allow prints exactly {}', () => {
  assert.equal(bash('ls -la').raw, '{}');
  assert.equal(bash('git status', { CB_ROLE: 'builder' }).raw, '{}');
  assert.equal(bash('Get-ChildItem', {}, 'powershell').raw, '{}');
});

test('block prints exactly {"decision":"block","reason":...} with the core reason', () => {
  const r = bash('git reset --hard');
  assert.equal(r.raw, JSON.stringify({ decision: 'block', reason: 'Blocked dangerous command: git reset --hard' }));
  assert.deepEqual(Object.keys(r.out), ['decision', 'reason']);
});

test('role block: a reviewer may not commit or edit; a builder may edit', () => {
  const c = bash('git commit -m x', { CB_ROLE: 'reviewer' });
  assert.equal(c.out.decision, 'block');
  assert.match(c.out.reason!, /^Blocked by role \(reviewer\): /);
  for (const tool of ['edit', 'write', 'patch', 'apply_patch', 'multiedit']) {
    assert.equal(run(JSON.stringify({ tool, args: {} }), { CB_ROLE: 'qa' }).out.decision, 'block', tool);
    assert.equal(run(JSON.stringify({ tool, args: { filePath: 'src/a.ts' } }), { CB_ROLE: 'builder' }).raw, '{}', tool);
  }
});

test('protected branch push is blocked through CB_PROTECTED_BRANCHES', () => {
  assert.equal(bash('git push origin HEAD:development', { CB_ROLE: 'builder', CB_PROTECTED_BRANCHES: 'development' }).out.decision, 'block');
  assert.equal(bash('git push origin feat/x', { CB_ROLE: 'builder', CB_PROTECTED_BRANCHES: 'development' }).raw, '{}');
});

test('question maps to ask: blocked unless CB_ALLOW_ASK=1', () => {
  const q = JSON.stringify({ tool: 'question', args: { questions: [] } });
  assert.equal(run(q, { CB_ROLE: 'builder' }).out.decision, 'block');
  assert.equal(run(q, { CB_ROLE: 'builder', CB_ALLOW_ASK: '1' }).raw, '{}');
});

test('malformed input fails closed', () => {
  for (const input of ['', '   ', 'not json', 'null', '[]', '"bash"', '{}', '{"tool":"bash"}', '{"tool":"bash","args":{}}', '{"tool":"bash","args":{"command":5}}', '{"tool":"bash","args":[]}']) {
    const r = run(input);
    assert.equal(r.out.decision, 'block', JSON.stringify(input));
    assert.match(r.out.reason!, /^Blocked: guard could not read hook input|^Blocked: unrecognized tool/, JSON.stringify(input));
  }
});

test('in a seat, unknown tools, including web fetch, subagents and MCP names, are blocked', () => {
  for (const tool of ['webfetch', 'task', 'server_tool', '']) {
    const r = run(JSON.stringify({ tool, args: { command: 'ls' } }), { CB_ROLE: 'builder' });
    assert.equal(r.out.decision, 'block', tool);
    assert.match(r.out.reason!, /unrecognized tool/, tool);
  }
  assert.equal(run(JSON.stringify({ args: { command: 'ls' } })).out.decision, 'block');
  assert.equal(run(JSON.stringify({ tool: 7, args: {} })).out.decision, 'block');
});

test('outside a seat (the plugin is machine-wide) the owner\'s own OpenCode keeps its tools and questions; base rules still apply (PR 96 review I3)', () => {
  for (const tool of ['webfetch', 'websearch', 'task', 'todowrite', 'skill', 'lsp', 'server_tool', 'question']) {
    assert.equal(run(JSON.stringify({ tool, args: {} })).raw, '{}', tool);
    assert.equal(run(JSON.stringify({ tool, args: {} }), { CB_AGENT: 'opencode' }).out.decision, 'block', `${tool} in a seat launched without a role`);
  }
  assert.equal(run(JSON.stringify({ tool: 'bash', args: { command: 'git reset --hard' } })).out.decision, 'block');
  for (const input of [JSON.stringify({ tool: '', args: {} }), JSON.stringify({ args: {} }), JSON.stringify({ tool: 7, args: {} }), '{"tool":"bash","args":{}}']) {
    assert.equal(run(input).out.decision, 'block', input);
  }
});

test('unknown CB_ROLE fails closed', () => {
  const r = bash('ls', { CB_ROLE: 'Builder' });
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason!, /unknown CB_ROLE/);
});

test('parseOpencodeInput: tool names are case-insensitive; shapes', () => {
  assert.deepEqual(parseOpencodeInput('{"tool":"Bash","args":{"command":"ls"}}'), { ok: true, tool: 'shell', command: 'ls' });
  assert.deepEqual(parseOpencodeInput('{"tool":"edit","args":{}}'), { ok: true, tool: 'edit', args: {} });
  assert.deepEqual(parseOpencodeInput('{"tool":"question","args":{}}'), { ok: true, tool: 'ask' });
  assert.equal(parseOpencodeInput(undefined as any).ok, false);
});

test('runOpencodeShim in process matches the process output and never throws', () => {
  assert.deepEqual(runOpencodeShim('{"tool":"bash","args":{"command":"ls"}}', {}), {});
  assert.equal(runOpencodeShim(undefined as any, {}).decision, 'block');
  assert.equal(runOpencodeShim('{"tool":"bash","args":{"command":"ls"}}', null as any).decision, 'block');
});

test('a shim copied without core.mjs still blocks (core load failure fails closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-shim-'));
  try {
    const lone = join(dir, 'shim-opencode.mjs');
    copyFileSync(SHIM, lone);
    const r = spawnSync(process.execPath, [lone], { input: JSON.stringify({ tool: 'bash', args: { command: 'ls' } }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /^Blocked: guard failed to load core/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
