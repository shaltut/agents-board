// #4002 install gates for the non-Claude guard shims: the fence and the secret rule reach their native edit and read
// tools (not only shell commands), the fence covers each adapter's own hook and config files, and a seat with CB_AGENT
// but no CB_ROLE never skips the role rules. Pure: real shim processes, no DB, no agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editFence, editTargets, evaluate, secretPath } from '../kit/guard/core.mjs';
import { ADAPTERS } from '../cli/agents/index.ts';

const GUARD = fileURLToPath(new URL('../kit/guard/', import.meta.url));
const CB_ENV = ['CB_ROLE', 'CB_AGENT', 'CB_PROTECTED_BRANCHES', 'CB_ALLOW_ASK'];
function hook(shim: string, input: unknown, env: Record<string, string>) {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(base)) if (CB_ENV.includes(k.toUpperCase())) delete base[k];
  const r = spawnSync(process.execPath, [join(GUARD, shim)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...base, ...env } });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
// each shim's answer as allow (true) or the deny reason
const codex = (tool_name: string, tool_input: unknown, env: Record<string, string>, extra: Record<string, unknown> = {}) => {
  const o = hook('shim-codex.mjs', { hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra }, env);
  return o.hookSpecificOutput ? (o.hookSpecificOutput.permissionDecisionReason as string) : true;
};
const opencode = (tool: string, args: unknown, env: Record<string, string>) => {
  const o = hook('shim-opencode.mjs', { tool, args, sessionID: 's' }, env);
  return o.decision === 'block' ? (o.reason as string) : true;
};
const agy = (name: string, args: unknown, env: Record<string, string>, cwd: string) => {
  const o = hook('shim-agy.mjs', { toolCall: { name, args }, cwd, workspacePaths: [cwd] }, env);
  return o.decision === 'allow' ? true : (o.reason as string);
};
const CODEX = { CB_AGENT: 'codex', CB_ROLE: 'builder' }, OPENCODE = { CB_AGENT: 'opencode', CB_ROLE: 'builder' }, AGY = { CB_AGENT: 'agy', CB_ROLE: 'builder' };
const patch = (...files: string[]) => `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n-a\n+b`).join('\n')}\n*** End Patch`;

// Every agent's own guard and config files, as the adapters name them, plus the Claude fence and a secret file.
const FENCED = ['~/.codex/hooks.json', 'C:\\Users\\someone\\.codex\\config.toml', '/home/someone/.codex/review.config.toml',
  '.agents/hooks.json', '/home/someone/.config/opencode/plugins/cb-guard.js', '/home/someone/.config/opencode/opencode.jsonc',
  'opencode.json', '~/.gemini/antigravity-cli/settings.json', '~/.gemini/config/hooks.json', '~/.claude/settings.json',
  '/home/someone/.claude-board/guard/core.mjs', '.env', '/tmp/cb-seat-0a1b2c3d4e5f.opencode.json'];
const ORDINARY = ['src/app.ts', 'docs/codex-notes.md', 'packages/opencode-client/index.ts', '.claude/skills/x/SKILL.md', '.agents/rules/style.md'];

test('Codex apply_patch, Edit and Write: a fence or secret target is denied, an ordinary one allowed, none denied', () => {
  for (const f of FENCED) {
    assert.match(String(codex('apply_patch', { command: patch('src/ok.ts', f) }, CODEX)), /fence|secret file/, `apply_patch ${f}`);
    assert.match(String(codex('apply_patch', { command: ['apply_patch', patch(f)] }, CODEX)), /fence|secret file/, `apply_patch argv ${f}`);
    assert.match(String(codex('Write', { file_path: f, content: 'x' }, CODEX)), /fence|secret file/, `Write ${f}`);
  }
  for (const f of ORDINARY) assert.equal(codex('apply_patch', { command: patch(f) }, CODEX), true, f);
  assert.equal(codex('Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }, CODEX), true);
  // a move into a fence path, and a relative name resolved against the hook's cwd
  assert.match(String(codex('apply_patch', { command: '*** Begin Patch\n*** Update File: a.json\n*** Move to: .codex/hooks.json\n*** End Patch' }, CODEX)), /fence/);
  assert.match(String(codex('apply_patch', { command: patch('hooks.json') }, CODEX, { cwd: '/home/someone/.codex' })), /fence/);
  // no target the guard can read: denied (it was an allow before)
  assert.match(String(codex('apply_patch', { command: '*** Begin Patch\n*** End Patch' }, CODEX)), /target path/);
  assert.match(String(codex('apply_patch', {}, CODEX)), /target path/);
});

test('OpenCode edit tools: a fence or secret target is blocked, an ordinary one allowed, none blocked', () => {
  for (const f of FENCED) {
    for (const t of ['edit', 'write', 'multiedit']) assert.match(String(opencode(t, { filePath: f }, OPENCODE)), /fence|secret file/, `${t} ${f}`);
    assert.match(String(opencode('patch', { patchText: patch(f) }, OPENCODE)), /fence|secret file/, `patch ${f}`);
  }
  for (const f of ORDINARY) assert.equal(opencode('write', { filePath: f, content: 'x' }, OPENCODE), true, f);
  assert.match(String(opencode('edit', {}, OPENCODE)), /target path/);
});

test('OpenCode read tools: a secret file is blocked for a seat; other reads, the fence files included, pass', () => {
  for (const t of ['read', 'grep', 'glob', 'list']) {
    assert.match(String(opencode(t, { filePath: '.env', path: '.env' }, OPENCODE)), /secret file/, t);
    assert.equal(opencode(t, { filePath: 'src/app.ts', path: 'src' }, OPENCODE), true, t);
  }
  assert.match(String(opencode('read', { filePath: '/tmp/cb-seat-0a1b2c3d4e5f.opencode.json' }, OPENCODE)), /secret file/);
  assert.equal(opencode('read', { filePath: '/home/someone/.codex/hooks.json' }, OPENCODE), true);
  // a file glob: grep's include and glob's pattern; grep's pattern is the searched text, not a file
  assert.match(String(opencode('grep', { pattern: 'API', include: '**/.env' }, OPENCODE)), /secret file/);
  assert.match(String(opencode('glob', { pattern: '.env*' }, OPENCODE)), /secret file/);
  assert.equal(opencode('grep', { pattern: '.env', include: '*.ts' }, OPENCODE), true);
  assert.equal(opencode('glob', { pattern: 'src/**/*.ts' }, OPENCODE), true);
});

test('shell writes to another agent\'s hook or config file are fenced for every shim; reads pass', () => {
  for (const cmd of ['echo {} > ~/.codex/hooks.json', 'echo [features] > ~/.codex/config.toml', 'rm ~/.config/opencode/plugins/cb-guard.js',
    'cp x.json .agents/hooks.json', 'rm -rf ~/.gemini', 'cd ~/.codex && echo {} > hooks.json', 'sed -i s/a/b/ opencode.json']) {
    assert.match(String(codex('Bash', { command: cmd }, CODEX)), /fence/, `codex ${cmd}`);
    assert.match(String(opencode('bash', { command: cmd }, OPENCODE)), /fence/, `opencode ${cmd}`);
  }
  const ws = mkdtempSync(join(tmpdir(), 'cb-fence-agy-'));
  try {
    assert.match(String(agy('run_command', { CommandLine: 'echo {} > .agents/hooks.json' }, AGY, ws)), /fence/);
    assert.equal(agy('run_command', { CommandLine: 'cat .agents/hooks.json' }, AGY, ws), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
  for (const cmd of ['cat ~/.codex/config.toml', 'ls ~/.gemini', 'git log -- docs/opencode-notes.md']) assert.equal(codex('Bash', { command: cmd }, CODEX), true, cmd);
  // the seat's OpenCode password file is a secret for a shell read too
  assert.match(String(codex('Bash', { command: 'cat /tmp/cb-seat-0a1b2c3d4e5f.opencode.json' }, CODEX)), /secret file/);
});

test('the fence names every path the adapters install to or configure (a new adapter path is fenced or this fails)', () => {
  for (const [kind, a] of Object.entries(ADAPTERS)) {
    if (kind === 'claude') continue;
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      const g = a.guardInstallSpec('/home/someone/board', p);
      assert.ok(editFence(g.targetPath), `${kind} hook target ${g.targetPath} on ${p}`);
      const pre = a.trustSpec(['/home/someone/w'], p).preseedPath;
      if (pre) assert.ok(editFence(pre), `${kind} trust file ${pre}`);
    }
  }
  assert.ok(editFence('~/.config/opencode/opencode.jsonc')); // where OpenCode's question tool is turned off
  assert.ok(secretPath('cb-seat-0a1b2c3d4e5f.opencode.json'));
});

test('editTargets reads path keys and patch headers, recursively; evaluate blocks an edit it cannot see', () => {
  assert.deepEqual(editTargets({ command: ['apply_patch', patch('a.ts', 'b/c.ts')] }), ['a.ts', 'b/c.ts']);
  assert.deepEqual(editTargets({ filePath: 'x.ts', edits: [{ oldString: 'a' }] }), ['x.ts']);
  assert.deepEqual(editTargets({ content: 'no file here' }), []);
  assert.equal(evaluate({ tool: 'edit', role: 'builder', paths: [] }).allow, false);
  assert.equal(evaluate({ tool: 'edit', role: 'builder', paths: ['src/a.ts'] }).allow, true);
  // a Claude seat passes no paths: its edit rule is unchanged (kit/permissions denies the fence paths to Edit/Write)
  assert.equal(evaluate({ tool: 'edit', role: 'builder' }).allow, true);
  // no role (a hand-started session): only the base rules, as for shell commands
  assert.equal(evaluate({ tool: 'edit', role: null, paths: ['~/.codex/hooks.json'] }).allow, true);
});

test('a seat with CB_AGENT but no CB_ROLE is blocked by the Codex and OpenCode shims; a pane with neither keeps the base rules', () => {
  for (const tool of [['Bash', { command: 'ls' }], ['apply_patch', { command: patch('src/a.ts') }]] as const) {
    assert.match(String(codex(tool[0], tool[1], { CB_AGENT: 'codex' })), /CB_ROLE is not set/, tool[0]);
    assert.equal(codex(tool[0], tool[1], {}), true, `hand-started ${tool[0]}`);
  }
  assert.match(String(opencode('bash', { command: 'ls' }, { CB_AGENT: 'opencode' })), /CB_ROLE is not set/);
  assert.match(String(opencode('write', { filePath: 'src/a.ts' }, { CB_AGENT: 'opencode', CB_ROLE: ' ' })), /CB_ROLE is not set/);
  assert.equal(opencode('bash', { command: 'ls' }, {}), true);
  // the role rules then apply as for any seat
  assert.match(String(codex('Bash', { command: 'git push origin feat/x' }, { CB_AGENT: 'codex', CB_ROLE: 'reviewer' })), /^Blocked by role \(reviewer\)/);
});
