// #4765: every agent gets the same rules from one source. The repo's AGENTS.md is made from CLAUDE.md (the file that is
// edited), and the user-level file of Codex, agy and OpenCode gets a copy of ~/.claude/CLAUDE.md inside a marked block,
// beside whatever that file already says. Pure: temp folders only, never the real home.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, AGENT_KINDS } from '../cli/agents/index.ts';
import { agentsMdFrom, syncUserRules } from '../cli/agent-context.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'cli', 'agent-context.ts');
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const read = (p: string) => readFileSync(p, 'utf8');
const RULES = '# My rules\n\nKeep it small.\nCost: $1 and $& stay as typed.\n';
const HAND = '# Notes for this agent\n\n- a line written by hand\n';

/** A home with the source file and the config folders of the agents installed on it. */
function home(t: TestContext, folders = ['.codex', join('.config', 'opencode'), '.gemini'], rules: string | null = RULES) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of ['.claude', ...folders]) mkdirSync(join(dir, f), { recursive: true });
  if (rules !== null) writeFileSync(join(dir, '.claude', 'CLAUDE.md'), rules);
  const at = {
    source: join(dir, '.claude', 'CLAUDE.md'), codex: join(dir, '.codex', 'AGENTS.md'),
    opencode: join(dir, '.config', 'opencode', 'AGENTS.md'), agy: join(dir, '.gemini', 'AGENTS.md'),
  };
  return { dir, at };
}
const states = (r: { agent: string; state: string }[]) => Object.fromEntries(r.map((x) => [x.agent, x.state]));

test('AGENTS.md in this repo is the one made from CLAUDE.md', () => {
  assert.equal(lf(read(join(ROOT, 'AGENTS.md'))), agentsMdFrom(read(join(ROOT, 'CLAUDE.md'))),
    'AGENTS.md is not what CLAUDE.md makes. Edit CLAUDE.md only, then run: node cli/agent-context.ts repo');
});

test('agentsMdFrom: a note that says what to edit, then CLAUDE.md as it is, with unix line ends and no byte order mark', () => {
  const out = agentsMdFrom('﻿# T\r\n\r\ntext $& $1\r\n');
  assert.match(out.split('\n')[0]!, /^<!-- .*CLAUDE\.md.*node cli\/agent-context\.ts repo.*-->$/);
  assert.ok(out.endsWith('-->\n\n# T\n\ntext $& $1\n'), out);
});

test('every agent names its user-level rules file; Claude Code reads the source itself', () => {
  const h = join('x', 'home');
  const at = (k: (typeof AGENT_KINDS)[number], env: NodeJS.ProcessEnv = {}) => ADAPTERS[k].userRulesFile(h, env);
  assert.equal(at('claude'), null);
  assert.equal(at('codex'), join(h, '.codex', 'AGENTS.md'));
  assert.equal(at('codex', { CODEX_HOME: join('y', 'codex') }), join('y', 'codex', 'AGENTS.md'));
  assert.equal(at('opencode'), join(h, '.config', 'opencode', 'AGENTS.md'));
  assert.equal(at('opencode', { XDG_CONFIG_HOME: join('y', 'cfg') }), join('y', 'cfg', 'opencode', 'AGENTS.md'));
  assert.equal(at('agy'), join(h, '.gemini', 'AGENTS.md'));
});

test('user rules: written for each installed agent, hand-written lines kept, a second run changes nothing', (t) => {
  const w = home(t);
  writeFileSync(w.at.opencode, HAND);
  const first = syncUserRules({ home: w.dir, env: {} });
  assert.deepEqual(states(first), { codex: 'written', opencode: 'written', agy: 'written' });
  for (const f of [w.at.codex, w.at.opencode, w.at.agy]) assert.ok(read(f).includes(RULES), f);
  assert.ok(read(w.at.opencode).startsWith(HAND), 'the hand-written lines stay first');
  const before = [w.at.codex, w.at.opencode, w.at.agy].map(read);
  assert.deepEqual(states(syncUserRules({ home: w.dir, env: {} })), { codex: 'same', opencode: 'same', agy: 'same' });
  assert.deepEqual([w.at.codex, w.at.opencode, w.at.agy].map(read), before);
});

test('user rules: a changed source replaces the block only; lines before and after it stay', (t) => {
  const w = home(t, ['.codex']);
  writeFileSync(w.at.codex, HAND);
  syncUserRules({ home: w.dir, env: {} });
  writeFileSync(w.at.codex, `${read(w.at.codex)}\n- added below the block\n`);
  writeFileSync(w.at.source, '# My rules\n\nA new line.\n');
  assert.equal(states(syncUserRules({ home: w.dir, env: {} })).codex, 'written');
  const now = read(w.at.codex);
  assert.ok(now.startsWith(HAND) && now.endsWith('\n- added below the block\n') && now.includes('A new line.'), now);
  assert.ok(!now.includes('Keep it small.'), 'the old copy is gone');
  assert.equal(now.split('cb:user-rules begin').length, 2, 'one block');
});

test('user rules: a file saved with Windows line ends keeps them and still reads as the same', (t) => {
  const w = home(t, ['.codex']);
  writeFileSync(w.at.codex, HAND.replace(/\n/g, '\r\n'));
  syncUserRules({ home: w.dir, env: {} });
  const now = read(w.at.codex);
  assert.ok(!/(?<!\r)\n/.test(now), 'no bare newline was mixed in');
  assert.equal(states(syncUserRules({ home: w.dir, env: {} })).codex, 'same');
});

test('user rules: check writes nothing and says what differs; an agent with no config folder is skipped', (t) => {
  const w = home(t, ['.codex']);
  assert.deepEqual(states(syncUserRules({ home: w.dir, env: {}, check: true })), { codex: 'differs', opencode: 'skipped', agy: 'skipped' });
  assert.ok(!existsSync(w.at.codex));
  syncUserRules({ home: w.dir, env: {} });
  assert.ok(!existsSync(join(w.dir, '.gemini')) && !existsSync(join(w.dir, '.config')), 'no folder is made for an agent that is not there');
  assert.equal(states(syncUserRules({ home: w.dir, env: {}, check: true })).codex, 'same');
  writeFileSync(w.at.source, 'changed\n');
  assert.equal(states(syncUserRules({ home: w.dir, env: {}, check: true })).codex, 'differs');
});

test('user rules: only the agents asked for; Claude and unknown names are refused by name', (t) => {
  const w = home(t);
  assert.deepEqual(states(syncUserRules({ home: w.dir, env: {}, agents: ['codex'] })), { codex: 'written' });
  assert.ok(!existsSync(w.at.agy) && !existsSync(w.at.opencode));
  assert.throws(() => syncUserRules({ home: w.dir, env: {}, agents: ['claude'] }), /claude.*source/i);
  assert.throws(() => syncUserRules({ home: w.dir, env: {}, agents: ['codex', 'copilot'] }), /unknown agent "copilot"/);
});

test('user rules: a half or doubled block stops everything before anything is written', (t) => {
  for (const broken of ['<!-- cb:user-rules begin -->\nno end\n', 'stray\n<!-- cb:user-rules end -->\n',
    '<!-- cb:user-rules begin -->\n<!-- cb:user-rules end -->\n<!-- cb:user-rules begin -->\n<!-- cb:user-rules end -->\n']) {
    const w = home(t);
    writeFileSync(w.at.agy, broken); // the last agent: the ones before it must not be written either
    assert.throws(() => syncUserRules({ home: w.dir, env: {} }), /block.*nothing was changed/s, broken);
    assert.ok(!existsSync(w.at.codex) && !existsSync(w.at.opencode));
    assert.equal(read(w.at.agy), broken);
  }
});

test('user rules: no source, an empty one, or one holding the block markers writes nothing', (t) => {
  for (const [rules, why] of [[null, /CLAUDE\.md/], ['  \n', /empty/], ['x\n<!-- cb:user-rules end -->\n', /marker/]] as const) {
    const w = home(t, ['.codex'], rules);
    assert.throws(() => syncUserRules({ home: w.dir, env: {} }), why);
    assert.ok(!existsSync(w.at.codex));
  }
});

test('user rules: a file that is a link to the source is left alone, so the source never gets a copy of itself', (t) => {
  const w = home(t, ['.codex']);
  try { symlinkSync(w.at.source, w.at.codex, 'file'); } catch { return t.skip('this machine does not allow file links'); }
  assert.equal(states(syncUserRules({ home: w.dir, env: {} })).codex, 'linked');
  assert.equal(read(w.at.source), RULES);
});

test('user rules: a squad seat may check but not write: these are the owner\'s files', (t) => {
  const w = home(t, ['.codex']), seat: NodeJS.ProcessEnv = { ['CB_' + 'ROLE']: 'builder' };
  assert.throws(() => syncUserRules({ home: w.dir, env: seat }), /squad seat.*own terminal/s);
  assert.ok(!existsSync(w.at.codex));
  assert.equal(states(syncUserRules({ home: w.dir, env: seat, check: true })).codex, 'differs');
});

test('the script: repo --check passes here; an unknown word or flag is refused and nothing runs', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const ok = run('repo', '--check');
  assert.equal(ok.status, 0, ok.stderr);
  for (const args of [[], ['users'], ['user', '--dry-run'], ['repo', '--agents', 'codex'], ['repo', 'extra']]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /node cli\/agent-context\.ts (repo|user)/, args.join(' '));
  }
});
