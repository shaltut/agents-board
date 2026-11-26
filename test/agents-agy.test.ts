// The agy adapter (#4002 phase 5): launch argv and env, model checks, delivery and close through a fake herdr Runner,
// status, liveness, quota stops, and every spec method. Pure: no DB, no herdr, no agy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_KINDS, defaultModelFor, getAdapter } from '../cli/agents/index.ts';
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
  assert.equal(getAdapter('agy'), agyAdapter);
  assert.ok(AGENT_KINDS.includes('agy'));
  assert.equal(agyAdapter.kind, 'agy');
  assert.equal(agyAdapter.relayStart, 'pane-prestart');
  assert.equal(defaultModelFor('agy', 'builder'), null); // cb._role_model returns null for a non-Claude agent
});

test('buildLaunch: --mode auto, this session only settings, the model; never --dangerously-skip-permissions', () => {
  const l = agyAdapter.buildLaunch(input());
  assert.deepEqual(l.args, ['--mode', 'auto', '--settings', 'C:/w/board/kit/agy/settings.json', '--model', 'gemini-4-neon-xhigh']);
  assert.equal(l.kind, 'agy');
  assert.ok(!l.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(l.env, { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
});

test('buildLaunch: env keeps the squad env, adds the auto-update pin, strips Claude-only secrets (any case)', () => {
  const l = agyAdapter.buildLaunch(input({ env: {
    CB_ROLE: 'builder', CB_AGENT: 'agy', CB_PROTECTED_BRANCHES: 'main,release/*',
    GITHUB_PERSONAL_ACCESS_TOKEN: 'x', github_personal_access_token: 'x',
    CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't', claude_code_entrypoint: 'e', CLAUDECODE: 'keep-not-prefix',
  } }));
  assert.deepEqual(l.env, { CB_ROLE: 'builder', CB_AGENT: 'agy', CB_PROTECTED_BRANCHES: 'main,release/*', CLAUDECODE: 'keep-not-prefix', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
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

test('deliver: a text starting with - or / gets one leading space; no herdr name or a failure throws', async () => {
  const f = fake();
  await f.adapter.deliver(seat(), '--flag-like');
  await f.adapter.deliver(seat(), '/exit now');
  assert.deepEqual(f.calls.map((c) => c.args[3]), [' --flag-like', ' /exit now']);
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

test('detectQuotaStop: real-looking pane text', () => {
  const q = (t: string) => agyAdapter.detectQuotaStop(seat(), null, t);
  assert.deepEqual(q('  some output\n  You have exhausted your quota on this model.\n  > '), { kind: 'quota', raw: 'exhausted your quota on this model' });
  assert.equal(q('AI: Out of credits')?.kind, 'quota');
  assert.equal(q("Your organization's prepaid balance is insufficient. Contact your administrator to add funds")?.kind, 'quota');
  assert.deepEqual(q('rate limit active for gemini-4-neon; retry in 42s.'), { kind: 'rate_limit', raw: 'rate limit active for', retryAfterSec: 42 });
  assert.equal(q('429 Too Many Requests')?.kind, 'rate_limit');
  assert.equal(q('RESOURCE_EXHAUSTED: try later')?.kind, 'rate_limit');
  assert.equal(q('quota exhausted? no: all fine, 200 files read'), null);
  assert.equal(q('Thinking... 12s'), null);
  assert.equal(agyAdapter.detectQuotaStop(seat(), null, undefined), null);
  assert.equal(agyAdapter.detectQuotaStop(seat(), null, ''), null);
});

test('guardInstallSpec: the global hooks file, this shim, one matcher for every platform', () => {
  const g = agyAdapter.guardInstallSpec('C:/w/board/', 'win32');
  assert.equal(g.targetPath, '~/.gemini/config/hooks.json');
  assert.equal(g.shimFile, 'C:/w/board/kit/guard/shim-agy.mjs');
  assert.equal(g.matchers.win32, g.matchers.darwin);
  assert.equal(g.matchers.win32, g.matchers.linux);
  for (const t of ['run_command', 'write_file', 'edit_file', 'ask_question']) assert.match(t, new RegExp(`^(?:${g.matchers.win32})$`));
  assert.doesNotMatch('view_file', new RegExp(`^(?:${g.matchers.win32})$`));
  assert.match(g.notes, /\{"decision":"allow"\}/);
});

test('instructionMapping, trustSpec, disableAskSpec', () => {
  const m = agyAdapter.instructionMapping(input());
  assert.ok(m.nativeFiles.includes('AGENTS.md') && m.nativeFiles.includes('GEMINI.md'));
  assert.ok(!m.nativeFiles.some((f) => /CLAUDE\.md/.test(f)));
  assert.deepEqual([m.extraArgs, m.env], [[], {}]);
  assert.match(m.note, /does not read CLAUDE\.md/);
  assert.deepEqual(agyAdapter.trustSpec(['C:/w/x'], 'win32'), { dialogHint: 'Do you trust the contents of this project?', preseedPath: '~/.gemini/antigravity-cli/settings.json', extraArgs: [] });
  assert.deepEqual(agyAdapter.disableAskSpec(), { toolName: 'ask_question', mechanism: 'hook', target: 'kit/guard/shim-agy.mjs' });
});
