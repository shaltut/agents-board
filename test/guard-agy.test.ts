// The agy guard shim (#4002 phase 5): hook input in, agy's allow/deny JSON out, failing closed. Pure: no DB, no agy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgyInput, runAgyShim } from '../kit/guard/shim-agy.mjs';

const SHIM = fileURLToPath(new URL('../kit/guard/shim-agy.mjs', import.meta.url));
const CB_ENV = ['CB_ROLE', 'CB_AGENT', 'CB_PROTECTED_BRANCHES', 'CB_ALLOW_ASK'];
function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (CB_ENV.includes(k.toUpperCase())) delete env[k];
  return { ...env, ...extra };
}
type Out = { decision?: string; reason?: string };
/** One real hook run: exit 0 and JSON on stdout. An empty or unparsable stdout fails the test (agy would deny it). */
function runHook(input: string, env: Record<string, string> = {}, file = SHIM): Out & { stdout: string } {
  const r = spawnSync(process.execPath, [file], { input, encoding: 'utf8', env: cleanEnv(env) });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return { ...JSON.parse(r.stdout), stdout: r.stdout };
}
const shell = (CommandLine: unknown) => JSON.stringify({ toolCall: { id: 't1', name: 'run_command', args: { CommandLine } }, stepIdx: 3, hookEventName: 'PreToolUse' });
const tool = (name: unknown, args: unknown = { File: 'a.ts' }) => JSON.stringify({ toolCall: { name, args } });

test('allow prints exactly {"decision":"allow"} (agy counts {} as a deny)', () => {
  const r = runHook(shell('ls -la'));
  assert.equal(r.stdout, '{"decision":"allow"}');
  assert.deepEqual(runAgyShim(shell('git status'), {}), { decision: 'allow' });
});

test('a dangerous command is denied with the guard reason, in agy\'s deny format', () => {
  const r = runHook(shell('git reset --hard'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason ?? '', /^Blocked dangerous command: /);
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)).sort(), ['decision', 'reason']);
});

test('a role block: a builder cannot push to main or merge a PR', () => {
  for (const c of ['git push origin main', 'gh pr merge 1']) {
    const r = runHook(shell(c), { CB_ROLE: 'builder' });
    assert.equal(r.decision, 'deny', c);
    assert.match(r.reason ?? '', /^Blocked by role \(builder\): /);
  }
  assert.equal(runHook(shell('git push origin feat/x'), { CB_ROLE: 'builder' }).decision, 'allow');
});

test('CB_PROTECTED_BRANCHES is read from the env', () => {
  assert.equal(runHook(shell('git push origin release/1'), { CB_PROTECTED_BRANCHES: 'release/*' }).decision, 'deny');
  assert.equal(runHook(shell('git push origin release/1'), {}).decision, 'allow');
});

test('edit tools: read-only roles are denied, a builder is allowed', () => {
  for (const name of ['write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content']) {
    for (const role of ['reviewer', 'qa', 'investigator']) {
      const r = runAgyShim(tool(name), { CB_ROLE: role });
      assert.equal(r.decision, 'deny', `${name} ${role}`);
      assert.match(r.reason ?? '', /^Blocked by role \(/);
    }
    assert.deepEqual(runAgyShim(tool(name), { CB_ROLE: 'builder' }), { decision: 'allow' });
  }
});

test('ask_question is denied unless CB_ALLOW_ASK=1', () => {
  assert.equal(runAgyShim(tool('ask_question'), {}).decision, 'deny');
  assert.deepEqual(runAgyShim(tool('ask_question'), { CB_ALLOW_ASK: '1' }), { decision: 'allow' });
});

test('fails closed on malformed input: empty, bad JSON, wrong shapes, missing pieces', () => {
  for (const raw of ['', '   ', 'not json', 'null', '[]', '"x"', '{}', '{"toolCall":null}', '{"toolCall":[]}',
    JSON.stringify({ toolCall: { args: { CommandLine: 'ls' } } }), JSON.stringify({ toolCall: { name: '', args: {} } }),
    JSON.stringify({ toolCall: { name: 5, args: {} } }),
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), // Claude's shape is not agy's
    shell(undefined), shell(5), JSON.stringify({ toolCall: { name: 'run_command' } }), JSON.stringify({ toolCall: { name: 'run_command', args: [] } })]) {
    const r = runAgyShim(raw, {});
    assert.equal(r.decision, 'deny', JSON.stringify(raw));
    assert.match(r.reason ?? '', /^Blocked: guard could not read hook input/);
  }
  assert.deepEqual(runHook('not json'), { decision: 'deny', reason: runHook('not json').reason, stdout: runHook('not json').stdout });
  assert.equal(parseAgyInput(undefined as any).ok, false);
});

test('fails closed on an unknown tool (reads included: the matcher decides what reaches the shim)', () => {
  for (const name of ['view_file', 'read_file', 'send_command_input', 'invoke_subagent', 'Bash', 'run_command ', 'RUN_COMMAND']) {
    const r = runAgyShim(tool(name), {});
    assert.equal(r.decision, 'deny', name);
    assert.match(r.reason ?? '', /^Blocked: unrecognized tool /);
  }
});

test('an unknown CB_ROLE denies, shell and edit alike', () => {
  assert.equal(runAgyShim(shell('ls'), { CB_ROLE: 'wizard' }).decision, 'deny');
  assert.equal(runAgyShim(tool('write_file'), { CB_ROLE: 'wizard' }).decision, 'deny');
});

test('a shim copied without core.mjs, or beside a broken one, still denies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-agy-'));
  try {
    mkdirSync(join(dir, 'alone')); copyFileSync(SHIM, join(dir, 'alone', 'shim-agy.mjs'));
    const alone = runHook(shell('ls'), {}, join(dir, 'alone', 'shim-agy.mjs'));
    assert.equal(alone.decision, 'deny');
    assert.match(alone.reason ?? '', /^Blocked: guard failed to load core/);
    mkdirSync(join(dir, 'broken')); copyFileSync(SHIM, join(dir, 'broken', 'shim-agy.mjs'));
    writeFileSync(join(dir, 'broken', 'core.mjs'), 'export const x = ;\n');
    assert.match(runHook(shell('ls'), {}, join(dir, 'broken', 'shim-agy.mjs')).reason ?? '', /^Blocked: guard failed to load core/);
    mkdirSync(join(dir, 'mixed')); copyFileSync(SHIM, join(dir, 'mixed', 'shim-agy.mjs'));
    writeFileSync(join(dir, 'mixed', 'core.mjs'), 'export const evaluate = () => { throw new Error("boom"); };\n');
    const mixed = runHook(shell('ls'), {}, join(dir, 'mixed', 'shim-agy.mjs'));
    assert.equal(mixed.decision, 'deny');
    assert.match(mixed.reason ?? '', /^Blocked: guard error \(boom\)/);
    writeFileSync(join(dir, 'mixed', 'core.mjs'), 'export const evaluate = () => undefined;\n'); // no verdict is not an allow
    assert.equal(runHook(shell('ls'), {}, join(dir, 'mixed', 'shim-agy.mjs')).decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
