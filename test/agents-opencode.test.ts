// The OpenCode adapter: launch argv and env, model checks, endpoint file, HTTP deliver/isAlive with a fake fetch, close with a
// fake Runner, quota text, and every spec method. Pure: no OpenCode, no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { AGENT_KINDS, defaultModelFor, getAdapter } from '../cli/agents/index.ts';
import {
  OPENCODE_MODEL, clearOpencodeEndpoint, freellmRefusal, makeOpencodeAdapter, newestSession, opencodeAdapter, opencodeEndpointPath,
  readOpencodeEndpoint, writeOpencodeEndpoint,
} from '../cli/agents/opencode.ts';
import type { LaunchInput, SeatHandle } from '../cli/agents/types.ts';

const M = 'testbox';
let n = 0;
const pane = () => `oc-${process.pid}-${++n}`;
const seat = (p: string, extra: Partial<SeatHandle> = {}): SeatHandle => ({ machine: M, pane: p, agent: 'opencode', ...extra });
const input = (extra: Partial<LaunchInput> = {}): LaunchInput => ({
  name: 'demo-B1@m', role: 'builder', repo: 'main', agent: 'opencode', model: 'freellmapi/auto', board: 'C:/w/board', cwd: 'C:/w/x',
  env: { CB_ROLE: 'builder', CB_OPENCODE_PORT: '41234', OPENCODE_SERVER_PASSWORD: 'pw-1' }, ...extra,
});

test('registry: opencode is registered; defaultModelFor stays null like cb._role_model', () => {
  assert.equal(getAdapter('opencode'), opencodeAdapter);
  assert.equal(opencodeAdapter.kind, 'opencode');
  assert.equal(opencodeAdapter.relayStart, 'pane-prestart');
  assert.ok(AGENT_KINDS.includes('opencode'));
  assert.equal(defaultModelFor('opencode', 'builder'), null);
});

test('buildLaunch: argv, env, no secret in argv', () => {
  const s = opencodeAdapter.buildLaunch(input());
  assert.equal(s.kind, 'opencode');
  assert.deepEqual(s.args, ['C:/w/x', '--hostname', '127.0.0.1', '--port', '41234', '-m', 'freellmapi/auto', '--auto']);
  assert.equal(s.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT, '1');
  assert.equal(s.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(s.env.OPENCODE_SERVER_PASSWORD, 'pw-1');
  assert.equal(s.env.CB_ROLE, 'builder');
  assert.ok(!s.args.join(' ').includes('pw-1'));
});

test('buildLaunch: never passes Claude-only secrets through', () => {
  const s = opencodeAdapter.buildLaunch(input({ env: {
    ...input().env, GITHUB_PERSONAL_ACCESS_TOKEN: 'x', github_personal_access_token: 'y', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_ENTRYPOINT: 'e',
  } }));
  assert.deepEqual(Object.keys(s.env).filter((k) => /^(GITHUB_PERSONAL|CLAUDE_CODE_)/i.test(k)), []);
});

test('buildLaunch: model must be provider/model', () => {
  for (const m of ['sonnet', 'opus', 'auto', '', '/auto', 'Free/auto', 'a/', 'a b/c']) assert.throws(() => opencodeAdapter.buildLaunch(input({ model: m })), /provider\/model/, m);
  for (const m of ['freellmapi/auto', 'anthropic/claude-sonnet-4', 'openrouter/qwen/qwen3-coder:free']) assert.doesNotThrow(() => opencodeAdapter.buildLaunch(input({ model: m })), m);
  assert.ok(OPENCODE_MODEL.test('freellmapi/auto'));
});

test('buildLaunch: needs port and password; refuses client folders for the free router only', () => {
  assert.throws(() => opencodeAdapter.buildLaunch(input({ env: { OPENCODE_SERVER_PASSWORD: 'p' } })), /CB_OPENCODE_PORT/);
  assert.throws(() => opencodeAdapter.buildLaunch(input({ env: { CB_OPENCODE_PORT: '80', OPENCODE_SERVER_PASSWORD: 'p' } })), /CB_OPENCODE_PORT/);
  assert.throws(() => opencodeAdapter.buildLaunch(input({ env: { CB_OPENCODE_PORT: '41234' } })), /OPENCODE_SERVER_PASSWORD/);
  assert.throws(() => opencodeAdapter.buildLaunch(input({ cwd: 'F:\\Work\\Tawuniya\\iHop-Platform' })), /freellmapi refused/);
  assert.throws(() => opencodeAdapter.buildLaunch(input({ cwd: 'f:/work/QHS/x' })), /freellmapi refused/);
  assert.doesNotThrow(() => opencodeAdapter.buildLaunch(input({ cwd: 'F:\\Work\\TactiAI\\app' })));
  assert.doesNotThrow(() => opencodeAdapter.buildLaunch(input({ cwd: 'C:/w/anything' })));
  assert.doesNotThrow(() => opencodeAdapter.buildLaunch(input({ cwd: 'F:\\Work\\Tawuniya\\x', model: 'anthropic/claude-sonnet-4' })));
  assert.match(freellmRefusal('F:\\Work\\wiki')!, /refused/);
});

test('endpoint file: 0600, round trip, bad content reads as none', () => {
  const p = pane();
  try {
    assert.equal(readOpencodeEndpoint(M, p), null);
    writeOpencodeEndpoint(M, p, { port: 41234, password: 'pw' });
    assert.deepEqual({ ...readOpencodeEndpoint(M, p)!, updatedAt: 0 }, { port: 41234, password: 'pw', username: undefined, updatedAt: 0 });
    if (process.platform !== 'win32') assert.equal(statSync(opencodeEndpointPath(M, p)).mode & 0o777, 0o600);
    assert.throws(() => writeOpencodeEndpoint(M, p, { port: 22, password: 'pw' }));
    assert.throws(() => writeOpencodeEndpoint(M, p, { port: 41234, password: '' }));
  } finally { clearOpencodeEndpoint(M, p); }
  assert.equal(readOpencodeEndpoint(M, p), null);
});

type Call = { url: string; init: any };
function fake(answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const f = async (url: string, init?: any) => { calls.push({ url, init }); const a = answers.shift()!; if (a instanceof Error) throw a; return a; };
  return { calls, f };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const withEp = (p: string, fn: () => Promise<void>) => async () => {
  writeOpencodeEndpoint(M, p, { port: 41234, password: 'pw' });
  try { await fn(); } finally { clearOpencodeEndpoint(M, p); }
};

test('deliver: picks the newest session and posts prompt_async with basic auth', async () => {
  const p = pane();
  await withEp(p, async () => {
    const { calls, f } = fake([json([{ id: 'a', time: { updated: 5 } }, { id: 'b', time: { updated: 9 } }, { id: 'c', time: { updated: 1 } }]), new Response(null, { status: 204 })]);
    await makeOpencodeAdapter(f).deliver(seat(p), 'hello');
    assert.equal(calls[0]!.url, 'http://127.0.0.1:41234/session');
    assert.equal(calls[1]!.url, 'http://127.0.0.1:41234/session/b/prompt_async');
    assert.equal(calls[1]!.init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1]!.init.body), { parts: [{ type: 'text', text: 'hello' }] });
    assert.equal(calls[1]!.init.headers.authorization, 'Basic ' + Buffer.from('opencode:pw').toString('base64'));
  })();
});

test('deliver: throws without endpoint, without session, and on HTTP errors (never the password)', async () => {
  const p = pane();
  await assert.rejects(makeOpencodeAdapter(fake([]).f).deliver(seat(p), 'x'), /no opencode endpoint/);
  await withEp(p, async () => {
    await assert.rejects(makeOpencodeAdapter(fake([json([])]).f).deliver(seat(p), 'x'), /no session yet/);
    await assert.rejects(makeOpencodeAdapter(fake([json({}, 401)]).f).deliver(seat(p), 'x'), (e: Error) => /answered 401/.test(e.message) && !e.message.includes('pw'));
    await assert.rejects(makeOpencodeAdapter(fake([json([{ id: 'a' }]), json({}, 500)]).f).deliver(seat(p), 'x'), /prompt answered 500/);
  })();
});

test('newestSession reads arrays, {data}, {items}; junk is none', () => {
  assert.equal(newestSession([{ id: 'a', time: { created: 1 } }, { id: 'b', time: { created: 2 } }]), 'b');
  assert.equal(newestSession({ data: [{ id: 'x' }] }), 'x');
  assert.equal(newestSession({ items: [{ id: 'y' }] }), 'y');
  for (const j of [null, 'x', 5, {}, [null, { id: 3 }]]) assert.equal(newestSession(j), null);
});

test('isAlive: health answer alive (any status), refused is dead, timeout alive, no endpoint dead', async () => {
  const p = pane();
  assert.equal(await makeOpencodeAdapter(fake([]).f).isAlive(seat(p)), false);
  await withEp(p, async () => {
    const a = fake([json({ healthy: true })]);
    assert.equal(await makeOpencodeAdapter(a.f).isAlive(seat(p)), true);
    assert.equal(a.calls[0]!.url, 'http://127.0.0.1:41234/global/health');
    assert.equal(await makeOpencodeAdapter(fake([json({}, 401)]).f).isAlive(seat(p)), true);
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    assert.equal(await makeOpencodeAdapter(fake([refused]).f).isAlive(seat(p)), false);
    assert.equal(await makeOpencodeAdapter(fake([new DOMException('timed out', 'TimeoutError')]).f).isAlive(seat(p)), true);
  })();
});

test('readStatus: herdr states; safeToClose only idle or done', async () => {
  for (const [s, safe] of [['idle', true], ['done', true], ['working', false], ['blocked', false]] as const) {
    assert.deepEqual(await opencodeAdapter.readStatus(seat('p'), { agent_status: s }), { state: s, safeToClose: safe });
  }
  assert.deepEqual(await opencodeAdapter.readStatus(seat('p'), null), { state: 'unknown', safeToClose: false });
  assert.deepEqual(await opencodeAdapter.readStatus(seat('p'), { agent_status: 'weird' }), { state: 'unknown', safeToClose: false });
});

test('close: herdr agent prompt /exit through the Runner', async () => {
  const seen: any[] = [];
  const ok: any = (m: string | null, a: string[], t?: number) => { seen.push([m, a, t]); return { status: 0 }; };
  assert.equal(await opencodeAdapter.close(seat('p', { herdrName: 'demo-b1-m', herdr: 'macbook' }), ok), 'sent');
  assert.deepEqual(seen[0], ['macbook', ['agent', 'prompt', 'demo-b1-m', '/exit'], 30_000]);
  assert.equal(await opencodeAdapter.close(seat('p'), ok), 'failed');
  assert.equal(await opencodeAdapter.close(seat('p', { herdrName: 'x' }), (() => ({ status: 1 })) as any), 'failed');
  assert.equal(await opencodeAdapter.close(seat('p', { herdrName: 'x' }), (() => ({ status: 0, error: new Error('x') })) as any), 'failed');
});

test('detectQuotaStop: real-looking pane text', () => {
  const d = (t?: string) => opencodeAdapter.detectQuotaStop(seat('p'), null, t);
  assert.equal(d(undefined), null);
  assert.equal(d('all good\n> build the thing'), null);
  assert.deepEqual(d('Error: FreeUsageLimitError: Free usage exceeded, retry in 2 hours'), { kind: 'quota', raw: 'FreeUsageLimitError' });
  assert.equal(d('AI_APICallError: You exceeded your current quota (insufficient_quota)')?.kind, 'quota');
  const r = d('Rate limit reached for freellmapi/auto. Retrying in 30 seconds');
  assert.deepEqual(r, { kind: 'rate_limit', raw: 'Rate limit', retryAfterSec: 30 });
  assert.equal(d('HTTP 429 Too Many Requests, try again in 2 min')?.retryAfterSec, 120);
  assert.equal(d('processed 4290 files'), null);
});

test('spec methods return what the design note says', () => {
  const a = opencodeAdapter;
  const g = a.guardInstallSpec('C:/w/board//', 'win32');
  assert.equal(g.targetPath, '~/.config/opencode/plugins/cb-guard.js');
  assert.equal(g.shimFile, 'C:/w/board/kit/guard/shim-opencode.mjs');
  for (const p of ['win32', 'darwin', 'linux'] as const) assert.match(g.matchers[p], /^bash\|powershell\|edit\|.*question$/);
  const i = a.instructionMapping(input());
  assert.deepEqual(i.env, { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1' });
  assert.deepEqual(i.extraArgs, []);
  assert.ok(i.nativeFiles.includes('AGENTS.md') && i.nativeFiles.includes('~/.config/opencode/AGENTS.md'));
  assert.deepEqual(a.trustSpec(['C:/x'], 'win32').extraArgs, []);
  assert.match(a.trustSpec([], 'linux').dialogHint, /no folder-trust dialog/);
  assert.deepEqual(a.disableAskSpec(), { toolName: 'question', mechanism: 'permission', target: '~/.config/opencode/opencode.jsonc permission.question = "deny"' });
});
