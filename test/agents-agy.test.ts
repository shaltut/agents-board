// The agy adapter (#4002 phase 5): launch argv and env, model checks, delivery and close through a fake herdr Runner,
// status, liveness, quota stops, and every spec method. Pure: no DB, no herdr, no agy.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { ADAPTERS, AGENT_KINDS, defaultModelFor, getAdapter } from '../cli/agents/index.ts';
import { agyAdapter, checkAgyModel, createAgyAdapter } from '../cli/agents/agy.ts';
import type { LaunchInput, SeatHandle } from '../cli/agents/types.ts';
import type { Runner } from '../cli/squad-up.ts';

const input = (extra: Partial<LaunchInput> = {}): LaunchInput =>
  ({ name: 'demo-B1@m', role: 'builder', repo: 'main', agent: 'agy', model: 'gemini-4-neon-xhigh', board: 'C:/w/board//', cwd: 'C:/w/x', ...extra });
const seat = (extra: Partial<SeatHandle> = {}): SeatHandle => ({ machine: 'm', pane: 'p1', agent: 'agy', herdrName: 'demo-B1@m', herdr: null, ...extra });
type Call = { m: string | null; args: string[]; timeout?: number };
function fake(res: { status: number | null; stderr?: string; stdout?: string; error?: Error } = { status: 0 }) {
  const calls: Call[] = [];
  const run: Runner = (m, args, timeout) => { calls.push({ m, args, timeout }); return res; };
  return { calls, adapter: createAgyAdapter(run), run };
}

test('registry: agy is registered and is the adapter this file builds', () => {
  assert.equal(ADAPTERS.agy, agyAdapter);
  assert.throws(() => getAdapter('agy', { env: {} }), /agent "agy" cannot start a seat with MCP off/); // installed (#4585), behind its MCP gate
  assert.equal(getAdapter('agy', { env: { CB_MCP_GATE_OK: 'agy' } }), ADAPTERS.agy);
  assert.ok(AGENT_KINDS.includes('agy'));
  assert.equal(agyAdapter.kind, 'agy');
  assert.equal(agyAdapter.relayStart, 'pane-prestart');
  assert.equal(defaultModelFor('agy', 'builder'), null); // cb._role_model returns null for a non-Claude agent
});

test('buildLaunch (Q3023): no sandbox and no asking like a Claude seat, this session only settings, the model', () => {
  const l = agyAdapter.buildLaunch(input());
  assert.deepEqual(l.args, ['--dangerously-skip-permissions', '--settings', 'C:/w/board/kit/agy/settings.json', '--model', 'gemini-4-neon-xhigh']);
  assert.equal(l.kind, 'agy');
  assert.ok(!l.args.includes('--sandbox') && !l.args.includes('--mode'));
  assert.deepEqual(l.env, { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', EDITOR: 'true', VISUAL: 'true', PAGER: 'cat', GIT_PAGER: 'cat', GH_PAGER: 'cat', MANPAGER: 'cat', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }); // PR 104 review B3
});

test('mcpOff (#4392): agy has no per-run MCP off, so nothing is added and the gate names mcp_config.json and plugins', () => {
  const m = agyAdapter.mcpOff('C:/w/board');
  assert.deepEqual([m.args, m.env], [[], {}]);
  assert.match(agyAdapter.mcpGate ?? '', /mcp_config\.json/);
  assert.match(agyAdapter.mcpGate ?? '', /plugin/);
});

test('buildLaunch: env keeps the squad env, adds the auto-update pin, strips Claude-only secrets and markers (any case)', () => {
  const l = agyAdapter.buildLaunch(input({ env: {
    CB_ROLE: 'builder', CB_AGENT: 'agy', CB_PROTECTED_BRANCHES: 'main,release/*',
    GITHUB_PERSONAL_ACCESS_TOKEN: 'x', github_personal_access_token: 'x',
    CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't', claude_code_entrypoint: 'e', CLAUDECODE: '1', claudecode: '1',
    ANTHROPIC_API_KEY: 'k', anthropic_base_url: 'u', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPICAL: 'keep-not-prefix',
  } }));
  assert.deepEqual(l.env, { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', EDITOR: 'true', VISUAL: 'true', PAGER: 'cat', GIT_PAGER: 'cat', GH_PAGER: 'cat', MANPAGER: 'cat', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', CB_ROLE: 'builder', CB_AGENT: 'agy', CB_PROTECTED_BRANCHES: 'main,release/*', ANTHROPICAL: 'keep-not-prefix', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
});

test('buildLaunch: an empty model passes no --model; a Claude alias or a bad id throws', () => {
  assert.ok(!agyAdapter.buildLaunch(input({ model: '' })).args.includes('--model'));
  for (const m of ['opus', 'Sonnet', 'haiku', 'fable']) assert.throws(() => agyAdapter.buildLaunch(input({ model: m })), /Claude alias/);
  for (const m of ['-x', 'a b', 'a/b', 'a;b', 'x'.repeat(65), '.hidden']) assert.throws(() => checkAgyModel(m), /is not an id/, m);
  for (const m of ['gemini-4-neon-xhigh', 'claude-opus-5-5-medium', 'Orchestrator', 'gemini-pro-orchestrator', 'x'.repeat(64)]) assert.doesNotThrow(() => checkAgyModel(m), m);
});

test('deliver: herdr agent prompt on the seat\'s machine, text verbatim', async () => {
  const f = fake();
  await f.adapter.deliver(seat({ herdr: 'macbook' }), 'line one\nline two');
  assert.deepEqual(f.calls, [{ m: 'macbook', args: ['agent', 'prompt', 'demo-B1@m', 'line one\nline two'], timeout: 30_000 }]);
});

test('deliver: the text goes verbatim, a leading - or / included; opts.raw changes nothing', async () => {
  const f = fake();
  await f.adapter.deliver(seat(), '--flag-like');
  await f.adapter.deliver(seat(), '/exit now');
  await f.adapter.deliver(seat(), 'plain', { raw: true });
  await f.adapter.deliver(seat(), 'plain', { raw: false });
  assert.deepEqual(f.calls.map((c) => c.args), [
    ['agent', 'prompt', 'demo-B1@m', '--flag-like'], ['agent', 'prompt', 'demo-B1@m', '/exit now'],
    ['agent', 'prompt', 'demo-B1@m', 'plain'], ['agent', 'prompt', 'demo-B1@m', 'plain']]);
});

test('deliver: no herdr name or a failure throws', async () => {
  const f = fake();
  await assert.rejects(f.adapter.deliver(seat({ herdrName: undefined }), 'hi'), /no herdr agent name/);
  const blocked = fake({ status: 1, stderr: 'agent_blocked: the agent waits on an approval\n' });
  await assert.rejects(blocked.adapter.deliver(seat(), 'hi'), /herdr agent prompt failed: agent_blocked/);
  const dead = fake({ status: null, error: new Error('spawn herdr ENOENT') });
  await assert.rejects(dead.adapter.deliver(seat(), 'hi'), /spawn herdr ENOENT/);
});

test('close: sends /exit through herdr; failure, an error, or no name is failed', async () => {
  const f = fake();
  assert.equal(await f.adapter.close(seat({ herdr: 'vps2' }), f.run), 'sent');
  assert.deepEqual(f.calls[0], { m: 'vps2', args: ['agent', 'prompt', 'demo-B1@m', '/exit'], timeout: 30_000 });
  assert.equal(await fake({ status: 1 }).adapter.close(seat(), fake({ status: 1 }).run), 'failed');
  const e = fake({ status: 0, error: new Error('x') });
  assert.equal(await e.adapter.close(seat(), e.run), 'failed');
  assert.equal(await f.adapter.close(seat({ herdrName: undefined }), f.run), 'failed');
});

test('isAlive: agent get exit 0 is alive, agent_not_found is gone, anything else counts as alive', async () => {
  assert.equal(await fake({ status: 0 }).adapter.isAlive(seat()), true);
  assert.equal(await fake({ status: 1, stderr: 'error: agent_not_found: demo' }).adapter.isAlive(seat()), false);
  assert.equal(await fake({ status: 1, stderr: 'something else' }).adapter.isAlive(seat()), true);
  assert.equal(await fake({ status: null, error: new Error('timeout') }).adapter.isAlive(seat()), true);
  assert.equal(await fake().adapter.isAlive(seat({ herdrName: undefined })), true);
  const f = fake(); await f.adapter.isAlive(seat({ herdr: 'macbook' }));
  assert.deepEqual(f.calls[0].args, ['agent', 'get', 'demo-B1@m']);
  assert.equal(f.calls[0].m, 'macbook');
});

test('readStatus: herdr states map through; only idle and done are safe to close; anything else is unknown', async () => {
  for (const [s, safe] of [['idle', true], ['done', true], ['working', false], ['blocked', false]] as const) {
    const r = await agyAdapter.readStatus(seat(), { agent_status: s });
    assert.equal(r.state, s); assert.equal(r.safeToClose, safe, s);
  }
  for (const h of [null, {}, { agent_status: 'weird' }]) assert.deepEqual(await agyAdapter.readStatus(seat(), h), { state: 'unknown', safeToClose: false, detail: undefined });
  assert.match((await agyAdapter.readStatus(seat(), { agent_status: 'idle' })).detail ?? '', /background/);
});

test('detectQuotaStop: real-looking banner text at the tail', () => {
  const q = (t: string) => agyAdapter.detectQuotaStop(seat(), null, t);
  assert.deepEqual(q('  some output\n  You have exhausted your quota on this model.\n  > '), { kind: 'quota', raw: 'exhausted your quota on this model' });
  assert.equal(q('AI: Out of credits')?.kind, 'quota');
  assert.equal(q("Your organization's prepaid balance is insufficient. Contact your administrator to add funds")?.kind, 'quota');
  assert.deepEqual(q('rate limit active for gemini-4-neon; retry in 42s.'), { kind: 'rate_limit', raw: 'rate limit active for gemini-4-neon', retryAfterSec: 42 });
  assert.equal(q('429 Too Many Requests')?.kind, 'rate_limit');
  assert.equal(q('Error: RESOURCE_EXHAUSTED: try later')?.kind, 'rate_limit');
  assert.equal(agyAdapter.detectQuotaStop(seat(), null, undefined), null);
  assert.equal(agyAdapter.detectQuotaStop(seat(), null, ''), null);
});

test('detectQuotaStop: the agent\'s own output is not a stop (a 429 or "rate limit" in normal output, banner text far above the tail)', () => {
  const q = (t: string) => agyAdapter.detectQuotaStop(seat(), null, t);
  assert.equal(q('quota exhausted? no: all fine, 200 files read'), null);
  assert.equal(q('Thinking... 12s'), null);
  assert.equal(q('grep found 429 matches in 12 files\nthe rate limit docs say 60/min\nI am out of credits for jokes\n? for shortcuts'), null);
  assert.equal(q('const RETRY = 429; // status code for a rate limit\nexpect(res.status).toBe(429)\n> '), null);
  const old = 'You have exhausted your quota on this model.\n' + Array.from({ length: 8 }, (_, i) => `later output line ${i}`).join('\n');
  assert.equal(q(old), null);
});

test('guardInstallSpec: a per-seat workspace file (never the global hooks.json), this shim, a catch-all matcher', () => {
  const g = agyAdapter.guardInstallSpec('C:/w/board/', 'win32');
  assert.equal(g.targetPath, '.agents/hooks.json');
  assert.ok(!g.targetPath.includes('.gemini'));
  assert.equal(g.shimFile, 'C:/w/board/kit/guard/shim-agy.mjs');
  for (const p of ['win32', 'darwin', 'linux'] as const) assert.equal(g.matchers[p], '.*');
  assert.match(g.notes, /\{"decision":"allow"\}/);
  assert.match(g.notes, /excluded from git/);
});

test('instructionMapping, trustSpec, disableAskSpec', () => {
  const m = agyAdapter.instructionMapping(input());
  assert.ok(m.nativeFiles.includes('AGENTS.md') && m.nativeFiles.includes('GEMINI.md'));
  assert.ok(!m.nativeFiles.some((f) => /CLAUDE\.md/.test(f)));
  assert.deepEqual([m.extraArgs, m.env], [[], {}]);
  assert.match(m.note, /does not read CLAUDE\.md/);
  const { preseed, ...t } = agyAdapter.trustSpec(['C:/w/x'], 'win32');
  assert.deepEqual(t, { dialogHint: 'Do you trust the contents of this project?', preseedPath: '~/.gemini/antigravity-cli/settings.json', extraArgs: [] });
  assert.equal(preseed?.file, '.gemini/antigravity-cli/settings.json'); // #4575: cb squad trust writes it
  assert.deepEqual(agyAdapter.disableAskSpec(), { toolName: 'ask_question', mechanism: 'hook', target: 'kit/guard/shim-agy.mjs' });
});

test('import order: agy.ts loaded first (not through index.ts) and squad-up.ts loaded first both work, in a fresh process', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const [first, then] of [['cli/agents/agy.ts', 'cli/squad-up.ts'], ['cli/squad-up.ts', 'cli/agents/agy.ts'], ['cli/agents/index.ts', 'cli/squad-up.ts']]) {
    const code = `const a = await import(${JSON.stringify(pathToFileURL(root + first).href)}); const b = await import(${JSON.stringify(pathToFileURL(root + then).href)});` +
      ` const { ADAPTERS } = await import(${JSON.stringify(pathToFileURL(root + 'cli/agents/index.ts').href)}); console.log(ADAPTERS.agy.kind, typeof ADAPTERS.agy.deliver);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${first} then ${then}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'agy function');
  }
});
