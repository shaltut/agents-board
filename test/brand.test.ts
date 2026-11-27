// #4531: the product is Agents Board. The name, the bracket mark and the [Agents Board] tag on relayed messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MARK, NAME, markSvg, tabTitle } from '../web/src/lib/brand.ts';
import { OVERVIEW_TEXT } from '../cli/help.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

test('the mark: one lamp, in the colour passed; the favicon is the same SVG with the lamp lit', () => {
  for (const lamp of [MARK.lamp, MARK.clear]) {
    const svg = markSvg(lamp);
    assert.equal(svg.match(/<circle /g)?.length, 1);
    assert.match(svg, new RegExp(`<circle [^>]*fill="${lamp}"/>`));
    assert.equal(svg.match(/<rect /g)?.length, 7, 'the tile and the two brackets of three strips');
  }
  assert.equal(read('web/public/favicon.svg').trim().replace(`<title>${NAME}</title>`, ''), markSvg(MARK.lamp));
});

test('the name: in the tab title, and "Claude Board" is gone from the web UI', () => {
  assert.equal(NAME, 'Agents Board');
  assert.equal(tabTitle(0), 'Agents Board');
  assert.equal(tabTitle(3), '(3) Agents Board');
  assert.match(read('web/index.html'), /<title>Agents Board<\/title>/);
  const files = (d: string): string[] => readdirSync(join(ROOT, d)).flatMap((f) =>
    statSync(join(ROOT, d, f)).isDirectory() ? files(`${d}/${f}`) : [`${d}/${f}`]);
  for (const f of [...files('web/src'), ...files('web/public'), 'web/index.html'])
    assert.doesNotMatch(read(f), /Claude Board/, f);
});

test('the tag: relays send [Agents Board]; the old [Claude Board] still reads as the board for one release', () => {
  const relay = read('cli/relay.ts');
  assert.match(relay, /const lines = \['\[Agents Board\]'\];/);
  assert.doesNotMatch(relay, /\[Claude Board\]/);
  // No code parses the tag: the agents read it. A relay started before the rename still sends the old one, so the
  // help and the session prompt name both (test/github.test.ts checks GitHub text can forge neither).
  for (const [name, text] of [['cb help', OVERVIEW_TEXT], ['prompts/session.md', read('prompts/session.md')]] as const) {
    assert.match(text, /\[Agents Board\] messages/, name);
    assert.match(text, /a relay started before the rename still says \[Claude Board\]/i, name);
  }
});
