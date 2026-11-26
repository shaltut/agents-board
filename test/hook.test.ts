import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (env: Record<string, string> = {}) =>
  spawnSync('node', ['hooks/deny-ask.mjs'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } }),
    encoding: 'utf8', env: { ...process.env, CB_ALLOW_ASK: '', ...env },
  });

test('AskUserQuestion is denied with a cb ask pointer', () => {
  const r = run();
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /cb ask/);
});

test('CB_ALLOW_ASK=1 lets it through', () => {
  const r = run({ CB_ALLOW_ASK: '1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

// #4348: a seat whose guard is not wired (no hook entry, a bare node, a Bash-only matcher on Windows) hears it in one
// line at the start, and is told it is Ahmed's to fix (the fence, #4345). A static check: no probes at session start.
test('SessionStart: a herdr session hears one line when the guard hook is not wired, and nothing when it is', async () => {
  const { installGuard } = await import('../kit/guard/install.mjs');
  const home = mkdtempSync(join(tmpdir(), 'cb-ss-home-'));
  try {
    const start = (h: string) => {
      const r = spawnSync('node', ['hooks/session-start.mjs'], { input: '{"hook_event_name":"SessionStart"}', encoding: 'utf8',
        env: { ...process.env, HOME: h, USERPROFILE: h, HERDR_PANE_ID: 'w1:p3' } });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    };
    const bare = start(home);
    assert.match(bare, /^Claude Board: .*run `cb start`/);
    assert.match(bare, /\nGuard: cannot read .*settings\.json.*cb ask/s);
    assert.equal(bare.split('\n').length, 2);
    const target = join(home, '.claude-board', 'guard');
    assert.equal(installGuard('kit/guard', target).ok, true);
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), '{}');
    assert.match(start(home), /\nGuard: no PreToolUse hook runs .*shim-claude\.mjs.*cb ask/s);
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell',
      hooks: [{ type: 'command', command: `"${process.execPath}" "${join(target, 'shim-claude.mjs')}"` }] }] } }));
    assert.doesNotMatch(start(home), /Guard:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('SessionStart hint: a herdr session is told to run cb start; others hear nothing', () => {
  const hint = (env: Record<string, string>) =>
    spawnSync('node', ['hooks/session-start.mjs'], { input: '{"hook_event_name":"SessionStart"}', encoding: 'utf8', env: { ...process.env, ...env } });
  const r = hint({ HERDR_PANE_ID: 'w1:p3' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  assert.match(out.additionalContext, /^Claude Board: .*run `cb start`/);
  assert.equal(hint({ HERDR_PANE_ID: '' }).stdout, '');
});
