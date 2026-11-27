// #4002 install gates on the launch path: a non-Claude seat's pane drops the Claude-only env from its real shell before
// the agent starts (herdr --env only adds), OpenCode's password is made in the pane and never rides on any argv, the seat
// is refused unless the guard will run (fails closed), Codex's input box gets text it can submit, and a Claude seat's
// launch is unchanged. Real shells and real node children; herdr is a fake that runs the typed lines in one shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paneShell, prestartLine, startOne, type Launch, type Runner } from '../cli/squad-up.ts';
import { ADAPTERS, type AgentKind } from '../cli/agents/index.ts';
import { CLAUDE_ONLY_ENV, isClaudeOnly } from '../cli/agents/env.ts';
import { codexPromptText, createCodexAdapter } from '../cli/agents/codex.ts';
import { opencodeEndpointPath, writeOpencodeEndpoint } from '../cli/agents/opencode.ts';
import { seatRefusal } from '../cli/agents/seat-prestart.ts';

const BOARD = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
// Plainly fake values: the names are what count, and no value is ever printed by a child.
const CANARY = { GITHUB_PERSONAL_ACCESS_TOKEN: 'not-a-token', CLAUDE_CODE_FAKE_SOCKET: 'fake', ANTHROPIC_FAKE_KEY: 'fake', anthropic_fake_lower: 'fake', CLAUDECODE: '1', CB_KEEP_ME: 'kept' };
const ALL: ReadonlySet<AgentKind> = new Set(['claude', 'codex', 'opencode', 'agy']);
const GATE = { installed: ALL, env: { CB_MCP_GATE_OK: 'codex,opencode,agy' } };
const noPause = () => {};
const shellOk = (sh: string) => { const r = spawnSync(sh, ['-c', 'env >/dev/null && echo ok'], { encoding: 'utf8' }); return r.status === 0 && r.stdout.trim() === 'ok'; };
const bashOk = shellOk('bash'), zshOk = shellOk('zsh');
const pwshOk = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

// The guard files in the shapes the guard installs (review 70-I3: they are parsed now, so the fixtures are real shapes).
const NODE = `"${process.execPath.replace(/\\/g, '/')}"`;
const codexHooks = (pre: unknown) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'herdr-state session' }] }], PreToolUse: pre } });
const CODEX_MATCHER = ADAPTERS.codex.guardInstallSpec!(BOARD).matchers[process.platform as 'win32' | 'darwin' | 'linux'];
const CODEX_GOOD = [{ matcher: CODEX_MATCHER, hooks: [{ type: 'command', command: `${NODE} ${BOARD}/kit/guard/shim-codex.mjs`, timeout: 30 }] }];
const AGY_GOOD = { 'cb-guard': { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `node ${BOARD}/kit/guard/shim-agy.mjs`, timeout: 10 }] }] } };
const PLUGIN_GOOD = `export const CbGuard = async () => ({ "tool.execute.before": async (input, output) => run(${JSON.stringify(`${BOARD}/kit/guard/shim-opencode.mjs`)}, input, output) });\n`;

/** A home folder with the guard installed for every agent, and a seat folder agy trusts (unless told otherwise). */
function world(t: { after: (fn: () => void) => void }, o: { codexHook?: boolean; agyTrusted?: boolean; plugin?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cb-prestart-')), home = join(root, 'home'), ws = join(root, 'ws'), tmp = join(root, 'tmp');
  for (const d of [home, ws, tmp, join(home, '.codex'), join(home, '.gemini', 'antigravity-cli'), join(home, '.config', 'opencode', 'plugins'), join(ws, '.agents')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), '[features]\nhooks = true\n');
  if (o.codexHook !== false) writeFileSync(join(home, '.codex', 'hooks.json'), codexHooks(CODEX_GOOD));
  writeFileSync(join(ws, '.agents', 'hooks.json'), JSON.stringify(AGY_GOOD));
  writeFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ trustedWorkspaces: o.agyTrusted === false ? [root] : [join(root, 'elsewhere'), ws] }));
  if (o.plugin !== false) writeFileSync(join(home, '.config', 'opencode', 'plugins', 'cb-guard.js'), PLUGIN_GOOD);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // a pane cb squad up started holds CB_ROLE (and CB_AGENT, set per agent where a check runs: seatEnv)
  const env: Record<string, string | undefined> = { ...process.env, ...CANARY, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, CB_ROLE: 'builder' };
  for (const k of ['CODEX_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_SERVER_PASSWORD']) delete env[k];
  return { root, home, ws, env };
}
const seatEnv = (env: Record<string, string | undefined>, agent: string) => ({ ...env, CB_AGENT: agent }) as NodeJS.ProcessEnv;

// PR 96 review r2 I3: the prestart is where a seat is known to be a seat, so a pane without both variables (CB_ROLE set,
// CB_AGENT the agent being started) is refused there: outside a seat the guard keeps only its dangerous-command rules
test('seatRefusal (PR 96 r2 I3): CB_ROLE must be set and CB_AGENT must name the agent being started', (t) => {
  const w = world(t), env = { ...w.env };
  for (const k of Object.keys(env)) if (isClaudeOnly(k)) delete env[k];
  const r = (e: Record<string, string | undefined>) => seatRefusal('codex', 'm', 'w9:p1', e as NodeJS.ProcessEnv, w.ws, w.home);
  assert.equal(r({ ...env, CB_AGENT: 'codex' }), null, 'a real seat passes');
  for (const [what, e] of [
    ['no CB_ROLE', { ...env, CB_ROLE: undefined, CB_AGENT: 'codex' }],
    ['an empty CB_ROLE', { ...env, CB_ROLE: '  ', CB_AGENT: 'codex' }],
    ['no CB_AGENT', { ...env, CB_AGENT: undefined }],
    ['CB_AGENT names another agent', { ...env, CB_AGENT: 'opencode' }],
    ['an empty CB_AGENT', { ...env, CB_AGENT: '' }],
  ] as const) assert.match(r(e) ?? '', /CB_ROLE|CB_AGENT/, what);
});

const ok = (o: unknown) => ({ status: 0, stdout: JSON.stringify(o), stderr: '' });
/** herdr, faked: one pane whose shell is a real bash; every typed line (pane run, then the agent) runs in that one shell. */
function pane(env0: Record<string, string | undefined>, cwd: string, shell = 'bash') {
  const calls: string[][] = [], typed: string[] = [];
  const env = { ...env0 };
  let out = '', agent: { names: string[]; password: string | null; tmp: string } | null = null;
  const sh = (script: string) => spawnSync('bash', ['-c', script], { env: env as NodeJS.ProcessEnv, cwd, encoding: 'utf8' });
  const run: Runner = (_m, args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'tab' && b === 'create') {
      // as herdr does: each --env K=V is set in the new pane's shell (it only adds; the pane inherits the rest)
      args.forEach((x, i) => { if (x === '--env') { const kv = args[i + 1]!; env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1); } });
      return ok({ result: { pane: { pane_id: 'w9:p1' } } });
    }
    if (a === 'pane' && b === 'process-info') return ok({ result: { process_info: { foreground_processes: [{ argv0: `/usr/bin/${shell}`, name: shell }] } } });
    if (a === 'pane' && b === 'run') { typed.push(args[3]!); out = sh(typed.join('\n')).stdout; return ok({ result: { type: 'ok' } }); }
    if (a === 'pane' && b === 'wait-output') {
      const re = new RegExp(args[args.indexOf('--regex') + 1]!);
      const m = out.split(/\r?\n/).map((l) => re.exec(l)).find(Boolean);
      return m ? ok({ result: { matched_line: m[0] } }) : { status: 1, stdout: '', stderr: 'timed out waiting for output match' };
    }
    if (a === 'agent' && b === 'start') {
      // the agent: a node child of the same shell, after every typed line. Names only, plus the one value under test.
      const r = sh(`${typed.join('\n')}\nnode -e "process.stdout.write('\\nAGENT ' + JSON.stringify({ names: Object.keys(process.env), password: process.env.OPENCODE_SERVER_PASSWORD || null, tmp: require('os').tmpdir() }))"`);
      agent = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('AGENT ') + 6));
      return ok({ result: { type: 'agent_started' } });
    }
    return ok({ result: { type: 'ok' } });
  };
  return { run, calls, get agent() { return agent; } };
}
const launch = (agent: AgentKind, ws: string, extra: Partial<Launch> = {}): Launch => ({
  name: 'demo-B1@m', role: 'builder', repo: 'main', seatKey: '1', agent, model: { claude: 'sonnet', codex: 'gpt-5.1-codex', opencode: 'openai/gpt-x', agy: '' }[agent],
  machine: 'm', herdr: null, board: BOARD, cwd: ws, settings: `${BOARD}/kit/permissions/builder.json`, prompt: 'cb iam demo-B1@m demo --role builder, then cb next',
  env: { CB_ROLE: 'builder', CB_AGENT: agent, ...(agent === 'opencode' ? { CB_OPENCODE_PORT: '41234' } : {}) }, ...extra,
});
const herdrArgv = (calls: string[][]) => calls.map((c) => c.join('\u0000')).join('\n');

test('one Claude-only list: every adapter strips it from its launch env, and both prestart scripts carry the same pattern', () => {
  for (const k of Object.keys(CANARY)) assert.equal(isClaudeOnly(k), k !== 'CB_KEEP_ME', k);
  for (const kind of ['codex', 'opencode', 'agy'] as const) {
    const l = { name: 'x@m', role: 'builder', repo: 'main', agent: kind, model: launch(kind, '/w').model, board: '/b', cwd: '/w/x', env: { ...CANARY, CB_OPENCODE_PORT: '41234' } };
    const env = ADAPTERS[kind].buildLaunch(l).env;
    assert.deepEqual(Object.keys(env).filter(isClaudeOnly), [], kind);
    assert.equal(env.CB_KEEP_ME, 'kept', kind);
    assert.ok(ADAPTERS[kind].buildLaunch(l).prestart, `${kind} runs the prestart`);
  }
  assert.equal(ADAPTERS.claude.buildLaunch({ name: 'x@m', role: 'builder', repo: 'main', agent: 'claude', model: 'sonnet', board: '/b', cwd: '/w' }).prestart, undefined);
  const pattern = CLAUDE_ONLY_ENV.source.replace(/\?:/g, '');
  for (const f of ['kit/seat/prestart.sh', 'kit/seat/prestart.ps1']) assert.ok(readFileSync(join(BOARD, f), 'utf8').includes(`'${pattern}'`), f);
});

for (const [sh, has] of [['bash', bashOk], ['zsh', zshOk]] as const) {
  test(`prestart.sh in a real ${sh}: the Claude-only names leave the shell itself, a child sees none, the rest stays`, { skip: !has && `no ${sh}` }, (t) => {
    const w = world(t);
    const r = spawnSync(sh, ['-c', `${prestartLine('posix', BOARD, ['codex', 'm', 'w9:p1', 'n0nce1'])}\nnode -e "process.stdout.write('NAMES ' + Object.keys(process.env).join(','))"`], { env: seatEnv(w.env, 'codex'), cwd: w.ws, encoding: 'utf8' });
    assert.match(r.stdout, /^cb-seat-ready:n0nce1$/m, r.stdout + r.stderr);
    const names = r.stdout.slice(r.stdout.indexOf('NAMES ') + 6).split(',');
    assert.deepEqual(names.filter(isClaudeOnly), []);
    assert.ok(names.includes('CB_KEEP_ME'));
  });
}

test('prestart.ps1 in a real pwsh: the same', { skip: !pwshOk && 'no pwsh' }, (t) => {
  const w = world(t);
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', `${prestartLine('pwsh', BOARD, ['codex', 'm', 'w9:p1', 'n0nce2'])}; node -e "process.stdout.write('NAMES ' + Object.keys(process.env).join(','))"`], { env: seatEnv(w.env, 'codex'), cwd: w.ws, encoding: 'utf8' });
  assert.match(r.stdout, /^cb-seat-ready:n0nce2$/m, r.stdout + r.stderr);
  const names = r.stdout.slice(r.stdout.indexOf('NAMES ') + 6).split(',');
  assert.deepEqual(names.filter(isClaudeOnly), []);
  assert.ok(names.includes('CB_KEEP_ME'));
});

// Review 70-I1: the script is dot-sourced into the user's interactive shell, where a Mac's alias grep="rg" made the strip
// a no-op and refused every seat. Aliases and functions on every command it uses must not change what it does.
// functions first: an alias defined earlier would rename the function being defined
const SHADOWS = 'node() { echo junk; }\ngrep() { return 1; }\nsed() { return 1; }\nenv() { return 1; }\nalias grep=false env=false sed=false node=false unset=false\n';
for (const [sh, has, on] of [['bash', bashOk, 'shopt -s expand_aliases'], ['zsh', zshOk, '']] as const) {
  test(`prestart.sh in a ${sh} whose aliases and functions shadow grep, env, sed and node: still strips, still ready`, { skip: !has && `no ${sh}` }, (t) => {
    const w = world(t);
    const script = `${on}\n${SHADOWS}${prestartLine('posix', BOARD, ['opencode', 'm', 'w9:p1', 'n0nce3', '41234'])}\ncommand node -e "process.stdout.write('NAMES ' + Object.keys(process.env).join(',') + ' PW ' + (process.env.OPENCODE_SERVER_PASSWORD || '').length)"`;
    const r = spawnSync(sh, ['-c', script], { env: seatEnv(w.env, 'opencode'), cwd: w.ws, encoding: 'utf8' });
    assert.match(r.stdout, /^cb-seat-ready:n0nce3$/m, r.stdout + r.stderr);
    const names = r.stdout.slice(r.stdout.indexOf('NAMES ') + 6, r.stdout.indexOf(' PW ')).split(',');
    assert.deepEqual(names.filter(isClaudeOnly), []);
    assert.ok(names.includes('CB_KEEP_ME'));
    assert.match(r.stdout, / PW (?:3[2-9]|[4-9]\d)$/, 'a real password, not a function\'s output');
  });
}

test('prestart.ps1 in a pwsh whose functions and aliases shadow node, Get-Command and Remove-Variable: still strips, still ready', { skip: !pwshOk && 'no pwsh' }, (t) => {
  const w = world(t);
  const shadows = "function node { 'junk' }; function Get-Command { $null }; function Remove-Item { throw 'shadowed' }; Set-Alias -Name Remove-Variable -Value Write-Error -Scope Global";
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', `${shadows}; ${prestartLine('pwsh', BOARD, ['codex', 'm', 'w9:p1', 'n0nce4'])}; & (Microsoft.PowerShell.Core\\Get-Command node -CommandType Application)[0].Source -e "process.stdout.write('NAMES ' + Object.keys(process.env).join(','))"`], { env: seatEnv(w.env, 'codex'), cwd: w.ws, encoding: 'utf8' });
  assert.match(r.stdout, /^cb-seat-ready:n0nce4$/m, r.stdout + r.stderr);
  const names = r.stdout.slice(r.stdout.indexOf('NAMES ') + 6).split(',');
  assert.deepEqual(names.filter(isClaudeOnly), []);
  assert.ok(names.includes('CB_KEEP_ME'));
});

// Review 70-I3: the guard-present checks were substring tests, and all 8 crafted Codex files passed. Each is refused now,
// as are the same tricks against agy's hook file and OpenCode's plugin; the real shapes still pass.
test('seatRefusal reads the guard files, never a substring: crafted Codex, agy and OpenCode files are refused', (t) => {
  const w = world(t), env = { ...w.env };
  for (const k of Object.keys(env)) if (isClaudeOnly(k)) delete env[k];
  const codexFile = join(w.home, '.codex', 'hooks.json'), cfg = join(w.home, '.codex', 'config.toml');
  const refusal = (agent: string) => seatRefusal(agent, 'm', 'w9:p1', seatEnv(env, agent), w.ws, w.home);
  assert.equal(refusal('codex'), null, 'the real shape passes');
  const hook = (command: string) => [{ type: 'command', command }];
  const codexCases: [string, string][] = [
    ['matcher Bash only: apply_patch never guarded', codexHooks([{ matcher: 'Bash', hooks: hook(`${NODE} ${BOARD}/kit/guard/shim-codex.mjs`) }])],
    ['a matcher that matches nothing', codexHooks([{ matcher: '^$', hooks: hook(`${NODE} ${BOARD}/kit/guard/shim-codex.mjs`) }])],
    ['the shim only under SessionStart, PreToolUse empty', JSON.stringify({ hooks: { SessionStart: [{ hooks: hook(`${NODE} ${BOARD}/kit/guard/shim-codex.mjs`) }], PreToolUse: [] } })],
    ['echo shim-codex.mjs', codexHooks([{ matcher: CODEX_MATCHER, hooks: hook('echo shim-codex.mjs') }])],
    ['a shim path that does not exist', codexHooks([{ matcher: CODEX_MATCHER, hooks: hook(`${NODE} ${BOARD}/kit/guard/nowhere/shim-codex.mjs`) }])],
    ['both words only in a description', JSON.stringify({ description: 'PreToolUse runs shim-codex.mjs', hooks: {} })],
    ['not JSON at all', 'PreToolUse shim-codex.mjs {'],
    ['a bare node (missing from PATH: Codex allows)', codexHooks([{ matcher: CODEX_MATCHER, hooks: hook(`node ${BOARD}/kit/guard/shim-codex.mjs`) }])],
    ['the shim chained after another command', codexHooks([{ matcher: CODEX_MATCHER, hooks: hook(`${NODE} ${BOARD}/kit/guard/shim-codex.mjs;true`) }])],
    ['the entry disabled', codexHooks([{ ...CODEX_GOOD[0], enabled: false }])],
  ];
  for (const [what, body] of codexCases) {
    writeFileSync(codexFile, body);
    assert.match(refusal('codex') ?? 'READY', /no PreToolUse hook/, what);
  }
  writeFileSync(codexFile, codexHooks(CODEX_GOOD));
  for (const [what, toml] of [['hooks = false', '[features]\nhooks = false\n'], ['hooks not set', '[tui]\nx = 1\n'], ['no config.toml', null], ['inline features table off', 'features = { hooks = false }\n']] as const) {
    if (toml === null) rmSync(cfg, { force: true }); else writeFileSync(cfg, toml);
    assert.match(refusal('codex') ?? 'READY', /hooks = true/, what);
  }
  for (const toml of ['[features]\nhooks = true # on\n', 'features.hooks = true\n', '[ features ]\n"hooks" = true\n']) {
    writeFileSync(cfg, toml);
    assert.equal(refusal('codex'), null, toml);
  }
  mkdirSync(join(w.ws, '.codex'));
  writeFileSync(join(w.ws, '.codex', 'config.toml'), '[features]\nhooks = false\n');
  assert.match(refusal('codex') ?? 'READY', /seat folder's \.codex\/config\.toml/);
  rmSync(join(w.ws, '.codex'), { recursive: true });

  const agyFile = join(w.ws, '.agents', 'hooks.json'), agyHook = (command: string) => [{ type: 'command', command }];
  assert.equal(refusal('agy'), null, 'the real agy shape passes');
  const agyCases: [string, unknown][] = [
    ['matcher run_command only', { 'cb-guard': { PreToolUse: [{ matcher: 'run_command', hooks: agyHook(`node ${BOARD}/kit/guard/shim-agy.mjs`) }] } }],
    ['the group disabled', { 'cb-guard': { ...AGY_GOOD['cb-guard'], enabled: false } }],
    ['the old flat shape (no hooks array)', { 'cb-guard': { PreToolUse: [{ matcher: '.*', command: `node ${BOARD}/kit/guard/shim-agy.mjs` }] } }],
    ['echo shim-agy.mjs', { 'cb-guard': { PreToolUse: [{ matcher: '.*', hooks: agyHook('echo shim-agy.mjs') }] } }],
    ['a missing shim', { 'cb-guard': { PreToolUse: [{ matcher: '.*', hooks: agyHook(`node ${BOARD}/nowhere/shim-agy.mjs`) }] } }],
    ['under PostToolUse', { 'cb-guard': { PostToolUse: AGY_GOOD['cb-guard'].PreToolUse } }],
    ['names in a description', { description: 'PreToolUse shim-agy.mjs' }],
  ];
  for (const [what, doc] of agyCases) {
    writeFileSync(agyFile, JSON.stringify(doc));
    assert.match(refusal('agy') ?? 'READY', /no enabled PreToolUse hook/, what);
  }
  writeFileSync(agyFile, 'shim-agy.mjs PreToolUse');
  assert.match(refusal('agy') ?? 'READY', /no enabled PreToolUse hook/, 'not JSON');

  const plugin = join(w.home, '.config', 'opencode', 'plugins', 'cb-guard.js');
  // the endpoint file lives in os.tmpdir(): point it at this world's temp folder while the check runs
  const pw = 'synthetic-password-for-a-test', tmp = join(w.root, 'tmp');
  const withTmp = <T>(fn: () => T): T => {
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    Object.assign(process.env, { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
    try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  withTmp(() => writeOpencodeEndpoint('m', 'w9:p1', { port: 41234, password: pw }));
  const ocRefusal = () => withTmp(() => seatRefusal('opencode', 'm', 'w9:p1', seatEnv({ ...env, OPENCODE_SERVER_PASSWORD: pw }, 'opencode'), w.ws, w.home));
  assert.equal(ocRefusal(), null, 'the real plugin shape passes');
  for (const [what, src] of [
    ['an empty plugin', ''],
    ['the shim named in a comment, no hook', `// runs ${BOARD}/kit/guard/shim-opencode.mjs\n`],
    ['a hook running a missing shim', `export default { "tool.execute.before": () => run("${BOARD}/nowhere/shim-opencode.mjs") }\n`],
    ['a relative shim path', 'export default { "tool.execute.before": () => run("./shim-opencode.mjs") }\n'],
  ] as const) {
    writeFileSync(plugin, src);
    assert.match(ocRefusal() ?? 'READY', /does not register tool\.execute\.before/, what);
  }
});

test('startOne, Codex: the agent starts in a pane whose real env has no Claude-only name, after the prestart said ready', { skip: !bashOk && 'no bash' }, (t) => {
  const w = world(t), p = pane(w.env, w.ws);
  const r = startOne(launch('codex', w.ws), p.run, {}, noPause, GATE);
  assert.ok(r.ok, r.line);
  const order = p.calls.map((c) => c.slice(0, 2).join(' ')).filter((c) => /^(tab create|pane process-info|pane run|pane wait-output|agent start|agent prompt)$/.test(c));
  assert.deepEqual(order, ['tab create', 'pane process-info', 'pane run', 'pane wait-output', 'agent start', 'agent prompt']);
  assert.ok(p.agent, 'the agent ran');
  assert.deepEqual(p.agent!.names.filter(isClaudeOnly), []);
  assert.ok(p.agent!.names.includes('CB_KEEP_ME'));
});

test('startOne, OpenCode: the password is made in the pane, reaches the agent, sits in a 0600 file, and is on no herdr argv', { skip: !bashOk && 'no bash' }, (t) => {
  const w = world(t), p = pane(w.env, w.ws);
  const r = startOne(launch('opencode', w.ws), p.run, {}, noPause, GATE);
  assert.ok(r.ok, r.line);
  const pw = p.agent!.password;
  assert.ok(pw && pw.length >= 24, 'the agent has a password');
  assert.ok(!herdrArgv(p.calls).includes(pw!), 'never on a herdr argv');
  assert.ok(!p.calls.some((c) => c.some((x) => /OPENCODE_SERVER_PASSWORD=/.test(x))), 'no --env for it');
  // the endpoint file the relay reads, in the shell's temp folder
  const file = join(p.agent!.tmp, opencodeEndpointPath('m', 'w9:p1').split(/[\\/]/).pop()!);
  t.after(() => rmSync(file, { force: true }));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).password, pw);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(p.agent!.names.filter(isClaudeOnly), []);
});

test('startOne fails closed: no guard, an untrusted agy folder, an unknown shell or no answer close the pane and start nothing', { skip: !bashOk && 'no bash' }, (t) => {
  const cases: [string, AgentKind, Parameters<typeof world>[1], string?, RegExp?][] = [
    ['codex without its hook', 'codex', { codexHook: false }, undefined, /no PreToolUse hook/],
    ['agy in a folder it has not trusted', 'agy', { agyTrusted: false }, undefined, /not trusted this folder/],
    ['opencode without its plugin', 'opencode', { plugin: false }, undefined, /no cb-guard plugin/],
    ['a fish pane', 'codex', {}, 'fish', /shell is "fish"/],
  ];
  for (const [what, agent, o, shell, why] of cases) {
    const w = world(t, o), p = pane(w.env, w.ws, shell);
    const r = startOne(launch(agent, w.ws), p.run, {}, noPause, GATE);
    assert.equal(r.ok, false, what);
    assert.match(r.line, why!, what);
    assert.ok(!p.calls.some((c) => c[0] === 'agent'), `${what}: no agent call`);
    assert.ok(p.calls.some((c) => c[0] === 'pane' && c[1] === 'close' && c[2] === 'w9:p1'), `${what}: its pane closed`);
  }
  // a prestart that never answers (wait-output times out)
  const w = world(t), p = pane(w.env, w.ws);
  const silent: Runner = (m, args, to) => (args[0] === 'pane' && args[1] === 'run' ? ok({}) : p.run(m, args, to));
  const r = startOne(launch('codex', w.ws), silent, {}, noPause, GATE);
  assert.equal(r.ok, false);
  assert.ok(!p.calls.some((c) => c[0] === 'agent'));
});

test('startOne, Claude: no prestart, the herdr call sequence is as before', () => {
  const calls: string[][] = [];
  const run: Runner = (_m, args) => { calls.push(args); return args[0] === 'tab' ? ok({ result: { pane: { pane_id: 'w9:p2' } } }) : ok({}); };
  assert.ok(startOne(launch('claude', '/w/x'), run, {}, noPause, GATE).ok);
  assert.deepEqual(calls.map((c) => c.slice(0, 2).join(' ')), ['tab create', 'agent start', 'agent prompt']);
});

test('the pane shell and the prestart line: pwsh and bash/zsh only, plain words only', () => {
  const info = (argv0: string) => ({ result: { process_info: { foreground_processes: [{ argv0 }] } } });
  assert.equal(paneShell(info('C:\\Program Files\\PowerShell\\7\\pwsh.exe')), 'pwsh');
  assert.equal(paneShell(info('/bin/zsh')), 'posix');
  assert.equal(paneShell(info('-zsh')), 'posix');
  assert.equal(paneShell(info('/usr/bin/fish')), 'fish');
  assert.equal(paneShell({}), '');
  assert.equal(prestartLine('posix', '/u/board/', ['opencode', 'macbook', 'w2:p3', 'abc', '41234']), ". '/u/board/kit/seat/prestart.sh' '/u/board' opencode macbook w2:p3 abc 41234");
  assert.equal(prestartLine('pwsh', 'C:/w/board', ['agy', 'shaltoot', 'w2:p3', 'abc']), ". 'C:/w/board/kit/seat/prestart.ps1' -Board 'C:/w/board' -Agent agy -Machine shaltoot -Pane w2:p3 -Nonce abc");
  assert.throws(() => prestartLine('posix', "/u/it's", ['codex', 'm', 'p', 'n']), /quote/);
  assert.throws(() => prestartLine('posix', '/u/b', ['codex', 'm; rm -rf ~', 'p', 'n']), /plain word/);
  assert.throws(() => prestartLine('pwsh', 'C:/b', ['codex', '-Board', 'p', 'n']), /plain word/, 'a leading - is a pwsh parameter name');
  assert.throws(() => prestartLine('pwsh', 'C:/it\u2019s', ['codex', 'm', 'p', 'n']), /quote/, 'pwsh reads a curly quote as a quote');
});

test('Codex input box (#4002): a trailing $word or @word gets a space so Enter submits; deliver and the first prompt use it', async () => {
  assert.equal(codexPromptText('deploy with $deploy'), 'deploy with $deploy ');
  assert.equal(codexPromptText('ask orch@shaltoot'), 'ask orch@shaltoot');
  assert.equal(codexPromptText('reply to @orch'), 'reply to @orch ');
  assert.equal(codexPromptText('$HOME is set, done'), '$HOME is set, done');
  assert.equal(codexPromptText('$x'), '$x ');
  assert.equal(codexPromptText('run $review\n'), 'run $review ', 'a trailing newline does not hide the word');
  const sent: string[][] = [];
  const a = createCodexAdapter((_m, args) => { sent.push(args); return { status: 0, stdout: '', stderr: '' }; });
  await a.deliver({ machine: 'm', pane: 'p', agent: 'codex', herdrName: 'demo-b1-m' }, 'run $review');
  assert.deepEqual(sent[0], ['agent', 'prompt', 'demo-b1-m', 'run $review ']);
  assert.equal(a.promptText?.('run $review'), 'run $review ');
});

test('startOne sends the first prompt through the adapter\'s promptText', { skip: !bashOk && 'no bash' }, (t) => {
  const w = world(t), p = pane(w.env, w.ws);
  assert.ok(startOne(launch('codex', w.ws, { prompt: 'cb iam x, then use $skill' }), p.run, {}, noPause, GATE).ok);
  assert.deepEqual(p.calls.find((c) => c[0] === 'agent' && c[1] === 'prompt')!.slice(3), ['cb iam x, then use $skill ']);
});

// #4551: the round-two follow-ups. 70-M2: the shim and the core.mjs it loads must be this board's kit/guard bytes (a
// lookalike folder, a link to a fake, or a real shim beside a fake core passed on names). 70-M3: a hook file that repeats
// a key in one object is refused (JSON.parse keeps the last; Codex may not). 70-M4: a selected profile turning hooks off
// refuses, and a multi-line string's text is never read as keys.
function seatWorld(t: { after: (fn: () => void) => void }) {
  const w = world(t), env = { ...w.env };
  for (const k of Object.keys(env)) if (isClaudeOnly(k)) delete env[k];
  const refusal = (agent: string) => seatRefusal(agent, 'm', 'w9:p1', seatEnv(env, agent), w.ws, w.home);
  return { ...w, env, refusal, codexFile: join(w.home, '.codex', 'hooks.json'), cfg: join(w.home, '.codex', 'config.toml'), agyFile: join(w.ws, '.agents', 'hooks.json') };
}

test('seatRefusal (70-M2): the shim and the core.mjs it loads must be this board\'s kit/guard bytes', (t) => {
  const w = seatWorld(t), kit = join(BOARD, 'kit', 'guard');
  const codexAt = (shim: string) => codexHooks([{ matcher: CODEX_MATCHER, hooks: [{ type: 'command', command: `${NODE} ${shim.replace(/\\/g, '/')}` }] }]);
  /** a folder holding shim (fake unless real) and core.mjs (fake unless realCore) */
  const folder = (name: string, shim: string, o: { real?: boolean; realCore?: boolean } = {}) => {
    const d = join(w.root, name);
    mkdirSync(d, { recursive: true });
    if (o.real) copyFileSync(join(kit, shim), join(d, shim)); else writeFileSync(join(d, shim), 'process.stdout.write("{}")\n');
    if (o.realCore) copyFileSync(join(kit, 'core.mjs'), join(d, 'core.mjs')); else writeFileSync(join(d, 'core.mjs'), 'export const evaluate = () => ({ allow: true });\n');
    return d;
  };
  assert.equal(w.refusal('codex'), null, 'the real shape passes');
  writeFileSync(w.codexFile, codexAt(join(folder('guаrd', 'shim-codex.mjs'), 'shim-codex.mjs')));
  assert.match(w.refusal('codex') ?? 'READY', /no PreToolUse hook/, 'a lookalike folder with a fake shim and core');
  writeFileSync(w.codexFile, codexAt(join(folder('fakecore', 'shim-codex.mjs', { real: true }), 'shim-codex.mjs')));
  assert.match(w.refusal('codex') ?? 'READY', /no PreToolUse hook/, 'the real shim beside a fake core');
  writeFileSync(w.codexFile, codexAt(join(folder('copy', 'shim-codex.mjs', { real: true, realCore: true }), 'shim-codex.mjs')));
  assert.equal(w.refusal('codex'), null, 'a byte-identical copy of the guard is the guard');
  // links: a junction folder always works on Windows; a file symlink may need a privilege there
  const fake = folder('fake', 'shim-codex.mjs');
  symlinkSync(fake, join(w.root, 'jfake'), 'junction');
  writeFileSync(w.codexFile, codexAt(join(w.root, 'jfake', 'shim-codex.mjs')));
  assert.match(w.refusal('codex') ?? 'READY', /no PreToolUse hook/, 'a junction to a fake folder');
  symlinkSync(kit, join(w.root, 'jreal'), 'junction');
  writeFileSync(w.codexFile, codexAt(join(w.root, 'jreal', 'shim-codex.mjs')));
  assert.equal(w.refusal('codex'), null, 'a junction to the real kit/guard');
  let fileLink = true;
  mkdirSync(join(w.root, 'flink'));
  try { symlinkSync(join(fake, 'shim-codex.mjs'), join(w.root, 'flink', 'shim-codex.mjs'), 'file'); } catch { fileLink = false; }
  if (fileLink) {
    copyFileSync(join(kit, 'core.mjs'), join(w.root, 'flink', 'core.mjs'));
    writeFileSync(w.codexFile, codexAt(join(w.root, 'flink', 'shim-codex.mjs')));
    assert.match(w.refusal('codex') ?? 'READY', /no PreToolUse hook/, 'a symlinked shim pointing at a fake, a real core beside the link');
  }
  writeFileSync(w.agyFile, JSON.stringify({ 'cb-guard': { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `node ${join(folder('agyfake', 'shim-agy.mjs'), 'shim-agy.mjs').replace(/\\/g, '/')}` }] }] } }));
  assert.match(w.refusal('agy') ?? 'READY', /no enabled PreToolUse hook/, 'a fake agy shim');

  // OpenCode: the plugin names a fake shim
  const plugin = join(w.home, '.config', 'opencode', 'plugins', 'cb-guard.js'), pw = 'synthetic-password-for-a-test', tmp = join(w.root, 'tmp');
  const withTmp = <T>(fn: () => T): T => {
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    Object.assign(process.env, { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
    try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  withTmp(() => writeOpencodeEndpoint('m', 'w9:p1', { port: 41234, password: pw }));
  const ocRefusal = () => withTmp(() => seatRefusal('opencode', 'm', 'w9:p1', seatEnv({ ...w.env, OPENCODE_SERVER_PASSWORD: pw }, 'opencode'), w.ws, w.home));
  assert.equal(ocRefusal(), null, 'the real plugin passes');
  writeFileSync(plugin, PLUGIN_GOOD.replace(`${BOARD}/kit/guard`, folder('ocfake', 'shim-opencode.mjs').replace(/\\/g, '/')));
  assert.match(ocRefusal() ?? 'READY', /does not register tool\.execute\.before/, 'a fake OpenCode shim');
});

test('seatRefusal (70-M3): a hook file that repeats a key in one object is refused, Codex and agy alike', (t) => {
  const w = seatWorld(t);
  // the good value last: JSON.parse keeps it, so the check passed while Codex may read the other or nothing
  const bad = JSON.stringify({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo off' }] }), good = JSON.stringify(CODEX_GOOD[0]);
  for (const [what, text] of [
    ['"hooks" twice', `{"hooks":{"PreToolUse":[${bad}]},"hooks":{"PreToolUse":[${good}]}}`],
    ['"PreToolUse" twice', `{"hooks":{"PreToolUse":[${bad}],"PreToolUse":[${good}]}}`],
    ['an escaped spelling of the same key', `{"hooks":{"PreToolUse":[${bad}],"PreTool\\u0055se":[${good}]}}`],
  ] as const) {
    writeFileSync(w.codexFile, text);
    assert.match(w.refusal('codex') ?? 'READY', /repeats the key/, what);
  }
  writeFileSync(w.codexFile, codexHooks(CODEX_GOOD));
  assert.equal(w.refusal('codex'), null, 'one hooks array per entry is no repeat');
  writeFileSync(w.agyFile, `{"cb-guard":${JSON.stringify(AGY_GOOD['cb-guard'])},"cb-guard":${JSON.stringify(AGY_GOOD['cb-guard'])}}`);
  assert.match(w.refusal('agy') ?? 'READY', /repeats the key/, 'agy: a group twice');
});

test('seatRefusal (70-M4): a Codex profile selected at the top that turns hooks off refuses; a multi-line string is text', (t) => {
  const w = seatWorld(t), on = '[features]\nhooks = true\n';
  for (const [what, toml] of [
    ['a selected profile off', `profile = "x"\n${on}[profiles.x.features]\nhooks = false\n`],
    ['a quoted profile name', `profile = 'x'\n${on}[profiles."x".features]\nhooks = false\n`],
    ['a dotted key', `profile = "x"\n${on}[profiles.x]\nfeatures.hooks = false\n`],
    ['an inline table', `profile = "x"\n${on}[profiles.x]\nfeatures = { hooks = false }\n`],
  ] as const) {
    writeFileSync(w.cfg, toml);
    assert.match(w.refusal('codex') ?? 'READY', /profile/, what);
  }
  for (const [what, toml] of [
    ['a profile off that nothing selects', `${on}[profiles.x.features]\nhooks = false\n`],
    ['profile after a table is that table\'s key', `${on}[tui]\nprofile = "x"\n[profiles.x.features]\nhooks = false\n`],
    ['hooks = false inside a multi-line string', `${on}[tui]\nnote = """\n[features]\nhooks = false\n"""\n`],
    ['a one-line triple-quoted string', `[features]\nx = """a"""\nhooks = true\n`],
    // PR 77 review M2: an array-of-tables header is a header; a triple quote inside a one-line string opens nothing
    ['an array of tables after [features]', `${on}[[hooks.extra]]\nhooks = false\n`],
    ['a triple quote inside a one-line string', `[tui]\nmsg = "it'''s"\nother = 'a """ b'\n${on}`],
  ] as const) {
    writeFileSync(w.cfg, toml);
    assert.equal(w.refusal('codex'), null, what);
  }
  writeFileSync(w.cfg, `[[hooks.extra]]\nx = 1\n[features]\nhooks = true\n[[profiles.y]]\nhooks = true\n`);
  assert.equal(w.refusal('codex'), null, 'keys after an array-of-tables header are that table\'s');
  writeFileSync(w.cfg, `[features]\n[[hooks.extra]]\nhooks = true\n`);
  assert.match(w.refusal('codex') ?? 'READY', /hooks = true/, 'hooks = true under [[hooks.extra]] is not [features]');
  // round 2 minor 3: a\""" is an escaped quote and "", so the string runs on and [features] below is its text
  writeFileSync(w.cfg, `[tui]\nnote = """\na\\"""\n[features]\nhooks = true\n"""\n`);
  assert.match(w.refusal('codex') ?? 'READY', /hooks = true/, 'an escaped quote before "" does not close the string');
  writeFileSync(w.cfg, `[tui]\nnote = '''\n[features]\nhooks = true\n'''\n`);
  assert.match(w.refusal('codex') ?? 'READY', /hooks = true/, 'hooks = true only inside a multi-line string');
});
