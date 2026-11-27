// #4607 (from #4576): cb doctor checks that each installed agent CLI still lists the flags its adapter launches with.
// Codex 0.160 dropped --full-auto and a seat exited at start with only a herdr timeout. Pure: a fake probe, no CLI runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpLists, launchFlags, agentFlagsReport, type AgentProbe } from '../cli/agent-flags.ts';
import { doctor } from '../cli/doctor.ts';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

test('helpLists: a flag counts only as a whole word in the help text, in the usual spellings', () => {
  const help = `Usage: x [OPTIONS]\n  -m, --model <MODEL>   the model\n      --settings=<file>\n  [--auto]\n  -s|--sandbox <MODE>\n  --modelx  other\n`;
  for (const f of ['-m', '--model', '--settings', '--auto', '-s', '--sandbox']) assert.ok(helpLists(help, f), f);
  // a prefix of a listed flag is not listed: --mode is not --model, -a is not --auto
  for (const f of ['--mode', '-a', '--sett', '--full-auto']) assert.ok(!helpLists(help, f), f);
});

test('launchFlags: the flags each adapter passes, from builder and read-only launches, never their values', () => {
  const codex = launchFlags('codex', ROOT, ROOT);
  for (const f of ['--no-daemon', '-m', '-a', '--dangerously-bypass-hook-trust', '-s', '-c']) assert.ok(codex.flags.includes(f), `codex ${f}`);
  assert.ok(!codex.flags.some((f) => !f.startsWith('-')), 'values are not flags');
  assert.deepEqual(new Set(launchFlags('claude', ROOT, ROOT).flags), new Set(['--model', '--permission-mode', '--settings', '--strict-mcp-config', '--mcp-config']));
  for (const f of ['--hostname', '--port', '-m', '--auto']) assert.ok(launchFlags('opencode', ROOT, ROOT).flags.includes(f), `opencode ${f}`);
  for (const f of ['--dangerously-skip-permissions', '--settings', '--model']) assert.ok(launchFlags('agy', ROOT, ROOT).flags.includes(f), `agy ${f}`);
});

const probe = (table: Partial<Record<string, ReturnType<AgentProbe> | null>>): AgentProbe => (kind) => table[kind] ?? { path: null };

test('the report: a CLI that no longer lists a launch flag fails, naming the flag and the adapter; one not installed is skipped', () => {
  const r = agentFlagsReport({ root: ROOT, probe: probe({
    claude: { path: '/bin/claude', version: '2.1.0 (Claude Code)', help: '--model --permission-mode --settings --strict-mcp-config --mcp-config' },
    codex: { path: '/bin/codex', version: 'codex-cli 0.160.0', help: '-m, --model\n-a, --ask-for-approval\n-s, --sandbox\n-c, --config\n--dangerously-bypass-hook-trust\n--disable' },
  }) });
  assert.equal(r.ok, false);
  assert.equal(r.problems, 1);
  assert.ok(r.lines.some((l) => /^agents: claude 2\.1\.0 \(Claude Code\) lists all 5 launch flags$/.test(l)), r.lines.join('\n'));
  const codex = r.lines.find((l) => l.startsWith('agents: codex'))!;
  assert.match(codex, /codex-cli 0\.160\.0: --help does not list --no-daemon/);
  assert.match(codex, /cli\/agents\/codex\.ts/);
  assert.ok(r.lines.some((l) => l === 'agents: opencode not installed here, skipped'));
  assert.ok(r.lines.some((l) => l === 'agents: agy not installed here, skipped'));
  assert.deepEqual(r.json.codex.missing, ['--no-daemon']);
});

test('the report: help that cannot be read is said, not counted; nothing installed is a pass', () => {
  const r = agentFlagsReport({ root: ROOT, probe: probe({ agy: { path: '/bin/agy', error: 'timed out after 15 s' } }) });
  assert.equal(r.ok, true);
  assert.equal(r.problems, 0);
  assert.ok(r.lines.some((l) => /^agents: agy: launch flags not checked: timed out after 15 s$/.test(l)), r.lines.join('\n'));
  const none = agentFlagsReport({ root: ROOT, probe: probe({}) });
  assert.equal(none.ok, true);
  assert.equal(none.lines.length, 4);
});

test('cb doctor: the agent check runs only when given a probe, and a missing flag counts as a failed check', () => {
  const base = { root: ROOT, manifest: null, guardTarget: '/nonexistent/guard', settingsFile: null, probes: false };
  const without = doctor(base);
  assert.ok(!without.lines.some((l) => l.startsWith('agents:')), 'no probe, no agent lines: the existing callers spawn nothing');
  const bad = probe({ claude: { path: '/bin/claude', version: '2.1.0', help: '--model --settings' } });
  const withBad = doctor({ ...base, agentProbe: bad });
  assert.ok(withBad.lines.some((l) => /agents: claude 2\.1\.0: --help does not list --permission-mode, --strict-mcp-config, --mcp-config/.test(l)), withBad.lines.join('\n'));
  assert.equal(withBad.json.problems, without.json.problems + 1);
  assert.deepEqual(withBad.json.agents.claude.missing, ['--permission-mode', '--strict-mcp-config', '--mcp-config']);
});
