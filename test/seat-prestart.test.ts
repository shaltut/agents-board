// #4002 install gates on the launch path: a non-Claude seat's pane drops the Claude-only env from its real shell before
// the agent starts (herdr --env only adds), OpenCode's password is made in the pane and never rides on any argv, the seat
// is refused unless the guard will run (fails closed), Codex's input box gets text it can submit, and a Claude seat's
// launch is unchanged. Real shells and real node children; herdr is a fake that runs the typed lines in one shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paneShell, prestartLine, startOne, type Launch, type Runner } from '../cli/squad-up.ts';
import { ADAPTERS, type AgentKind } from '../cli/agents/index.ts';
import { CLAUDE_ONLY_ENV, isClaudeOnly } from '../cli/agents/env.ts';
import { codexPromptText, createCodexAdapter } from '../cli/agents/codex.ts';
import { opencodeEndpointPath } from '../cli/agents/opencode.ts';

const BOARD = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
// Plainly fake values: the names are what count, and no value is ever printed by a child.
const CANARY = { GITHUB_PERSONAL_ACCESS_TOKEN: 'not-a-token', CLAUDE_CODE_FAKE_SOCKET: 'fake', ANTHROPIC_FAKE_KEY: 'fake', anthropic_fake_lower: 'fake', CLAUDECODE: '1', CB_KEEP_ME: 'kept' };
const ALL: ReadonlySet<AgentKind> = new Set(['claude', 'codex', 'opencode', 'agy']);
const GATE = { installed: ALL, env: { CB_MCP_GATE_OK: 'codex,opencode,agy' } };
const noPause = () => {};
const shellOk = (sh: string) => { const r = spawnSync(sh, ['-c', 'env >/dev/null && echo ok'], { encoding: 'utf8' }); return r.status === 0 && r.stdout.trim() === 'ok'; };
const bashOk = shellOk('bash'), zshOk = shellOk('zsh');
const pwshOk = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

/** A home folder with the guard installed for every agent, and a seat folder agy trusts (unless told otherwise). */
function world(t: { after: (fn: () => void) => void }, o: { codexHook?: boolean; agyTrusted?: boolean; plugin?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cb-prestart-')), home = join(root, 'home'), ws = join(root, 'ws'), tmp = join(root, 'tmp');
  for (const d of [home, ws, tmp, join(home, '.codex'), join(home, '.gemini', 'antigravity-cli'), join(home, '.config', 'opencode', 'plugins'), join(ws, '.agents')]) mkdirSync(d, { recursive: true });
  if (o.codexHook !== false) writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: `node ${BOARD}/kit/guard/shim-codex.mjs` }] }] } }));
  writeFileSync(join(ws, '.agents', 'hooks.json'), JSON.stringify({ 'cb-guard': { PreToolUse: [{ command: `node ${BOARD}/kit/guard/shim-agy.mjs` }] } }));
  writeFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ trustedWorkspaces: o.agyTrusted === false ? [root] : [join(root, 'elsewhere'), ws] }));
  if (o.plugin !== false) writeFileSync(join(home, '.config', 'opencode', 'plugins', 'cb-guard.js'), '// test plugin\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = { ...process.env, ...CANARY, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  for (const k of ['CODEX_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_SERVER_PASSWORD']) delete env[k];
  return { root, home, ws, env };
}

const ok = (o: unknown) => ({ status: 0, stdout: JSON.stringify(o), stderr: '' });
/** herdr, faked: one pane whose shell is a real bash; every typed line (pane run, then the agent) runs in that one shell. */
function pane(env: Record<string, string | undefined>, cwd: string, shell = 'bash') {
  const calls: string[][] = [], typed: string[] = [];
  let out = '', agent: { names: string[]; password: string | null; tmp: string } | null = null;
  const sh = (script: string) => spawnSync('bash', ['-c', script], { env: env as NodeJS.ProcessEnv, cwd, encoding: 'utf8' });
  const run: Runner = (_m, args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'tab' && b === 'create') return ok({ result: { pane: { pane_id: 'w9:p1' } } });
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
    const r = spawnSync(sh, ['-c', `${prestartLine('posix', BOARD, ['codex', 'm', 'w9:p1', 'n0nce1'])}\nnode -e "process.stdout.write('NAMES ' + Object.keys(process.env).join(','))"`], { env: w.env as NodeJS.ProcessEnv, cwd: w.ws, encoding: 'utf8' });
    assert.match(r.stdout, /^cb-seat-ready:n0nce1$/m, r.stdout + r.stderr);
    const names = r.stdout.slice(r.stdout.indexOf('NAMES ') + 6).split(',');
    assert.deepEqual(names.filter(isClaudeOnly), []);
    assert.ok(names.includes('CB_KEEP_ME'));
  });
}

test('prestart.ps1 in a real pwsh: the same', { skip: !pwshOk && 'no pwsh' }, (t) => {
  const w = world(t);
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', `${prestartLine('pwsh', BOARD, ['codex', 'm', 'w9:p1', 'n0nce2'])}; node -e "process.stdout.write('NAMES ' + Object.keys(process.env).join(','))"`], { env: w.env as NodeJS.ProcessEnv, cwd: w.ws, encoding: 'utf8' });
  assert.match(r.stdout, /^cb-seat-ready:n0nce2$/m, r.stdout + r.stderr);
  const names = r.stdout.slice(r.stdout.indexOf('NAMES ') + 6).split(',');
  assert.deepEqual(names.filter(isClaudeOnly), []);
  assert.ok(names.includes('CB_KEEP_ME'));
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
});

test('Codex input box (#4002): a trailing $word or @word gets a space so Enter submits; deliver and the first prompt use it', async () => {
  assert.equal(codexPromptText('deploy with $deploy'), 'deploy with $deploy ');
  assert.equal(codexPromptText('ask orch@shaltoot'), 'ask orch@shaltoot');
  assert.equal(codexPromptText('reply to @orch'), 'reply to @orch ');
  assert.equal(codexPromptText('$HOME is set, done'), '$HOME is set, done');
  assert.equal(codexPromptText('$x'), '$x ');
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
