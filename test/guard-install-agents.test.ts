// #4609: the guard installer wires Codex, agy and OpenCode seats too, not just Claude. Every path is a temp folder: never
// the real HOME, ~/.codex, ~/.config or a real seat. The installed result must pass the seat prestart's own checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT_MATCHERS, AGENT_SHIMS, GUARD_FILES, checkAgentWiring, codexHooksFeature, installGuard, wireAgents } from '../kit/guard/install.mjs';
import { seatRefusal } from '../cli/agents/seat-prestart.ts';
import { writeOpencodeEndpoint } from '../cli/agents/opencode.ts';
import { ADAPTERS } from '../cli/agents/index.ts';
import { isClaudeOnly } from '../cli/agents/env.ts';

const SRC = fileURLToPath(new URL('../kit/guard/', import.meta.url));
const INSTALL = join(SRC, 'install.mjs');
const fwd = (p: string) => p.replace(/\\/g, '/');

function world(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'cb-guard-agents-'));
  const home = join(root, 'home'), target = join(root, 'home', '.claude-board', 'guard'), seat = join(root, 'seat'), tmp = join(root, 'tmp');
  for (const d of [home, seat, tmp, join(seat, '.git', 'info')]) mkdirSync(d, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  for (const k of Object.keys(env)) if (isClaudeOnly(k) || /^CB_/i.test(k)) delete env[k];
  for (const k of ['CODEX_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_SERVER_PASSWORD']) delete env[k];
  return { root, home, target, seat, tmp, env };
}
type World = ReturnType<typeof world>;
const install = (w: World, agents = ['codex', 'agy', 'opencode']) => installGuard(SRC, w.target, { agents });
const wire = (w: World, o: { agents?: string[]; seats?: string[] } = {}) =>
  wireAgents(w.target, { agents: o.agents ?? ['codex', 'agy', 'opencode'], seats: o.seats ?? [w.seat], env: w.env, home: w.home });
const codexFile = (w: World) => join(w.home, '.codex', 'hooks.json');
const codexToml = (w: World) => join(w.home, '.codex', 'config.toml');
const agyFile = (w: World) => join(w.seat, '.agents', 'hooks.json');
const pluginFile = (w: World) => join(w.home, '.config', 'opencode', 'plugins', 'cb-guard.js');
const trustSeat = (w: World) => {
  mkdirSync(join(w.home, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(join(w.home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ trustedWorkspaces: [w.seat] }));
};
// the OpenCode check also wants the pane's password in the seat's endpoint file, which lives in os.tmpdir()
function opencodeRefusal(w: World) {
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: w.tmp, TEMP: w.tmp, TMP: w.tmp });
  try {
    writeOpencodeEndpoint('m', 'w9:p1', { port: 41234, password: 'synthetic-password-for-a-test' });
    return seatRefusal('opencode', 'm', 'w9:p1', { ...w.env, CB_ROLE: 'builder', CB_AGENT: 'opencode', OPENCODE_SERVER_PASSWORD: 'synthetic-password-for-a-test' } as NodeJS.ProcessEnv, w.seat, w.home);
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

test('a fresh install for all three agents passes each seat prestart check (temp HOME, temp seat)', (t) => {
  const w = world(t);
  const g = install(w);
  assert.ok(g.ok, JSON.stringify(g));
  for (const f of [...GUARD_FILES, ...Object.values(AGENT_SHIMS)]) assert.ok(existsSync(join(w.target, f)), f);
  const r = wire(w);
  assert.ok(r.ok, r.problems.join('\n'));
  trustSeat(w); // trusting the folder stays a person's step in agy
  assert.equal(seatRefusal('codex', 'm', 'w9:p1', { ...w.env, CB_ROLE: 'builder', CB_AGENT: 'codex' } as NodeJS.ProcessEnv, w.seat, w.home), null);
  assert.equal(seatRefusal('agy', 'm', 'w9:p1', { ...w.env, CB_ROLE: 'builder', CB_AGENT: 'agy' } as NodeJS.ProcessEnv, w.seat, w.home), null);
  assert.equal(opencodeRefusal(w), null);
  // every hook runs the installed copy, never the checkout's kit/guard
  for (const f of [codexFile(w), agyFile(w), pluginFile(w)]) {
    const text = readFileSync(f, 'utf8');
    assert.ok(text.includes(fwd(w.target)), `${f} runs the installed guard`);
    assert.ok(!text.includes(fwd(SRC)), `${f} never runs the checkout`);
  }
  assert.match(readFileSync(join(w.seat, '.git', 'info', 'exclude'), 'utf8'), /^\/\.agents\/$/m);
  assert.equal(codexHooksFeature(readFileSync(codexToml(w), 'utf8')), true);
});

test('wiring keeps every other entry (herdr\'s SessionStart, the owner\'s hooks), replaces an old guard entry, and a second run changes nothing', (t) => {
  const w = world(t);
  mkdirSync(join(w.home, '.codex'), { recursive: true });
  const herdr = [{ hooks: [{ type: 'command', command: 'herdr-state session' }] }];
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-audit-tool --log' }] };
  const old = { matcher: '^(Bash|apply_patch)$', hooks: [{ type: 'command', command: `node ${fwd(SRC)}shim-codex.mjs` }] };
  writeFileSync(codexFile(w), JSON.stringify({ hooks: { SessionStart: herdr, PreToolUse: [mine, old] }, other: 1 }));
  writeFileSync(codexToml(w), 'model = "gpt-5"\n\n[features]\nfoo = true\n\n[tui]\nx = 1\n');
  mkdirSync(join(w.seat, '.agents'), { recursive: true });
  writeFileSync(agyFile(w), JSON.stringify({ mine: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  writeFileSync(join(w.seat, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n');
  assert.ok(install(w).ok);
  const first = wire(w);
  assert.ok(first.ok, first.problems.join('\n'));
  assert.ok(first.changed.length >= 4, `${first.changed}`);

  const doc = JSON.parse(readFileSync(codexFile(w), 'utf8'));
  assert.deepEqual(doc.hooks.SessionStart, herdr);
  assert.equal(doc.other, 1);
  assert.deepEqual(doc.hooks.PreToolUse[0], mine);
  const guards = doc.hooks.PreToolUse.filter((e: any) => JSON.stringify(e).includes('shim-codex.mjs'));
  assert.equal(guards.length, 1, 'the old checkout entry is replaced, not kept beside the new one');
  assert.equal(guards[0].matcher, '.*');
  const toml = readFileSync(codexToml(w), 'utf8');
  assert.equal(toml.match(/^\[features\]$/gm)?.length, 1, 'one [features] table');
  assert.match(toml, /^\[features\]\nhooks = true\nfoo = true$/m);
  assert.match(toml, /^model = "gpt-5"$/m);
  assert.match(toml, /^\[tui\]\nx = 1$/m);
  assert.ok(JSON.parse(readFileSync(agyFile(w), 'utf8')).mine, 'the owner\'s agy group stays');

  const before = [codexFile(w), codexToml(w), agyFile(w), pluginFile(w), join(w.seat, '.git', 'info', 'exclude')].map((f) => readFileSync(f, 'utf8'));
  const again = wire(w);
  assert.ok(again.ok, again.problems.join('\n'));
  assert.deepEqual(again.changed, []);
  assert.deepEqual([codexFile(w), codexToml(w), agyFile(w), pluginFile(w), join(w.seat, '.git', 'info', 'exclude')].map((f) => readFileSync(f, 'utf8')), before);
});

test('wiring refuses what it must not overwrite and leaves those files as they were', (t) => {
  const w = world(t);
  assert.ok(install(w).ok);
  mkdirSync(join(w.home, '.codex'), { recursive: true });
  writeFileSync(codexFile(w), '{ not json');
  writeFileSync(codexToml(w), '[features]\nhooks = false\n');
  const r = wire(w, { agents: ['codex'] });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p: string) => /hooks\.json/.test(p) && /not JSON|cannot read/.test(p)), r.problems.join('\n'));
  assert.equal(readFileSync(codexFile(w), 'utf8'), '{ not json');
  assert.equal(readFileSync(codexToml(w), 'utf8'), '[features]\nhooks = false\n');

  writeFileSync(codexFile(w), '{}');
  const off = wire(w, { agents: ['codex'] });
  assert.ok(off.problems.some((p: string) => /hooks = false/.test(p) && /by hand/.test(p)), off.problems.join('\n'));
  assert.equal(readFileSync(codexToml(w), 'utf8'), '[features]\nhooks = false\n', 'an explicit false is the owner\'s: never flipped');

  writeFileSync(codexToml(w), 'features = { web_search = true }\n');
  assert.ok(wire(w, { agents: ['codex'] }).problems.some((p: string) => /inline/.test(p)));

  // the shared readers (review 70-M3, M4): a repeated key would be dropped by a rewrite; a selected profile can turn
  // hooks off; a [features] line inside a multi-line string is text, not the table
  writeFileSync(codexToml(w), '');
  writeFileSync(codexFile(w), '{"hooks": {}, "hooks": {"PreToolUse": []}}');
  assert.ok(wire(w, { agents: ['codex'] }).problems.some((p: string) => /repeats the key "hooks"/.test(p)));
  assert.equal(readFileSync(codexFile(w), 'utf8'), '{"hooks": {}, "hooks": {"PreToolUse": []}}');
  writeFileSync(codexFile(w), '{}');
  writeFileSync(codexToml(w), 'profile = "quiet"\n\n[profiles.quiet.features]\nhooks = false\n');
  assert.ok(wire(w, { agents: ['codex'] }).problems.some((p: string) => /profile "quiet"/.test(p)));
  const TQ = '"'.repeat(3);
  // read as text (never as the table), and, since PR 96 review B1, refused rather than given a [features] line of its own:
  // a second [features] header would stop Codex if this reading were ever wrong
  const mlText = `notes = ${TQ}\n[features]\nnot a table\n${TQ}\n`;
  writeFileSync(codexToml(w), mlText);
  assert.equal(codexHooksFeature(mlText), undefined);
  const ml = wire(w, { agents: ['codex'] });
  assert.ok(ml.problems.some((p: string) => /by hand/.test(p)), ml.problems.join('\n'));
  assert.equal(readFileSync(codexToml(w), 'utf8'), mlText);
  writeFileSync(codexToml(w), `notes = ${TQ}\nno table here\n${TQ}\n`);
  assert.ok(wire(w, { agents: ['codex'] }).ok);
  assert.ok(readFileSync(codexToml(w), 'utf8').endsWith(`no table here\n${TQ}\n\n[features]\nhooks = true\n`), readFileSync(codexToml(w), 'utf8'));

  // agy runs a hook command through cmd /c on Windows, with no quotes: a guard path with a space cannot be written
  const spaced = join(w.root, 'my guard');
  assert.ok(installGuard(SRC, spaced, { agents: ['agy'] }).ok);
  const sp = wireAgents(spaced, { agents: ['agy'], seats: [w.seat], env: w.env, home: w.home });
  assert.ok(sp.problems.some((p: string) => /space/.test(p)), sp.problems.join('\n'));
  assert.ok(!existsSync(join(w.seat, '.agents')));
  assert.ok(wire(w, { agents: ['agy'], seats: [] }).problems.some((p: string) => /--seat/.test(p)));
});

test('a git worktree seat gets the exclude line in the shared info/exclude', (t) => {
  const w = world(t);
  const common = join(w.root, 'main.git'), wt = join(common, 'worktrees', 'seat');
  mkdirSync(join(common, 'info'), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, 'commondir'), '../..\n');
  const seat = join(w.root, 'wtseat');
  mkdirSync(seat);
  writeFileSync(join(seat, '.git'), `gitdir: ${wt}\n`);
  assert.ok(install(w, ['agy']).ok);
  const r = wire(w, { agents: ['agy'], seats: [seat] });
  assert.ok(r.ok, r.problems.join('\n'));
  assert.match(readFileSync(join(common, 'info', 'exclude'), 'utf8'), /^\/\.agents\/$/m);
});

test('--check: the installed agent shims hash-match and each wiring passes the probes through its own command', (t) => {
  const w = world(t);
  assert.ok(install(w).ok);
  assert.ok(wire(w).ok);
  const opts = { agents: ['codex', 'agy', 'opencode'], seats: [w.seat], env: w.env, home: w.home };
  const c = checkAgentWiring(w.target, opts);
  assert.ok(c.ok, c.problems.join('\n'));
  assert.ok(c.probes >= 9, `probes ${c.probes}`);
  assert.deepEqual(installGuard(SRC, w.target, { checkOnly: true, agents: ['codex', 'agy', 'opencode'] }).drift, []);

  writeFileSync(join(w.target, 'shim-agy.mjs'), '// changed\n');
  assert.deepEqual(installGuard(SRC, w.target, { checkOnly: true, agents: ['agy'] }).drift, ['shim-agy.mjs']);
  assert.deepEqual(installGuard(SRC, w.target, { checkOnly: true }).drift, [], 'a Claude-only check is unchanged');

  const doc = JSON.parse(readFileSync(codexFile(w), 'utf8'));
  for (const e of doc.hooks.PreToolUse) for (const h of e.hooks) h.command = 'echo shim-codex.mjs';
  writeFileSync(codexFile(w), JSON.stringify(doc));
  const bad = checkAgentWiring(w.target, { ...opts, agents: ['codex'] });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p: string) => /codex/.test(p)), bad.problems.join('\n'));
  rmSync(pluginFile(w));
  assert.ok(checkAgentWiring(w.target, { ...opts, agents: ['opencode'] }).problems.some((p: string) => /cb-guard\.js/.test(p)));
});

test('#4817: wiring OpenCode also installs the 2.x plugin beside the 1.x one, and --check wants both', (t) => {
  const w = world(t);
  assert.ok(install(w, ['opencode']).ok);
  assert.ok(wire(w, { agents: ['opencode'] }).ok);
  const v2 = join(dirname(pluginFile(w)), 'cb-guard-v2.js');
  const text = readFileSync(v2, 'utf8');
  assert.ok(text.includes(JSON.stringify(fwd(join(w.target, 'shim-opencode.mjs')))), 'runs the installed shim');
  const opts = { agents: ['opencode'], seats: [w.seat], env: w.env, home: w.home };
  assert.ok(checkAgentWiring(w.target, opts).ok);
  writeFileSync(v2, `${text}// changed`);
  assert.ok(checkAgentWiring(w.target, opts).problems.some((p: string) => /cb-guard-v2\.js/.test(p)));
  rmSync(v2);
  assert.ok(checkAgentWiring(w.target, opts).problems.some((p: string) => /cb-guard-v2\.js/.test(p)));
});

test('the OpenCode plugin forwards every tool to the shim and throws on a block, an unknown tool, a missing shim or bad output', async (t) => {
  const w = world(t);
  assert.ok(install(w, ['opencode']).ok);
  assert.ok(wire(w, { agents: ['opencode'] }).ok);
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, { CB_ROLE: 'builder', CB_AGENT: 'opencode' });
  const load = async (file: string) => {
    const mod = await import(`${pathToFileURL(file).href}?v=${Math.random()}`);
    const fns = Object.values(mod).filter((v) => typeof v === 'function');
    assert.equal(fns.length, 1, 'exactly one export: OpenCode loads every exported function as a plugin');
    return (await (fns[0] as any)({ directory: w.seat, worktree: w.seat }))['tool.execute.before'];
  };
  const before = await load(pluginFile(w));
  await before({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'ls' } });
  await assert.rejects(before({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'git reset --hard' } }), /Blocked dangerous command/);
  await assert.rejects(before({ tool: 'webfetch', sessionID: 's', callID: 'c' }, { args: { url: 'https://example.com' } }), /unrecognized tool/);
  await assert.rejects(before({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'git push origin main' } }), /Blocked by role \(builder\)/);

  // the plugin fails closed: a missing shim, and a shim that prints something other than the two answers
  const text = readFileSync(pluginFile(w), 'utf8');
  const shim = fwd(join(w.target, 'shim-opencode.mjs'));
  const missing = join(w.root, 'missing-plugin.js');
  writeFileSync(missing, text.split(JSON.stringify(shim)).join(JSON.stringify(fwd(join(w.root, 'nowhere', 'shim-opencode.mjs')))));
  await assert.rejects((await load(missing))({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'ls' } }), /guard/i);
  const liar = join(w.root, 'liar.mjs');
  writeFileSync(liar, 'process.stdout.write("ok")');
  const lying = join(w.root, 'lying-plugin.js');
  writeFileSync(lying, text.split(JSON.stringify(shim)).join(JSON.stringify(fwd(liar))));
  await assert.rejects((await load(lying))({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'ls' } }), /guard/i);
});

test('the installer\'s matchers are the adapters\' own; Codex is a catch-all now (the shim denies a tool it does not know)', () => {
  for (const kind of ['codex', 'agy'] as const) {
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      assert.equal(AGENT_MATCHERS[kind], ADAPTERS[kind].guardInstallSpec!('/b', p).matchers[p], `${kind} ${p}`);
    }
  }
  assert.equal(AGENT_MATCHERS.codex, '.*');
});

test('the CLI: --agents takes only known agents, agy needs --seat, and nothing is written on a usage error', (t) => {
  const w = world(t);
  const run = (...args: string[]) => spawnSync(process.execPath, [INSTALL, '--target', w.target, ...args], { env: w.env as NodeJS.ProcessEnv, encoding: 'utf8' });
  for (const args of [['--agents', 'bogus'], ['--agents', 'agy'], ['--agents'], ['--seat', w.seat]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.ok(!existsSync(w.target), `${args.join(' ')} wrote nothing`);
  }
  const ok = run('--agents', 'codex,opencode');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(existsSync(codexFile(w)) && existsSync(pluginFile(w)));
  const check = run('--check', '--no-wiring', '--agents', 'codex,opencode');
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test('PR 96 review B1: a # inside a one-line string is text, so the real [features] is found; never a second [features] header', (t) => {
  const w = world(t);
  assert.ok(install(w, ['codex']).ok);
  mkdirSync(join(w.home, '.codex'), { recursive: true });
  const TQ = "'".repeat(3), DQ = '"'.repeat(3);
  // the owner's explicit false, after a one-line triple-quoted string with ' #' in it: read, and refused, never buried
  for (const str of [`${TQ}Use # for headings${TQ}`, `${DQ}Use # for headings${DQ}`, '"a # b"', "'a # b'", `${DQ}a \\""" # b${DQ}`]) {
    const toml = `instructions = ${str}\n[features]\nhooks = false\n`;
    writeFileSync(codexToml(w), toml);
    const r = wire(w, { agents: ['codex'], seats: [] });
    assert.equal(r.ok, false, str);
    assert.match(r.problems.join('\n'), /hooks = false/, str);
    assert.equal(readFileSync(codexToml(w), 'utf8'), toml, `${str}: left as it was`);
    assert.equal(codexHooksFeature(toml), false, str);
  }
  // an existing [features] gets hooks = true under it, and still has exactly one header
  writeFileSync(codexToml(w), `instructions = ${TQ}Use # for headings${TQ} # a comment\n[features]\nweb_search = true\n`);
  assert.ok(wire(w, { agents: ['codex'], seats: [] }).ok);
  const after = readFileSync(codexToml(w), 'utf8');
  assert.equal(after.match(/^\[features\]/gm)?.length, 1, after);
  assert.equal(codexHooksFeature(after), true);
  // a [features] header the reader cannot place the key under (here: inside a real multi-line string) is refused, not doubled
  const odd = `notes = ${DQ}\n[features]\n${DQ}\nmodel = "x"\n`;
  writeFileSync(codexToml(w), odd);
  const r = wire(w, { agents: ['codex'], seats: [] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /by hand/);
  assert.equal(readFileSync(codexToml(w), 'utf8'), odd);
});

test('PR 96 review M1/M2: a rewritten config.toml and hooks.json keep CRLF line endings and their file mode', (t) => {
  const w = world(t);
  assert.ok(install(w, ['codex']).ok);
  mkdirSync(join(w.home, '.codex'), { recursive: true });
  writeFileSync(codexToml(w), 'model = "x"\r\n[features]\r\nweb_search = true\r\n', { mode: 0o600 });
  writeFileSync(codexFile(w), '{\r\n  "hooks": {}\r\n}\r\n', { mode: 0o640 });
  if (process.platform !== 'win32') { spawnSync('chmod', ['600', codexToml(w)]); spawnSync('chmod', ['640', codexFile(w)]); }
  assert.ok(wire(w, { agents: ['codex'], seats: [] }).ok);
  for (const f of [codexToml(w), codexFile(w)]) {
    const text = readFileSync(f, 'utf8');
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, `${f}: every line ends in CRLF`);
  }
  assert.match(readFileSync(codexToml(w), 'utf8'), /\[features\]\r\nhooks = true\r\n/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(codexToml(w)).mode & 0o777, 0o600);
    assert.equal(statSync(codexFile(w)).mode & 0o777, 0o640);
  }
});

test('PR 96 review I1: in a board seat (CB_ROLE or CB_AGENT set) the installer runs only --check and writes nothing else', (t) => {
  const w = world(t);
  const run = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, [INSTALL, '--target', w.target, ...args], { env: { ...w.env, ...env } as NodeJS.ProcessEnv, encoding: 'utf8' });
  for (const env of [{ CB_ROLE: 'builder' }, { CB_AGENT: 'codex' }, { CB_ROLE: 'reviewer', CB_AGENT: 'claude' }]) {
    for (const args of [[], ['--agents', 'codex'], ['--agents', 'codex,opencode']]) {
      const r = run(env, ...args);
      assert.equal(r.status, 2, `${JSON.stringify(env)} ${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /board seat.*--check/s);
      assert.ok(!existsSync(w.target) && !existsSync(codexFile(w)), 'nothing written');
    }
  }
  assert.equal(run({ CB_ROLE: '  ' }, '--agents', 'codex').status, 0, 'a blank CB_ROLE is not a seat');
  const check = run({ CB_ROLE: 'builder' }, '--check', '--no-wiring', '--agents', 'codex');
  assert.equal(check.status, 0, check.stdout + check.stderr);
});
