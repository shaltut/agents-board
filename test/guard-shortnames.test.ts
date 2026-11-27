// #4663 (PR 109 review I1): on Windows an 8.3 short name of an EXISTING fenced file (.claude\SETTIN~1.JSO) writes the real
// file. Node's JS realpathSync keeps short names; realpathSync.native expands them, so core judges that form too, for
// every agent's shim. Needs a volume with 8.3 names: skipped where the short name does not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { editPathForms, editTargets } from '../kit/guard/core.mjs';
import { runAgyShim } from '../kit/guard/shim-agy.mjs';
import { runCodexShim } from '../kit/guard/shim-codex.mjs';
import { runOpencodeShim } from '../kit/guard/shim-opencode.mjs';

const ws = realpathSync.native(mkdtempSync(join(tmpdir(), 'cb-short-')));
for (const [d, f] of [['.claude', 'settings.json'], ['.codex', 'config.toml'], ['', 'opencode.json']]) {
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

test('cleanup', () => { rmSync(ws, { recursive: true, force: true }); });

test('#4663 (PR 109 review M2): a rename destination key is an edit target', () => {
  assert.deepEqual(editTargets({ file_path: 'a.ts', new_path: 'b.ts' }).sort(), ['a.ts', 'b.ts']);
  assert.deepEqual(editTargets({ old_file_path: 'a.ts', new_file_path: 'c.ts' }), ['c.ts']);
});
