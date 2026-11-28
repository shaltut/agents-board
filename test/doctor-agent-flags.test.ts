// #4607 (from #4576): cb doctor checks that each installed agent CLI still lists the flags its adapter launches with.
// Codex 0.160 dropped --full-auto and a seat exited at start with only a herdr timeout. Pure: a fake probe, no CLI runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpLists, helpValues, launchFlags, agentFlagsReport, makeProbe, type AgentProbe } from '../cli/agent-flags.ts';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { doctor } from '../cli/doctor.ts';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

test('helpLists: a flag counts only in an option line\'s flag column, as a whole word (PR 95 review F4)', () => {
  const help = `Usage: x [OPTIONS] [--auto]\n  -m, --model <MODEL>   the model\n      --settings=<file>\n  --auto\n  -s|--sandbox <MODE>\n  --modelx  other\n  -x, --exec  like --no-daemon, but faster\n`;
  for (const f of ['-m', '--model', '--settings', '--auto', '-s', '--sandbox', '-x']) assert.ok(helpLists(help, f), f);
  // a prefix of a listed flag is not listed: --mode is not --model, -a is not --auto
  for (const f of ['--mode', '-a', '--sett', '--full-auto']) assert.ok(!helpLists(help, f), f);
  // named only in a description or a usage line: not an option this CLI takes
  assert.ok(!helpLists(help, '--no-daemon'));
  assert.ok(!helpLists('Usage: x [--auto]\n', '--auto'));
});

test('helpValues: a flag\'s possible values, in clap\'s short and long forms, or null (PR 95 review F3)', () => {
  const short = `  -s, --sandbox <MODE>  pick one [possible values: read-only, workspace-write]\n  -m, --model <M>  any model\n`;
  assert.deepEqual(helpValues(short, '-s'), ['read-only', 'workspace-write']);
  assert.equal(helpValues(short, '-m'), null);
  const long = `  -a, --ask-for-approval <APPROVAL_POLICY>\n          When to ask\n\n          Possible values:\n          - untrusted:  only trusted\n          - never:      never ask\n\n  -c, --config <key=value>\n          Override a key\n`;
  assert.deepEqual(helpValues(long, '-a'), ['untrusted', 'never']);
  assert.equal(helpValues(long, '-c'), null);
  assert.ok(helpLists(long, '-c') && !helpLists(long, '-u'), 'a value bullet is not an option line');
  // claude 2.1's commander help, as printed: the choices wrap over the description's lines
  const claude = '  --permission-mode <mode>              Permission mode to use for the session\n                                        (choices: "acceptEdits", "auto",\n                                        "bypassPermissions", "manual",\n                                        "dontAsk", "plan")\n  --permission-prompts <target>         Who answers (choices: "host", "none", default:\n                                        "host")\n';
  assert.deepEqual(helpValues(claude, '--permission-mode'), ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
  assert.deepEqual(helpValues(claude, '--permission-prompts'), ['host', 'none']);
});

test('launchFlags: the flags each adapter passes, from builder and read-only launches, never their values', () => {
  const codex = launchFlags('codex', ROOT, ROOT);
  for (const f of ['--no-daemon', '-m', '-a', '--dangerously-bypass-hook-trust', '-s', '-c']) assert.ok(codex.flags.includes(f), `codex ${f}`);
  assert.ok(!codex.flags.some((f) => !f.startsWith('-')), 'values are not flags');
  assert.deepEqual(new Set(launchFlags('claude', ROOT, ROOT).flags), new Set(['--model', '--effort', '--permission-mode', '--settings', '--strict-mcp-config', '--mcp-config']));
  for (const f of ['--hostname', '--port', '-m', '--auto']) assert.ok(launchFlags('opencode', ROOT, ROOT).flags.includes(f), `opencode ${f}`);
  for (const f of ['--dangerously-skip-permissions', '--settings', '--model', '--effort']) assert.ok(launchFlags('agy', ROOT, ROOT).flags.includes(f), `agy ${f}`);
});

const probe = (table: Partial<Record<string, ReturnType<AgentProbe> | null>>): AgentProbe => (kind) => table[kind] ?? { path: null };

test('the report: a CLI that no longer lists a launch flag fails, naming the flag and the adapter; one not installed is skipped', () => {
  const r = agentFlagsReport({ root: ROOT, probe: probe({
    claude: { path: '/bin/claude', version: '2.1.0 (Claude Code)', help: '--model --effort --permission-mode --settings --strict-mcp-config --mcp-config' },
    codex: { path: '/bin/codex', version: 'codex-cli 0.160.0', help: '-m, --model\n-a, --ask-for-approval\n-s, --sandbox\n-c, --config\n--dangerously-bypass-hook-trust\n--disable' },
  }) });
  assert.equal(r.ok, false);
  assert.equal(r.problems, 1);
  assert.ok(r.lines.some((l) => /^agents: claude 2\.1\.0 \(Claude Code\) lists all 6 launch flags$/.test(l)), r.lines.join('\n'));
  const codex = r.lines.find((l) => l.startsWith('agents: codex'))!;
  assert.match(codex, /codex-cli 0\.160\.0: --help does not list --no-daemon/);
  assert.match(codex, /cli\/agents\/codex\.ts/);
  assert.ok(r.lines.some((l) => l === 'agents: opencode not installed here, skipped'));
  assert.ok(r.lines.some((l) => l === 'agents: agy not installed here, skipped'));
  assert.deepEqual(r.json.codex.missing, ['--no-daemon']);
});

test('the report: help that cannot be read fails the check (PR 95 review F2); nothing installed is a pass', () => {
  const r = agentFlagsReport({ root: ROOT, probe: probe({ agy: { path: '/bin/agy', error: 'timed out after 15 s' } }) });
  assert.equal(r.ok, false);
  assert.equal(r.problems, 1);
  assert.ok(r.lines.some((l) => /^agents: agy: launch flags not checked: timed out after 15 s\. Run `agy --help` by hand$/.test(l)), r.lines.join('\n'));
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
  assert.ok(withBad.lines.some((l) => /agents: claude 2\.1\.0: --help does not list --effort, --permission-mode, --strict-mcp-config, --mcp-config/.test(l)), withBad.lines.join('\n'));
  assert.equal(withBad.json.problems, without.json.problems + 1);
  assert.deepEqual(withBad.json.agents.claude.missing, ['--effort', '--permission-mode', '--strict-mcp-config', '--mcp-config']);
});

test('the report: an adapter value the CLI no longer offers fails, naming flag and value (PR 95 review F3)', () => {
  const help = '-m, --model <M>\n-a, --ask-for-approval <P>  [possible values: untrusted, on-request, never]\n-s, --sandbox <S>  [possible values: read-only, workspace-write]\n-c, --config <kv>\n--dangerously-bypass-hook-trust\n--disable <F>\n--no-daemon\n';
  const r = agentFlagsReport({ root: ROOT, probe: probe({ codex: { path: '/bin/codex', version: 'codex-cli 0.170.0', help } }) });
  assert.equal(r.ok, false);
  const line = r.lines.find((l) => l.startsWith('agents: codex'))!;
  // since PR 88 a Codex builder launches with -s danger-full-access (a reviewer with read-only)
  assert.match(line, /--help does not offer -s danger-full-access/);
  assert.doesNotMatch(line, /-s read-only|-a never|--no-daemon -m/);
  assert.deepEqual(r.json.codex.badValues, ['-s danger-full-access']);
});

// PR 95 review F1, F6: a real run through a fake CLI on PATH (POSIX shell scripts: the Windows path uses taskkill /T, not run here)
const posix = process.platform !== 'win32';
const onPath = (dir: string) => ({ ...process.env, PATH: [dir, '/usr/bin', '/bin'].join(delimiter) });
function fakeCli(t: { after: (fn: () => void) => void }, name: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-fake-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
  return dir;
}

test('the probe: a CLI that hangs with a child holding its output is killed with its whole tree, and doctor returns (F1)', { skip: !posix && 'POSIX only' }, (t) => {
  const dir = fakeCli(t, 'codex', 'sleep 300 &\necho $! > "$(dirname "$0")/child.pid"\nsleep 300');
  const started = Date.now();
  const r = makeProbe({ timeoutMs: 1500, env: onPath(dir) })('codex');
  assert.ok(Date.now() - started < 9000, `returned in ${Date.now() - started} ms`);
  assert.match(r.error ?? '', /timed out after 1\.5 s/);
  const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) { alive = running(pid); if (alive) spawnWait(50); }
  assert.ok(!alive, `the CLI's child ${pid} was killed too`);
});
// A killed process nobody has reaped yet is a zombie (in a container whose PID 1 is the test runner, an orphan stays one),
// and kill(pid, 0) still finds it: on Linux its /proc state says Z, which counts as gone.
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch (e: any) {
    if (e?.code !== 'ENOENT' || existsSync('/proc/self/stat')) return false;
    try { process.kill(pid, 0); return true; } catch { return false; } // no /proc (macOS)
  }
}
function spawnWait(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

test('the probe: runs only --version and --help, with the seats\' update-off env (F6)', { skip: !posix && 'POSIX only' }, (t) => {
  const dir = fakeCli(t, 'agy', 'echo "$@" >> "$(dirname "$0")/calls"\nif [ "$1" = --version ]; then echo "agy 1.5.18"; else echo "  --dangerously-skip-permissions\\n  --settings <f>\\n  --model <m>\\n  upd=$AGY_CLI_DISABLE_AUTO_UPDATE"; fi');
  const r = makeProbe({ timeoutMs: 5000, env: onPath(dir) })('agy');
  assert.equal(r.version, 'agy 1.5.18');
  assert.match(r.help ?? '', /upd=true/);
  // the two calls run at once (L1): either order, each once
  assert.deepEqual(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').sort(), ['--help', '--version']);
  assert.equal(makeProbe({ env: onPath(dir) })('codex').path, null, 'not on this PATH: not installed');
});

// PR 95 review N1: no env value on the runner's command line (a process listing shows it; Windows caps it at 32,767 chars)
const SECRET = `cb-fake-secret-${process.pid}-${Date.now()}`;
function fakeAnyCli(t: { after: (fn: () => void) => void }, name: string, helpLine: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-fake-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (posix) { writeFileSync(join(dir, name), `#!/bin/sh\necho "${helpLine.replace(/%(\w+)%/g, '$$$1')}"\n`); chmodSync(join(dir, name), 0o755); }
  else writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\necho ${helpLine}\r\n`);
  return dir;
}

test('the probe: the runner is started with the env in spawnSync\'s env option, never on its argv, once per CLI (N1, L1)', (t) => {
  const dir = fakeAnyCli(t, 'codex', '  --x');
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const env = { ...process.env, PATH: dir, CB_FAKE_SECRET: SECRET };
  const r = makeProbe({ env, spawn: (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    return { status: 0, stdout: JSON.stringify([{ status: 0, out: 'codex-cli 9.9.9', err: '', error: null }, { status: 0, out: '  --x', err: '', error: null }]) };
  } })('codex');
  assert.equal(r.version, 'codex-cli 9.9.9');
  assert.equal(calls.length, 1, 'one runner does both calls');
  const call = calls[0]!;
  assert.equal(call.cmd, process.execPath);
  assert.ok(!call.args.some((a) => a.includes(SECRET)), 'the secret value is not on the runner\'s command line');
  assert.deepEqual(Object.keys(JSON.parse(call.args.at(-1)!)).sort(), ['args', 'file', 'ms', 'shell']);
  assert.deepEqual(JSON.parse(call.args.at(-1)!).args, ['--version', '--help']);
  assert.equal(call.env.CB_FAKE_SECRET, SECRET, 'the env goes in through spawnSync\'s env option');
});

test('the probe: the CLI still gets the env, through the runner (N1; a .cmd under cmd.exe on Windows)', (t) => {
  const dir = fakeAnyCli(t, 'codex', '  --x  s=%CB_FAKE_SECRET%');
  const r = makeProbe({ timeoutMs: 10_000, env: { ...process.env, PATH: [dir, process.env.PATH ?? process.env.Path ?? ''].join(delimiter), CB_FAKE_SECRET: SECRET } })('codex');
  assert.equal(r.error, undefined);
  assert.ok((r.help ?? '').includes(`s=${SECRET}`), 'the CLI saw the env value');
});
