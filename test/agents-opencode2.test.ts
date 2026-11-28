// OpenCode 2.x seats (#4817 slice 2). Pure: no database.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { guardProven, opencode2VersionRefusal } from '../cli/agents/opencode2.ts';

// A 2.x build is started only when someone has seen that build call the guard's hook for a tool call: the marker the
// plugin writes shows the hook is in, not that OpenCode calls it
test('only an accepted OpenCode 2.x version is started', () => {
  assert.equal(opencode2VersionRefusal('opencode v2.2.0\n'), null);
  assert.equal(opencode2VersionRefusal('opencode v2.2.0\r\n'), null);
  for (const out of ['opencode v2.2.1', 'opencode v2.2.0-beta.1', 'opencode v2.2.00', 'opencode v12.2.0', 'opencode v2.3.0 (compatible with v2.2.0)', 'opencode v1.19.4', 'opencode v2.2.0\nopencode v2.3.0', '2.2.0', '']) {
    assert.match(opencode2VersionRefusal(out) ?? '', /accepted: 2\.2\.0/, JSON.stringify(out));
  }
});

test('the guard counts as proven only by a marker holding this launch\'s nonce', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-oc2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'marker.json');
  assert.equal(guardProven(marker, 'nonce-of-this-launch'), false, 'no file');
  for (const text of ['', 'nonce-of-this-launch', 'null', '[]', '{}', '{"nonce":"an-older-launch","at":1}', '{"nonce":null}']) {
    writeFileSync(marker, text);
    assert.equal(guardProven(marker, 'nonce-of-this-launch'), false, JSON.stringify(text));
  }
  writeFileSync(marker, JSON.stringify({ nonce: 'nonce-of-this-launch', at: 1 }));
  assert.equal(guardProven(marker, 'nonce-of-this-launch'), true);
  assert.equal(guardProven(marker, ''), false, 'an empty nonce proves nothing');
  writeFileSync(marker, JSON.stringify({ nonce: '', at: 1 }));
  assert.equal(guardProven(marker, ''), false);
});
