// The OpenCode adapter: launch argv and env, model checks, endpoint file, HTTP deliver/isAlive with a fake fetch, close with a
// fake Runner, quota text, and every spec method. Pure: no OpenCode, no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS, AGENT_KINDS, defaultModelFor, getAdapter } from '../cli/agents/index.ts';
import {
  OPENCODE_MODEL, clearOpencodeEndpoint, freellmRefusal, loadFreellmRule, makeOpencodeAdapter, newestSession, normalizeAbs, opencodeAdapter,
  opencodeEndpointPath, readOpencodeEndpoint, writeOpencodeEndpoint, type FreellmRule,
} from '../cli/agents/opencode.ts';
import type { LaunchInput, SeatHandle } from '../cli/agents/types.ts';

// The folder rule with git stubbed (not a repo): launch tests do not need real folders. Real-git cases use a temp root below.
const NO_REPO: FreellmRule = { root: 'X:\\Work', allowed: ['X:\\Work\\alpha', 'X:\\Work\\beta'], git: () => ({ ok: true, notRepo: true }) };
const A = makeOpencodeAdapter(undefined, undefined, NO_REPO);
const M = 'testbox';
let n = 0;
const pane = () => `oc-${process.pid}-${++n}`;
const seat = (p: string, extra: Partial<SeatHandle> = {}): SeatHandle => ({ machine: M, pane: p, agent: 'opencode', ...extra });
const input = (extra: Partial<LaunchInput> = {}): LaunchInput => ({
  name: 'demo-B1@m', role: 'builder', repo: 'main', agent: 'opencode', model: 'freellmapi/auto', board: 'C:/w/board', cwd: 'C:/w/x',
  env: { CB_ROLE: 'builder', CB_OPENCODE_PORT: '41234', OPENCODE_SERVER_PASSWORD: 'pw-1' }, ...extra,
});

test('registry: opencode is registered; defaultModelFor stays null like cb._role_model', () => {
  assert.equal(ADAPTERS.opencode, opencodeAdapter);
  assert.throws(() => getAdapter('opencode'), /agent "opencode" is not installed yet/); // listed, not installed until wired
  assert.equal(opencodeAdapter.kind, 'opencode');
  assert.equal(opencodeAdapter.relayStart, 'pane-prestart');
  assert.ok(AGENT_KINDS.includes('opencode'));
  assert.equal(defaultModelFor('opencode', 'builder'), null);
});

test('buildLaunch: argv, env, no secret in argv', () => {
  const s = A.buildLaunch(input());
  assert.equal(s.kind, 'opencode');
  assert.deepEqual(s.args, ['C:/w/x', '--hostname', '127.0.0.1', '--port', '41234', '-m', 'freellmapi/auto', '--auto']);
  assert.equal(s.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT, '1');
  assert.equal(s.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(s.env.OPENCODE_SERVER_PASSWORD, 'pw-1');
  assert.equal(s.env.CB_ROLE, 'builder');
  assert.ok(!s.args.join(' ').includes('pw-1'));
});

test('mcpOff (#4392): OpenCode has no per-run MCP off, so nothing is added and the gate names the config to check', () => {
  const m = A.mcpOff('C:/w/board');
  assert.deepEqual([m.args, m.env], [[], {}]);
  assert.match(m.gate ?? '', /"mcp"/);
  assert.match(m.gate ?? '', /OPENCODE_CONFIG_CONTENT merges/);
  assert.match(m.gate ?? '', /--pure/);
});

test('buildLaunch: never passes Claude-only secrets through', () => {
  const s = A.buildLaunch(input({ env: {
    ...input().env, GITHUB_PERSONAL_ACCESS_TOKEN: 'x', github_personal_access_token: 'y', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_ENTRYPOINT: 'e',
  } }));
  assert.deepEqual(Object.keys(s.env).filter((k) => /^(GITHUB_PERSONAL|CLAUDE_CODE_)/i.test(k)), []);
});

test('buildLaunch: model must be provider/model', () => {
  for (const m of ['sonnet', 'opus', 'auto', '/auto', 'Free/auto', 'a/', 'a b/c']) assert.throws(() => A.buildLaunch(input({ model: m })), /provider\/model/, m);
  for (const m of ['freellmapi/auto', 'anthropic/claude-sonnet-4', 'openrouter/qwen/qwen3-coder:free']) assert.doesNotThrow(() => A.buildLaunch(input({ model: m })), m);
  assert.ok(OPENCODE_MODEL.test('freellmapi/auto'));
});

test('buildLaunch: needs port and password; refuses client folders for the free router only', () => {
  assert.throws(() => A.buildLaunch(input({ env: { OPENCODE_SERVER_PASSWORD: 'p' } })), /CB_OPENCODE_PORT/);
  assert.throws(() => A.buildLaunch(input({ env: { CB_OPENCODE_PORT: '80', OPENCODE_SERVER_PASSWORD: 'p' } })), /CB_OPENCODE_PORT/);
  assert.throws(() => A.buildLaunch(input({ env: { CB_OPENCODE_PORT: '41234' } })), /OPENCODE_SERVER_PASSWORD/);
  assert.throws(() => A.buildLaunch(input({ cwd: 'X:\\Work\\acme\\app' })), /freellmapi refused/);
  assert.throws(() => A.buildLaunch(input({ cwd: 'x:/work/zed/x' })), /freellmapi refused/);
  assert.doesNotThrow(() => A.buildLaunch(input({ cwd: 'X:\\Work\\alpha\\app' })));
  assert.doesNotThrow(() => A.buildLaunch(input({ cwd: 'C:/w/outside-and-not-a-repo' })));
  // other providers are not checked (owner decision, see the design note)
  assert.doesNotThrow(() => A.buildLaunch(input({ cwd: 'X:\\Work\\acme\\x', model: 'anthropic/claude-sonnet-4' })));
  assert.match(freellmRefusal('X:\\Work\\wiki', NO_REPO)!, /refused/);
});

test('buildLaunch: no model means the config default (freellmapi/auto): no -m, and the folder rule still applies', () => {
  const s = A.buildLaunch(input({ model: '' }));
  assert.ok(!s.args.includes('-m'));
  assert.throws(() => A.buildLaunch(input({ model: '', cwd: 'X:\\Work\\zed' })), /freellmapi refused/);
});

test('buildLaunch: the cwd must be absolute and is passed normalised (never a flag)', () => {
  for (const c of ['', '  ', 'rel/path', '-rf', '--help', '.']) assert.throws(() => A.buildLaunch(input({ cwd: c })), /absolute cwd/, c);
  assert.equal(A.buildLaunch(input({ cwd: 'C:\\w\\a\\..\\x\\' })).args[0], 'C:/w/x');
});

test('normalizeAbs: GetFullPath-like forms', () => {
  assert.equal(normalizeAbs('X:\\Work\\alpha\\..\\acme\\x'), 'X:/Work/acme/x');
  assert.equal(normalizeAbs('\\\\?\\X:\\Work\\zed'), 'X:/Work/zed');
  assert.equal(normalizeAbs('//?/X:/Work/zed'), 'X:/Work/zed');
  assert.equal(normalizeAbs('/x/work/zed'), 'x:/work/zed');
  assert.equal(normalizeAbs('X:'), 'X:/');
  assert.equal(normalizeAbs('/home/x/'), '/home/x');
  for (const bad of ['', 'rel', '..', undefined, 5, 'a\0b']) assert.equal(normalizeAbs(bad), null, String(bad));
});

test('freellmRefusal: dot-dot, device and Git Bash forms of a protected folder are refused', () => {
  for (const c of ['X:/Work/alpha/../acme/x', '//?/X:/Work/zed', '\\\\?\\X:\\Work\\zed', '/x/work/zed', 'x:\\WORK\\acme', 'X:\\Work\\alpha2']) {
    assert.match(freellmRefusal(c, NO_REPO)!, /refused/, c);
  }
  for (const c of ['', 'rel/path', 'X:Work']) assert.match(freellmRefusal(c, NO_REPO)!, /refused/, c);
  for (const c of ['X:/Work/alpha', 'X:\\Work\\beta\\a\\b', 'D:/anything', 'X:/Workshop/x']) assert.equal(freellmRefusal(c, NO_REPO), null, c);
});

test('freellmRefusal: git failure refuses; a bad git path refuses; the common dir is judged', () => {
  const rule = (git: FreellmRule['git']): FreellmRule => ({ ...NO_REPO, git });
  assert.match(freellmRefusal('C:/w/x', rule(() => ({ ok: false })))!, /git could not say/);
  assert.match(freellmRefusal('C:/w/x', rule(() => ({ ok: true, dir: '' })))!, /no usable repository path/);
  assert.match(freellmRefusal('C:/w/x', rule(() => ({ ok: true, dir: 'X:/Work/acme/app/.git' })))!, /under X:\\Work/);
  assert.equal(freellmRefusal('C:/w/x', rule(() => ({ ok: true, dir: 'X:/Work/alpha/app/.git' }))), null);
  assert.match(freellmRefusal('C:/w/x', { ...NO_REPO, root: 'rel' })!, /protected root/);
  assert.match(freellmRefusal('C:/w/x', { ...NO_REPO, allowed: ['rel'] })!, /allowed folder/);
});

test('folder rule comes from a local file; missing or malformed refuses every free-router launch', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'oc-rule-'));
  try {
    const f = join(tmp, 'freellm-rule.json');
    assert.equal(loadFreellmRule(f), null, 'missing file');
    for (const bad of ['{not json', 'null', '[]', '{"root":"","allowed":[]}', '{"root":"X:/Work"}', '{"root":"X:/Work","allowed":["ok",""]}', '{"root":"X:/Work","allowed":[1]}']) {
      writeFileSync(f, bad);
      assert.equal(loadFreellmRule(f), null, bad);
    }
    writeFileSync(f, JSON.stringify({ root: 'X:\\Work', allowed: ['X:\\Work\\alpha'] }));
    assert.deepEqual(loadFreellmRule(f), { root: 'X:\\Work', allowed: ['X:\\Work\\alpha'] });
    assert.match(freellmRefusal('D:/anything', null)!, /no folder rule/);
    const noRule = makeOpencodeAdapter(undefined, undefined, null);
    assert.throws(() => noRule.buildLaunch(input({ cwd: 'D:/anything' })), /no folder rule/);
    assert.throws(() => noRule.buildLaunch(input({ cwd: 'D:/anything', model: '' })), /no folder rule/);
    assert.doesNotThrow(() => noRule.buildLaunch(input({ cwd: 'D:/anything', model: 'anthropic/claude-sonnet-4' })), 'other providers are not judged');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('freellmRefusal with real git: a worktree outside the protected root belongs to its repo', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'oc-fl-')));
  const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  try {
    const root = join(tmp, 'protected'), ok = join(root, 'open'), bad = join(root, 'secret'), out = join(tmp, 'outside');
    for (const d of [ok, bad, out]) mkdirSync(d, { recursive: true });
    const rule: FreellmRule = { root, allowed: [ok] };
    git(bad, 'init', '-q'); writeFileSync(join(bad, 'a'), 'x'); git(bad, 'add', 'a'); git(bad, 'commit', '-q', '-m', 'i');
    git(ok, 'init', '-q'); writeFileSync(join(ok, 'a'), 'x'); git(ok, 'add', 'a'); git(ok, 'commit', '-q', '-m', 'i');
    const wtBad = join(out, 'wt-bad'), wtOk = join(out, 'wt-ok');
    git(bad, 'worktree', 'add', '-q', wtBad, '-b', 'w1');
    git(ok, 'worktree', 'add', '-q', wtOk, '-b', 'w2');
    assert.match(freellmRefusal(bad, rule)!, /refused/);
    assert.match(freellmRefusal(wtBad, rule)!, /refused/, 'worktree of a protected repo');
    assert.equal(freellmRefusal(ok, rule), null);
    assert.equal(freellmRefusal(wtOk, rule), null, 'worktree of an allowed repo');
    assert.equal(freellmRefusal(out, rule), null, 'a folder that is not a repo');
    assert.match(freellmRefusal(join(out, 'missing'), rule)!, /git could not say/, 'unresolvable folder');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
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
    for (const u of ['a:b', '', 'a b', 'x/y']) assert.throws(() => writeOpencodeEndpoint(M, p, { port: 41234, password: 'pw', username: u }), /username/, u);
    writeOpencodeEndpoint(M, p, { port: 41234, password: 'pw', username: 'oc.user-1' });
    assert.equal(readOpencodeEndpoint(M, p)!.username, 'oc.user-1');
    // a hand-edited file with a bad username reads as none, never a broken Basic header
    writeFileSync(opencodeEndpointPath(M, p), JSON.stringify({ port: 41234, password: 'pw', username: 'a:b' }));
    assert.equal(readOpencodeEndpoint(M, p), null);
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
    assert.equal(calls[0]!.init.redirect, 'error');
    assert.equal(calls[1]!.init.redirect, 'error');
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
  // a subagent's child session is never the seat's, even when it is the newest
  assert.equal(newestSession([{ id: 'root', time: { updated: 1 } }, { id: 'child', parentID: 'root', time: { updated: 9 } }]), 'root');
  assert.equal(newestSession([{ id: 'child', parentID: 'root' }]), null);
});

test('isAlive: health answer alive (any status), refused is dead, timeout alive, no endpoint dead', async () => {
  const p = pane();
  assert.equal(await makeOpencodeAdapter(fake([]).f).isAlive(seat(p)), false);
  await withEp(p, async () => {
    const a = fake([json({ healthy: true })]);
    assert.equal(await makeOpencodeAdapter(a.f).isAlive(seat(p)), true);
    assert.equal(a.calls[0]!.url, 'http://127.0.0.1:41234/global/health');
    for (const s of [401, 403, 404]) assert.equal(await makeOpencodeAdapter(fake([json({}, s)]).f).isAlive(seat(p)), false, String(s));
    assert.equal(await makeOpencodeAdapter(fake([json({}, 500)]).f).isAlive(seat(p)), true);
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EADDRNOTAVAIL', 'ENOENT']) {
      const e = Object.assign(new TypeError('fetch failed'), { cause: { code } });
      assert.equal(await makeOpencodeAdapter(fake([e]).f).isAlive(seat(p)), false, code);
    }
    assert.equal(await makeOpencodeAdapter(fake([new TypeError('redirect mode is set to error')]).f).isAlive(seat(p)), false);
    assert.equal(await makeOpencodeAdapter(fake([new DOMException('timed out', 'TimeoutError')]).f).isAlive(seat(p)), true);
    assert.equal(await makeOpencodeAdapter(fake([new DOMException('aborted', 'AbortError')]).f).isAlive(seat(p)), true);
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
  assert.deepEqual(r, { kind: 'rate_limit', raw: 'Rate limit reached', retryAfterSec: 30 });
  assert.equal(d('HTTP 429 Too Many Requests, try again in 2 min')?.retryAfterSec, 120);
  assert.equal(d('processed 4290 files'), null);
});

test('detectQuotaStop: a bare 429 or "rate limit" in normal output is not a stop; only the last lines count', () => {
  const d = (t?: string) => opencodeAdapter.detectQuotaStop(seat('p'), null, t);
  for (const t of ['processed 429 files', 'see line 429 of src/a.ts', 'wrote src/rate-limit.ts and 429 tests', 'the rate limit config is in ratelimit.json', 'port 4290 ok']) assert.equal(d(t), null, t);
  const old = 'Error: FreeUsageLimitError\n' + Array.from({ length: 20 }, (_, i) => `building step ${i}`).join('\n');
  assert.equal(d(old), null, 'a banner scrolled out of the last lines');
  assert.equal(d(`${old}\nrate limited, retrying in 5 seconds`)?.kind, 'rate_limit');
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
