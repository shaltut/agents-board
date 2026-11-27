// The Codex adapter (#4002 phase 2): launch argv and env, model checks, herdr-backed deliver/isAlive/close, quota text, specs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexAdapter, codexModelProblem, createCodexAdapter } from '../cli/agents/codex.ts';
import { READ_ONLY_ROLES } from '../kit/guard/core.mjs';
import { HANDLED_TOOLS, parseCodexInput } from '../kit/guard/shim-codex.mjs';
import { ADAPTERS, defaultModelFor, getAdapter } from '../cli/agents/index.ts';
import type { LaunchInput, SeatHandle } from '../cli/agents/types.ts';

type Call = [string | null, string[], number | undefined];
const recorder = (res: { status: number | null; stderr?: string; error?: Error } = { status: 0 }) => {
  const calls: Call[] = [];
  return { calls, run: (m: string | null, a: string[], t?: number) => { calls.push([m, a, t]); return res; } };
};
const seat = (extra: Partial<SeatHandle> = {}): SeatHandle => ({ machine: 'testbox', pane: 'p1', herdrName: 'demo-b1-m', agent: 'codex', ...extra });
const input = (extra: Partial<LaunchInput> = {}): LaunchInput =>
  ({ name: 'demo-B1@m', role: 'builder', repo: 'main', agent: 'codex', model: 'gpt-5.1-codex', board: 'C:/w/board', cwd: 'C:/w/x', ...extra });

test('registry: codex resolves to the codex adapter; its default model is null (cb._role_model gives none for non-Claude)', () => {
  assert.equal(ADAPTERS.codex, codexAdapter);
  assert.throws(() => getAdapter('codex'), /agent "codex" is not installed yet/); // listed, not installed until wired
  assert.equal(codexAdapter.kind, 'codex');
  assert.equal(codexAdapter.relayStart, 'pane-prestart');
  for (const r of ['builder', 'lead', 'reviewer']) assert.equal(defaultModelFor('codex', r), null);
});

test('buildLaunch: --no-daemon first, model, never ask, workspace-write for a builder, exact argv', () => {
  assert.deepEqual(codexAdapter.buildLaunch(input({ env: { CB_ROLE: 'builder', CB_AGENT: 'codex' } })), {
    kind: 'codex',
    args: ['--no-daemon', '-m', 'gpt-5.1-codex', '-a', 'never', '--dangerously-bypass-hook-trust', '-s', 'workspace-write',
      '-c', 'sandbox_workspace_write.network_access=true',
      '-c', "shell_environment_policy.exclude=['GITHUB_PERSONAL_ACCESS_TOKEN','CLAUDE_CODE_*','ANTHROPIC_*','CLAUDECODE']",
      '--disable', 'plugins', '--disable', 'apps', '--disable', 'skill_mcp_dependency_install',
      '-c', 'check_for_update_on_startup=false',
      '-c', "project_doc_fallback_filenames=['CLAUDE.md']"],
    env: { CB_ROLE: 'builder', CB_AGENT: 'codex' },
    prestart: { args: [] },
  });
});

test('mcpOff (#4392): plugin, connector and skill-install MCP off per run; config.toml servers are an install gate', () => {
  const m = codexAdapter.mcpOff('C:/w/board');
  assert.deepEqual([m.args, m.env], [['--disable', 'plugins', '--disable', 'apps', '--disable', 'skill_mcp_dependency_install'], {}]);
  assert.match(codexAdapter.mcpGate ?? '', /\[mcp_servers\]/);
  assert.match(codexAdapter.mcpGate ?? '', /merges/);
  for (const role of ['builder', 'reviewer']) {
    const a = codexAdapter.buildLaunch(input({ role })).args.join('\u0000');
    assert.ok(a.includes(m.args.join('\u0000')), role);
  }
});

test('buildLaunch: reviewer, qa and investigator get a read-only sandbox and no network opening; other roles workspace-write', () => {
  for (const role of ['reviewer', 'qa', 'investigator']) {
    const a = codexAdapter.buildLaunch(input({ role })).args;
    assert.equal(a[a.indexOf('-s') + 1], 'read-only', role);
    assert.ok(!a.some((x) => x.startsWith('sandbox_workspace_write')), role);
  }
  for (const role of ['lead', 'architect', 'owner', 'builder']) {
    const a = codexAdapter.buildLaunch(input({ role })).args;
    assert.equal(a[a.indexOf('-s') + 1], 'workspace-write', role);
  }
});

// #4002 install gate: untrusted hooks never run (Esc on Hooks need review goes on without them), so the launch runs the
// installed hooks without the trust step; the prestart refuses a seat whose hooks.json has no guard entry
test('buildLaunch: never answers a dialog, always runs the installed hooks (no trust step to skip), no Claude flags', () => {
  const a = codexAdapter.buildLaunch(input()).args;
  assert.equal(a[0], '--no-daemon');
  assert.ok(a.includes('--dangerously-bypass-hook-trust'));
  for (const bad of ['--dangerously-bypass-approvals-and-sandbox', '--permission-mode', '--settings', '--approve-for-me', '-p'])
    assert.ok(!a.includes(bad), bad);
});

test('buildLaunch: GITHUB_PERSONAL_ACCESS_TOKEN, CLAUDE_CODE_*, ANTHROPIC_* and CLAUDECODE are dropped from the env (any case); others pass', () => {
  const env = codexAdapter.buildLaunch(input({ env: {
    GITHUB_PERSONAL_ACCESS_TOKEN: 'x', github_personal_access_token: 'x', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't',
    ANTHROPIC_BASE_URL: 'u', anthropic_api_key: 'k', CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'e', CB_ROLE: 'builder', CB_PROTECTED_BRANCHES: 'main,develop', CLAUDE_BOARD_URL: 'keep' } })).env;
  assert.deepEqual(env, { CB_ROLE: 'builder', CB_PROTECTED_BRANCHES: 'main,develop', CLAUDE_BOARD_URL: 'keep' });
  assert.deepEqual(codexAdapter.buildLaunch(input()).env, {});
});

test('buildLaunch: an empty model leaves -m out (Codex uses its own default); Claude names and bad names throw', () => {
  const a = codexAdapter.buildLaunch(input({ model: '' })).args;
  assert.ok(!a.includes('-m'));
  for (const m of ['opus', 'sonnet', 'haiku', 'fable', 'Opus', 'FABLE']) assert.throws(() => codexAdapter.buildLaunch(input({ model: m })), /Claude model name/, m);
  for (const m of ['openai/gpt-5', 'gpt 5', '-gpt', 'gpt;rm', 'x'.repeat(65)]) assert.throws(() => codexAdapter.buildLaunch(input({ model: m })), /not a Codex model name/, m);
  assert.equal(codexModelProblem('gpt-5.1-codex'), null);
  assert.equal(codexModelProblem('o4-mini'), null);
  assert.equal(codexModelProblem(''), null);
});

test('deliver: herdr agent prompt on the seat machine with the text, 15 s cap; the text is never in an error', async () => {
  const { calls, run } = recorder();
  await createCodexAdapter(run).deliver(seat({ herdr: 'macbook' }), 'line one\nline two');
  assert.deepEqual(calls, [['macbook', ['agent', 'prompt', 'demo-b1-m', 'line one\nline two'], 15_000]]);
  const fail = recorder({ status: 1, stderr: 'agent_blocked: a dialog is open' });
  await assert.rejects(createCodexAdapter(fail.run).deliver(seat(), 'SECRET-BODY'), (e: Error) => /agent_blocked/.test(e.message) && !/SECRET-BODY/.test(e.message));
  const boom = recorder({ status: null, error: new Error('spawn herdr ENOENT') });
  await assert.rejects(createCodexAdapter(boom.run).deliver(seat(), 'x'), /ENOENT/);
  await assert.rejects(createCodexAdapter(run).deliver(seat({ herdrName: undefined }), 'x'), /no herdr name/);
});

test('isAlive: exit 0 live, agent_not_found dead, anything else counts as alive, no herdr name dead', async () => {
  const r = (res: { status: number | null; stderr?: string; error?: Error }) => createCodexAdapter(recorder(res).run);
  assert.equal(await r({ status: 0 }).isAlive(seat()), true);
  assert.equal(await r({ status: 1, stderr: 'error: agent_not_found' }).isAlive(seat()), false);
  assert.equal(await r({ status: 1, stderr: 'something else' }).isAlive(seat()), true);
  assert.equal(await r({ status: null, error: new Error('timeout') }).isAlive(seat()), true);
  assert.equal(await r({ status: 0 }).isAlive(seat({ herdrName: undefined })), false);
  const { calls, run } = recorder();
  await createCodexAdapter(run).isAlive(seat({ herdr: 'vps2' }));
  assert.deepEqual(calls, [['vps2', ['agent', 'get', 'demo-b1-m'], 10_000]]);
});

test('readStatus: idle and done are safe to close; working, blocked (a dialog), unknown are not', async () => {
  for (const [s, state, safe] of [['idle', 'idle', true], ['done', 'done', true], ['working', 'working', false], ['blocked', 'blocked', false], ['weird', 'unknown', false]] as const)
    assert.deepEqual(await codexAdapter.readStatus(seat(), { agent_status: s }), { state, safeToClose: safe }, s);
  assert.deepEqual(await codexAdapter.readStatus(seat(), null), { state: 'unknown', safeToClose: false });
});

test('close: /exit through herdr agent prompt; failed without a name or on a non-zero exit', async () => {
  const { calls, run } = recorder();
  assert.equal(await codexAdapter.close(seat({ herdr: 'macbook' }), run), 'sent');
  assert.deepEqual(calls, [['macbook', ['agent', 'prompt', 'demo-b1-m', '/exit'], 30_000]]);
  assert.equal(await codexAdapter.close(seat({ herdrName: undefined }), run), 'failed');
  assert.equal(await codexAdapter.close(seat(), recorder({ status: 1 }).run), 'failed');
  assert.equal(await codexAdapter.close(seat(), recorder({ status: null, error: new Error('x') }).run), 'failed');
});

test('detectQuotaStop: real Codex limit text is a quota stop; a normal tail is not', () => {
  const q = (tail?: string) => codexAdapter.detectQuotaStop(seat(), null, tail);
  const hit = "■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again in 2 hours 5 minutes.";
  assert.deepEqual(q(`gpt-5.1-codex · ~/w/x\n${hit}\n`), { kind: 'quota', raw: hit.slice(2), retryAfterSec: 2 * 3600 + 5 * 60 });
  assert.equal(q("You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits")?.kind, 'quota');
  assert.equal(q("You’ve hit your usage limit. Try again at 3:42 PM.")?.retryAfterSec, undefined);
  assert.equal(q('Your workspace is out of credits. Add credits to continue.')?.kind, 'quota');
  assert.deepEqual(q('Automatically switched to gpt-5.1-codex-mini due to usage limits.'), { kind: 'rate_limit', raw: 'Automatically switched to gpt-5.1-codex-mini due to usage limits' });
  assert.equal(q('exceeded retry limit, last status: 429 Too Many Requests')?.kind, 'rate_limit');
  assert.equal(q('I added a rate limit to the client and the tests pass.'), null);
  assert.equal(q(''), null);
  assert.equal(q(undefined), null);
});

test('guardInstallSpec: ~/.codex/hooks.json, shim-codex.mjs under the board, matcher per platform', () => {
  const g = codexAdapter.guardInstallSpec('C:/w/board//', 'win32');
  assert.equal(g.targetPath, '~/.codex/hooks.json');
  assert.equal(g.shimFile, 'C:/w/board/kit/guard/shim-codex.mjs');
  assert.equal(g.matchers.win32, '^(Bash|PowerShell|apply_patch|Edit|Write|request_user_input)$');
  assert.equal(g.matchers.darwin, '^(Bash|apply_patch|Edit|Write|request_user_input)$');
  assert.equal(g.matchers.linux, g.matchers.darwin);
  assert.match(g.notes, /Hooks need review/);
  assert.match(g.notes, /never edit that one/);
  assert.match(g.notes, /never guarded/);
});

test('matcher and shim agree: every tool the shim judges matches (PowerShell only on win32); the matcher names nothing the shim calls unknown', () => {
  const g = codexAdapter.guardInstallSpec('C:/w/board', 'win32');
  for (const [platform, m] of Object.entries(g.matchers)) {
    const re = new RegExp(m);
    for (const t of HANDLED_TOOLS) assert.equal(re.test(t), platform === 'win32' || t !== 'PowerShell', `${platform} ${t}`);
    for (const t of m.slice(2, -2).split('|')) {
      assert.equal(parseCodexInput(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: t, tool_input: { command: 'ls' } })).ok, true, `${platform} names ${t}, the shim must judge it`);
    }
    for (const t of ['mcp__x__y', 'BashX', 'bash', 'shell', 'local_shell', '']) assert.equal(re.test(t), false, `${platform} ${t}`);
  }
});

test('READ_ONLY_ROLES: the sandbox choice follows the guard list', () => {
  for (const role of READ_ONLY_ROLES) { const a = codexAdapter.buildLaunch(input({ role })).args; assert.equal(a[a.indexOf('-s') + 1], 'read-only', role); }
});

test('instructionMapping: AGENTS.md native, CLAUDE.md as the fallback filename, no env', () => {
  const m = codexAdapter.instructionMapping(input());
  assert.deepEqual(m.nativeFiles, ['AGENTS.md', '~/.codex/AGENTS.md']);
  assert.deepEqual(m.extraArgs, ['-c', "project_doc_fallback_filenames=['CLAUDE.md']"]);
  assert.deepEqual(m.env, {});
});

test('trustSpec: pre-empts Update available; names the folder trust dialog; hook trust is the launch flag, not a dialog', () => {
  const t = codexAdapter.trustSpec(['C:/w/x'], 'win32');
  assert.deepEqual(t.extraArgs, ['-c', 'check_for_update_on_startup=false']);
  assert.equal(t.preseedPath, '~/.codex/config.toml');
  assert.match(t.dialogHint, /Update available/);
  assert.match(t.dialogHint, /hook trust is bypassed/);
  assert.ok(!t.extraArgs.includes('--dangerously-bypass-hook-trust')); // buildLaunch adds it, once
});

test('disableAskSpec: request_user_input denied by the hook shim', () => {
  assert.deepEqual(codexAdapter.disableAskSpec(), { toolName: 'request_user_input', mechanism: 'hook', target: 'kit/guard/shim-codex.mjs' });
});
