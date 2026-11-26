// The agent adapter contract: registry, Claude launch args, the endpoint file and socket delivery. Pure: no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_KINDS, defaultModelFor, getAdapter, isAgentKind } from '../cli/agents/index.ts';
import { claudeAdapter, claudeEndpointPath, clearClaudeEndpoint, readClaudeEndpoint, writeClaudeEndpoint } from '../cli/agents/claude.ts';
import { seatKey } from '../cli/bridge.ts';
import type { LaunchInput, SeatHandle } from '../cli/agents/types.ts';

const M = 'testbox';
let n = 0;
const fresh = () => `agents-${process.pid}-${++n}`;
const seatOf = (pane: string, extra: Partial<SeatHandle> = {}): SeatHandle => ({ machine: M, pane, agent: 'claude', ...extra });
const sockName = (pane: string) => process.platform === 'win32' ? String.raw`\\.\pipe\cb-test-` + pane : join(tmpdir(), `cb-test-${pane}.sock`);

/** A fake Claude socket: collects every line it receives. */
function listen(path: string): Promise<{ lines: string[]; close: () => Promise<void> }> {
  const lines: string[] = [], conns = new Set<net.Socket>();
  const srv = net.createServer((c) => {
    conns.add(c);
    let b = '';
    c.on('data', (d) => { b += d; });
    c.on('close', () => { lines.push(...b.split('\n').filter(Boolean)); conns.delete(c); });
    c.on('error', () => {});
  });
  return new Promise((res) => srv.listen(path, () => res({ lines, close: () => new Promise<void>((r) => { for (const c of conns) c.destroy(); srv.close(() => r()); }) })));
}
const cleanup = (pane: string) => { try { rmSync(claudeEndpointPath(M, pane), { force: true }); } catch {} };
const settle = () => new Promise((r) => setTimeout(r, 100));

test('seatKey: sha1 of lowercased machine and trimmed pane, 12 hex', () => {
  assert.match(seatKey('TestBox ', ' p1 '), /^[0-9a-f]{12}$/);
  assert.equal(seatKey('TestBox ', ' p1 '), seatKey('testbox', 'p1'));
  assert.notEqual(seatKey('testbox', 'p1'), seatKey('testbox', 'p2'));
});

test('registry: claude is registered; codex/opencode/agy are not installed yet; anything else is unknown', () => {
  assert.deepEqual([...AGENT_KINDS], ['claude', 'codex', 'opencode', 'agy']);
  assert.equal(getAdapter('claude'), claudeAdapter);
  for (const k of ['codex', 'opencode', 'agy'] as const) assert.throws(() => getAdapter(k), new RegExp(`agent "${k}" is not installed yet \\(phase 1 supports claude only\\)`));
  assert.throws(() => getAdapter('grok' as any), /unknown agent "grok"/);
  assert.equal(isAgentKind('agy'), true);
  assert.equal(isAgentKind('grok'), false);
  assert.equal(isAgentKind(undefined), false);
});

test('defaultModelFor agrees with cb._role_model', () => {
  for (const r of ['builder', 'qa']) assert.equal(defaultModelFor('claude', r), 'sonnet');
  for (const r of ['lead', 'architect', 'owner', 'reviewer', 'investigator']) assert.equal(defaultModelFor('claude', r), 'opus');
  for (const a of ['codex', 'opencode', 'agy'] as const) assert.equal(defaultModelFor(a, 'builder'), null);
});

test("buildLaunch: today's claude args, trailing slashes stripped", () => {
  const input: LaunchInput = { name: 'demo-B1@m', role: 'builder', repo: 'main', agent: 'claude', model: 'sonnet', board: 'C:/w/board//', cwd: 'C:/w/x' };
  assert.deepEqual(claudeAdapter.buildLaunch(input), {
    kind: 'claude',
    args: ['--model', 'sonnet', '--permission-mode', 'bypassPermissions', '--settings', 'C:/w/board/kit/permissions/builder.json'],
    env: {},
  });
  assert.deepEqual(claudeAdapter.buildLaunch({ ...input, board: '/Users/x/board', env: { CB_ROLE: 'builder' } }).env, { CB_ROLE: 'builder' });
  assert.equal(claudeAdapter.kind, 'claude');
  assert.equal(claudeAdapter.relayStart, 'session-hook');
});

test('endpoint file: keyed by seatKey, round-trips, private mode, no temp file left', () => {
  const pane = fresh(); cleanup(pane);
  try {
    assert.equal(claudeEndpointPath(M, pane), join(tmpdir(), `cb-seat-${seatKey(M, pane)}.claude.json`));
    assert.equal(readClaudeEndpoint(M, pane), null);
    writeClaudeEndpoint(M, pane, { socket: 'S1', token: 'T1', pid: 42 });
    const ep = readClaudeEndpoint(M, pane)!;
    assert.equal(ep.socket, 'S1'); assert.equal(ep.token, 'T1'); assert.equal(ep.pid, 42);
    assert.equal(typeof ep.updatedAt, 'number');
    if (process.platform !== 'win32') assert.equal(statSync(claudeEndpointPath(M, pane)).mode & 0o777, 0o600);
    writeClaudeEndpoint(M, pane, { socket: 'S2', token: 'T2' });
    assert.equal(readClaudeEndpoint(M, pane)!.socket, 'S2');
    assert.equal(existsSync(`${claudeEndpointPath(M, pane)}.tmp.${process.pid}`), false);
    writeFileSync(claudeEndpointPath(M, pane), '{not json');
    assert.equal(readClaudeEndpoint(M, pane), null);
    writeFileSync(claudeEndpointPath(M, pane), JSON.stringify({ socket: 1 }));
    assert.equal(readClaudeEndpoint(M, pane), null);
  } finally { cleanup(pane); }
});

test('clearClaudeEndpoint: only when the socket matches, if one is given', () => {
  const pane = fresh(); cleanup(pane);
  try {
    writeClaudeEndpoint(M, pane, { socket: 'S1', token: 'T' });
    clearClaudeEndpoint(M, pane, 'OTHER');
    assert.ok(readClaudeEndpoint(M, pane));
    clearClaudeEndpoint(M, pane, 'S1');
    assert.equal(readClaudeEndpoint(M, pane), null);
    writeClaudeEndpoint(M, pane, { socket: 'S1', token: 'T' });
    clearClaudeEndpoint(M, pane);
    assert.equal(readClaudeEndpoint(M, pane), null);
    clearClaudeEndpoint(M, pane); // already gone: no throw
  } finally { cleanup(pane); }
});

test('deliver: auth line then user line on the socket from the endpoint file', async () => {
  const pane = fresh(), sock = sockName(pane); cleanup(pane);
  const srv = await listen(sock);
  try {
    writeClaudeEndpoint(M, pane, { socket: sock, token: 'TOK' });
    await claudeAdapter.deliver(seatOf(pane), 'hello\nworld');
    await settle();
    assert.equal(srv.lines.length, 2);
    assert.deepEqual(JSON.parse(srv.lines[0]!), { type: 'auth', token: 'TOK' });
    assert.deepEqual(JSON.parse(srv.lines[1]!), { type: 'user', message: { role: 'user', content: 'hello\nworld' } });
  } finally { await srv.close(); cleanup(pane); }
});

test('deliver: no endpoint file rejects', async () => {
  const pane = fresh(); cleanup(pane);
  await assert.rejects(claudeAdapter.deliver(seatOf(pane), 'x'), /no claude endpoint/);
});

test('deliver: a dead socket with an unchanged endpoint file rejects, token never in the error', async () => {
  const pane = fresh(); cleanup(pane);
  try {
    writeClaudeEndpoint(M, pane, { socket: sockName(`${pane}-dead`), token: 'SECRET-TOKEN' });
    await assert.rejects(claudeAdapter.deliver(seatOf(pane), 'x'), (e: Error) => !e.message.includes('SECRET-TOKEN') && !String(e.stack).includes('SECRET-TOKEN'));
  } finally { cleanup(pane); }
});

test('deliver: retries once when the endpoint file rotated to a live socket', async () => {
  const pane = fresh(), live = sockName(pane); cleanup(pane);
  const srv = await listen(live);
  try {
    writeClaudeEndpoint(M, pane, { socket: sockName(`${pane}-old`), token: 'OLD' });
    const p = claudeAdapter.deliver(seatOf(pane), 'after rotation'); // has read the old endpoint by now
    writeClaudeEndpoint(M, pane, { socket: live, token: 'NEW' });
    await p;
    await settle();
    assert.deepEqual(JSON.parse(srv.lines[0]!), { type: 'auth', token: 'NEW' });
    assert.equal(JSON.parse(srv.lines[1]!).message.content, 'after rotation');
  } finally { await srv.close(); cleanup(pane); }
});

test('isAlive: true while the socket exists, false when it is gone or there is no endpoint', async () => {
  const pane = fresh(), sock = sockName(pane); cleanup(pane);
  let srv: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    assert.equal(await claudeAdapter.isAlive(seatOf(pane)), false);
    srv = await listen(sock);
    writeClaudeEndpoint(M, pane, { socket: sock, token: 'T' });
    assert.equal(await claudeAdapter.isAlive(seatOf(pane)), true);
    await srv.close();
    srv = undefined;
    assert.equal(await claudeAdapter.isAlive(seatOf(pane)), false);
  } finally { await srv?.close(); cleanup(pane); }
});

test('readStatus: idle and done are safe to close; the rest are not', async () => {
  const s = seatOf('p1');
  assert.deepEqual(await claudeAdapter.readStatus(s, { agent_status: 'idle' }), { state: 'idle', safeToClose: true });
  assert.deepEqual(await claudeAdapter.readStatus(s, { agent_status: 'done' }), { state: 'done', safeToClose: true });
  assert.deepEqual(await claudeAdapter.readStatus(s, { agent_status: 'working' }), { state: 'working', safeToClose: false });
  assert.deepEqual(await claudeAdapter.readStatus(s, { agent_status: 'blocked' }), { state: 'blocked', safeToClose: false });
  assert.equal((await claudeAdapter.readStatus(s, null)).state, 'unknown');
  assert.equal((await claudeAdapter.readStatus(s, { agent_status: 'weird' })).safeToClose, false);
});

test('close: sends /exit through herdr; sent on exit 0, failed otherwise', async () => {
  const calls: any[] = [];
  const ok = (m: string | null, a: string[], t?: number) => { calls.push([m, a, t]); return { status: 0 }; };
  const s = seatOf('p1', { herdr: 'macbook', herdrName: 'demo-b1' });
  assert.equal(await claudeAdapter.close(s, ok), 'sent');
  assert.deepEqual(calls[0].slice(0, 2), ['macbook', ['agent', 'prompt', 'demo-b1', '/exit']]);
  assert.equal(await claudeAdapter.close(s, () => ({ status: 1 })), 'failed');
  assert.equal(await claudeAdapter.close(s, () => ({ status: null, error: new Error('x') })), 'failed');
  assert.equal(await claudeAdapter.close(seatOf('p1'), ok), 'failed'); // no herdr name: nothing to address
});

test('detectQuotaStop: usage and rate limit lines in the pane tail', () => {
  const s = seatOf('p1');
  assert.equal(claudeAdapter.detectQuotaStop(s, null), null);
  assert.equal(claudeAdapter.detectQuotaStop(s, null, 'all fine here'), null);
  assert.equal(claudeAdapter.detectQuotaStop(s, null, 'Claude usage limit reached. Your limit will reset at 5pm.')!.kind, 'quota');
  assert.equal(claudeAdapter.detectQuotaStop(s, null, "You've hit your limit · resets 3am")!.kind, 'quota');
  const r = claudeAdapter.detectQuotaStop(s, null, 'API Error: 429 rate limit exceeded')!;
  assert.equal(r.kind, 'rate_limit');
  assert.ok(r.raw.length > 0);
});

test('static specs: guard, instructions, trust, disable-ask', () => {
  const w = claudeAdapter.guardInstallSpec('C:/w/board/', 'win32');
  assert.equal(w.matchers.win32, 'Bash|PowerShell');
  assert.equal(claudeAdapter.guardInstallSpec('/b', 'darwin').matchers.darwin, 'Bash');
  assert.equal(w.targetPath, '~/.claude/settings.json');
  assert.equal(w.shimFile, 'C:/w/board/kit/guard/shim-claude.mjs');
  const i = claudeAdapter.instructionMapping({} as LaunchInput);
  assert.deepEqual([i.nativeFiles, i.extraArgs, i.env], [['CLAUDE.md', '~/.claude/CLAUDE.md'], [], {}]);
  const t = claudeAdapter.trustSpec(['/r'], 'darwin');
  assert.equal(t.dialogHint, 'folder trust or bypass warning');
  assert.deepEqual(t.extraArgs, []);
  assert.deepEqual(claudeAdapter.disableAskSpec(), { toolName: 'AskUserQuestion', mechanism: 'hook', target: 'hooks/deny-ask.mjs' });
});
