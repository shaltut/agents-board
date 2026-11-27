// #4663 (PR 109 review I1): on Windows an 8.3 short name of an EXISTING fenced file (.claude\SETTIN~1.JSO) writes the real
// file. Node's JS realpathSync keeps short names; realpathSync.native expands them, so core judges that form too, for
// every agent's shim. Needs a volume with 8.3 names: skipped where the short name does not exist.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { editFence, editPathForms, editTargets } from '../kit/guard/core.mjs';
import { runAgyShim } from '../kit/guard/shim-agy.mjs';
import { runCodexShim } from '../kit/guard/shim-codex.mjs';
import { runOpencodeShim } from '../kit/guard/shim-opencode.mjs';

const ws = realpathSync.native(mkdtempSync(join(tmpdir(), 'cb-short-')));
for (const [d, f] of [['.claude', 'settings.json'], ['.codex', 'config.toml'], ['', 'opencode.json'], ['.git', 'config'], ['.gemini', 'settings.json']]) {
  mkdirSync(join(ws, d), { recursive: true });
  writeFileSync(join(ws, d, f), '{}');
}
const shorts = [join(ws, '.claude', 'SETTIN~1.JSO'), join(ws, '.codex', 'CONFIG~1.TOM'), join(ws, 'OPENCO~1.JSO')];
const has83 = process.platform === 'win32' && shorts.every((s) => existsSync(s));
const env = { CB_ROLE: 'builder', CB_AGENT: 'x' };

test('editPathForms adds the native real path: a short name reads as its long name', { skip: !has83 && 'no 8.3 names here' }, () => {
  const forms = editPathForms(shorts[0]!, ws, { resolve, dirname, basename, join, realpathSync });
  assert.ok(forms.some((f) => f.toLowerCase().endsWith(join('.claude', 'settings.json').toLowerCase())), forms.join(' | '));
});

test('a short name of an existing fenced file is denied for agy, Codex and OpenCode', { skip: !has83 && 'no 8.3 names here' }, () => {
  for (const s of shorts) {
    const agy = runAgyShim(JSON.stringify({ toolCall: { name: 'write_to_file', args: { TargetFile: s } }, cwd: ws, workspacePaths: [ws] }), { ...env, CB_AGENT: 'agy' });
    assert.equal(agy.decision, 'deny', `agy ${s}`);
    const codex = runCodexShim(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: ws,
      tool_input: { command: `*** Begin Patch\n*** Update File: ${s}\n@@\n-x\n+y\n*** End Patch` } }), { ...env, CB_AGENT: 'codex' });
    assert.match(JSON.stringify(codex), /deny/, `codex ${s}`);
    const oc = runOpencodeShim(JSON.stringify({ tool: 'write', args: { filePath: s } }), { ...env, CB_AGENT: 'opencode' });
    assert.equal(oc.decision, 'block', `opencode ${s}`);
  }
});

after(() => rmSync(ws, { recursive: true, force: true }));

test('#4663 (PR 109 review M2, PR 110 M1): rename destination and source keys are edit targets', () => {
  assert.deepEqual(editTargets({ file_path: 'a.ts', new_path: 'b.ts' }).sort(), ['a.ts', 'b.ts']);
  assert.deepEqual(editTargets({ old_file_path: 'a.ts', new_file_path: 'c.ts' }).sort(), ['a.ts', 'c.ts']);
  assert.deepEqual(editTargets({ old_path: '.claude/settings.json', new_path: 'b.ts' }).sort(), ['.claude/settings.json', 'b.ts']);
});

// PR 110 review S2: agy's own .git and .gemini rule reads the native real path too: GIT~1/hooks/pre-commit runs at the next commit
test('agy: short folder names of .git and .gemini are denied', { skip: !(process.platform === 'win32' && existsSync(join(ws, 'GIT~1')) && existsSync(join(ws, 'GEMINI~1'))) && 'no 8.3 names here' }, () => {
  for (const t of ['GIT~1/config', 'GIT~1/hooks/pre-commit', 'GEMINI~1/settings.json', 'GEMINI~1/SETTIN~1.JSO']) {
    const r = runAgyShim(JSON.stringify({ toolCall: { name: 'write_to_file', args: { TargetFile: t } }, cwd: ws, workspacePaths: [ws] }), { ...env, CB_AGENT: 'agy' });
    assert.equal(r.decision, 'deny', t);
  }
});

// PR 110 review S3: when the native realpath fails but the JS one works, a short-name segment cannot be judged by its
// long name, so the edit is blocked rather than judged as written
test('editPathForms: native realpath fails on a short-name path: a form editFence blocks', () => {
  const realpathSync = Object.assign((p: string) => p, { native: () => { throw new Error('EIO'); } });
  const fake = { resolve, dirname, basename, join, realpathSync };
  const forms = editPathForms(join(ws, '.claude', 'SETTIN~1.JSO'), ws, fake);
  assert.ok(forms.some((f) => editFence(f)), forms.join(' | '));
  assert.ok(!editPathForms(join(ws, 'src', 'a.ts'), ws, fake).some((f) => editFence(f)), 'no short name: nothing extra');
});
