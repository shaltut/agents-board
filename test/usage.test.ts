// #4349: the session token ledger. The Stop hook (hooks/usage-stop.mjs) sums each assistant turn's usage from a
// synthetic transcript (never a real one) incrementally, and cb.usage_report keeps one cumulative row per session.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../server/db.ts';
import { serveBridge, seatKey } from '../cli/bridge.ts';
import { freshDb, TEST_URL } from './helpers.ts';
import { BYTES_PER_RUN, loadState, scanSession, statuslineCost, turn } from '../hooks/usage-stop.mjs';

const clients: any[] = [];
const dirs: string[] = [];
after(async () => { await Promise.all(clients.map((c) => c.end())); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

// text that must never reach the board: it rides in every message's content and the tool output around it
const MARK = 'SYNTHETIC-SECRET-MARKER-4349';
/** A synthetic transcript: per turn a user line with a big tool result, then the assistant message written as
 *  `blocks` lines (one per content block) that repeat its id and usage, as Claude Code writes them. */
function transcript(turns: number, { from = 0, blocks = 3, pad = 200, model = 'claude-test-1' } = {}) {
  const lines: string[] = [];
  const want = [0, 0, 0, 0];
  for (let i = from; i < from + turns; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: `${MARK} ${'x'.repeat(pad)}` }] } }));
    const usage = { input_tokens: 2 + (i % 5), output_tokens: 100 + i, cache_read_input_tokens: 1000 + 10 * i, cache_creation_input_tokens: 50 + (i % 7) };
    want[0] += usage.input_tokens; want[1] += usage.output_tokens; want[2] += usage.cache_read_input_tokens; want[3] += usage.cache_creation_input_tokens;
    for (let b = 0; b < blocks; b++) {
      lines.push(JSON.stringify({ type: 'assistant', parentUuid: `u_${i}`, requestId: `req_${i}`, message: { id: `msg_syn_${i}`, model, role: 'assistant',
        content: [{ type: 'text', text: `${MARK} block ${b}` }], usage } }));
      if (b === 0) lines.push(JSON.stringify({ type: 'system', content: 'between blocks' }));
    }
  }
  // a turn Claude Code made up itself (an error notice) costs nothing and is not a model
  lines.push(JSON.stringify({ type: 'assistant', message: { id: 'msg_synthetic', model: '<synthetic>', content: [], usage: { input_tokens: 0, output_tokens: 0 } } }));
  return { text: lines.map((l) => l + '\n').join(''), want };
}
const add = (a: number[], b: number[]) => a.map((x, i) => x + b[i]!);

test('turn: an assistant line with usage counts; other lines, bad JSON and synthetic turns do not', () => {
  assert.deepEqual(turn(JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'x', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } })),
    { id: 'm1', model: 'x', copied: false, counts: [1, 2, 3, 4] });
  assert.equal(turn(JSON.stringify({ type: 'user', message: { content: 'assistant' } })), null);
  assert.equal(turn('{"type":"assistant", broken'), null);
  assert.equal(turn(JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { output_tokens: 5 } } })), null);
  assert.deepEqual(turn(JSON.stringify({ type: 'assistant', message: { id: 'm2', usage: { input_tokens: -1, output_tokens: 1.5 } } }))?.counts, [0, 0, 0, 0]);
});

test('scanSession: each message counts once though written as several lines; the totals are not zero', () => {
  const d = temp('cb-usage-scan-');
  const f = join(d, 'sess.jsonl');
  const { text, want } = transcript(40);
  writeFileSync(f, text);
  const s = scanSession(f, loadState(d, 'none'));
  assert.deepEqual(s.totals, want);
  assert.ok(want.every((x) => x > 0));
  assert.equal(s.model, 'claude-test-1');
  assert.equal(s.files.main.offset, statSync(f).size);
});

test('scanSession: read in small pieces over many Stops (cut inside a message\'s lines) it gives the same totals', () => {
  const d = temp('cb-usage-pieces-');
  const f = join(d, 'sess.jsonl');
  const { text, want } = transcript(60);
  writeFileSync(f, text);
  const s = loadState(d, 'none');
  let runs = 0;
  while (s.files?.main?.offset !== statSync(f).size && runs < 1000) { scanSession(f, s, { bytes: 4096 }); runs++; }
  assert.ok(runs > 10, `${runs} runs`);
  assert.deepEqual(s.totals, want);
});

test('scanSession: a line still being written counts at the next Stop; appended turns add; subagents count too', () => {
  const d = temp('cb-usage-grow-');
  const f = join(d, 'sess.jsonl');
  const one = transcript(5), two = transcript(5, { from: 5 });
  const cut = one.text.length - 40; // mid-line: the synthetic turn's line is cut
  writeFileSync(f, one.text.slice(0, cut));
  const s = loadState(d, 'none');
  scanSession(f, s);
  assert.deepEqual(s.totals, one.want);
  assert.ok(s.files.main.offset < cut);
  appendFileSync(f, one.text.slice(cut) + two.text);
  scanSession(f, s);
  assert.deepEqual(s.totals, add(one.want, two.want));
  // a subagent's transcript: <dir>/<session>/subagents/agent-*.jsonl
  mkdirSync(join(d, 'sess', 'subagents'), { recursive: true });
  const sub = transcript(4, { from: 100, model: 'claude-test-small' });
  writeFileSync(join(d, 'sess', 'subagents', 'agent-a1.jsonl'), sub.text);
  writeFileSync(join(d, 'sess', 'subagents', 'agent-a1.meta.json'), '{}');
  scanSession(f, s);
  assert.deepEqual(s.totals, add(add(one.want, two.want), sub.want));
  assert.equal(s.model, 'claude-test-1', 'the model is the main transcript\'s');
  // a fork's transcript opens with the parent's last message (no parent of its own), already counted in the main one
  const copied = two.text.split('\n').find((l) => l.includes('msg_syn_9'))!.replace('"parentUuid":"u_9"', '"parentUuid":null');
  const fork = transcript(3, { from: 200 });
  writeFileSync(join(d, 'sess', 'subagents', 'agent-f1.jsonl'), `${JSON.stringify({ type: 'fork-context-ref' })}\n${copied}\n${fork.text}`);
  scanSession(f, s);
  assert.deepEqual(s.totals, add(add(add(one.want, two.want), sub.want), fork.want));
  // nothing new: nothing changes
  const before = JSON.stringify(s);
  scanSession(f, s);
  assert.equal(JSON.stringify(s), before);
  // a transcript that shrank was rewritten: counted again from the start
  writeFileSync(f, two.text);
  scanSession(f, s);
  assert.deepEqual(s.totals, add(add(two.want, sub.want), fork.want));
});

test('statuslineCost: the status line\'s cost for this session when written in the last 10 minutes, else none', () => {
  const cfg = temp('cb-usage-cfg-');
  const now = Date.now();
  assert.equal(statuslineCost('s1', now, cfg), null);
  mkdirSync(join(cfg, 'plugins', 'claude-hud'), { recursive: true });
  writeFileSync(join(cfg, 'plugins', 'claude-hud', 'daily-cost.json'), JSON.stringify({ date: '20261127', sessions: {
    s1: { baseline: 0, total: 1.25, ts: now - 60_000 }, s2: { baseline: 0, total: 3, ts: now - 11 * 60_000 }, s3: { total: 'x', ts: now } } }));
  assert.equal(statuslineCost('s1', now, cfg), 1.25);
  assert.equal(statuslineCost('s2', now, cfg), null);
  assert.equal(statuslineCost('s3', now, cfg), null);
  assert.equal(statuslineCost('nope', now, cfg), null);
});

test('cb.usage_report: one cumulative row per session; the same totals again change nothing; never lower; zeros ignored', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo'), cb.ensure_project('other')`;
  await sql`select cb.iam('pc', 'w1:p1', 'W1@pc', 'demo', 'builder')`;
  const rep = async (sid: string, c: number[], cost: number | null = null, model = 'claude-test-1', pane = 'w1:p1') =>
    (await sql`select cb.usage_report(${'PC'}, ${pane}, ${sid}, ${model}, ${c[0]!}::bigint, ${c[1]!}::bigint, ${c[2]!}::bigint, ${c[3]!}::bigint, ${cost}::numeric) as r`)[0].r;
  const row = async (sid: string) => (await sql`select * from cb.session_usage where session_id = ${sid}`)[0];
  assert.equal(await rep('sid-1', [1, 2, 3, 4]), 'new');
  const r1 = await row('sid-1');
  assert.deepEqual([r1.machine, r1.pane, r1.actor, r1.project, r1.model], ['pc', 'w1:p1', 'W1@pc', 'demo', 'claude-test-1']);
  assert.equal(await rep('sid-1', [1, 2, 3, 4]), 'same');
  assert.equal(+(await row('sid-1')).updated_at, +r1.updated_at);
  assert.equal(await rep('sid-1', [5, 6, 7, 8], 0.5), 'updated');
  // a hook that lost its state sends smaller numbers while it catches up: the row keeps the larger
  assert.equal(await rep('sid-1', [2, 2, 2, 2]), 'same');
  const r2 = await row('sid-1');
  assert.deepEqual([r2.input_tokens, r2.output_tokens, r2.cache_read_tokens, r2.cache_write_tokens, r2.cost_usd], ['5', '6', '7', '8', '0.5000']);
  assert.equal(await rep('sid-2', [0, 0, 0, 0]), 'ignored');
  assert.equal(await row('sid-2'), undefined);
  // text where a model id goes is stored as unknown
  assert.equal(await rep('sid-3', [1, 1, 1, 1], null, 'some words with spaces'), 'new');
  assert.equal((await row('sid-3')).model, 'unknown');
  await assert.rejects(rep('bad id!', [1, 1, 1, 1]), /session id/);
  await assert.rejects(rep('sid-4', [-1, 1, 1, 1]), /negative/);
});

const cb = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, ['cli/cb.ts', ...args], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'orch', HERDR_PANE_ID: '', CB_MACHINE: 'testbox', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

test('cb.usage_summary and cb usage: one project or all, the sessions active in the window, cost only where reported', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo'), cb.ensure_project('other')`;
  await sql`select cb.iam('pc', 'w1:p1', 'W1@pc', 'demo', 'builder')`;
  await sql`select cb.iam('pc', 'w2:p1', 'W2@pc', 'other', 'builder')`;
  await sql`select cb.usage_report('pc', 'w1:p1', 'sid-a', 'claude-test-1', 1000, 20000, 3000000, 40000, 1.5)`;
  await sql`select cb.usage_report('pc', 'w1:p1', 'sid-b', 'claude-test-1', 10, 20, 30, 40)`;
  await sql`select cb.usage_report('pc', 'w2:p1', 'sid-c', 'claude-test-1', 7, 7, 7, 7, 2)`;
  await sql`select cb.usage_report('pc', 'w2:p1', 'sid-old', 'claude-test-1', 9, 9, 9, 9, 9)`;
  await sql`update cb.session_usage set updated_at = now() - interval '3 days' where session_id = 'sid-old'`;
  const [{ s }] = await sql`select cb.usage_summary('demo', '24 hours') as s`;
  assert.equal(s.totals.sessions, 2);
  assert.equal(s.totals.output_tokens, 20020);
  assert.equal(Number(s.totals.cost_usd), 1.5);
  assert.equal(s.totals.costed, 1);
  assert.deepEqual(s.sessions.map((r: any) => r.session_id), ['sid-a', 'sid-b']);
  const [{ all }] = await sql`select cb.usage_summary(null, '7 days') as all`;
  assert.equal(all.totals.sessions, 4);

  const r = cb(['usage', 'demo']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^2 sessions in demo active in the last 24h/);
  assert.match(r.out, /\n  in 1010 · out 20k · cache read 3\.0M · cache write 40k · \$1\.50 \(1 of 2 reported a cost\)\n/);
  assert.match(r.out, /\n  W1@pc sid-a claude-test-1: in 1000 · out 20k[^\n]*\$1\.50\n  W1@pc sid-b claude-test-1: in 10 · out 20 · cache read 30 · cache write 40$/);
  const j = cb(['usage', '--all', '--since', '7d', '--json']);
  assert.equal(j.code, 0, j.err);
  assert.equal(JSON.parse(j.out).totals.sessions, 4);
  const bad = cb(['usage', 'demo', '--since', 'yesterday']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--since takes a number and m, h, d or w/);
});

const hook = (stdin: unknown, env: Record<string, string>) => {
  const t = Date.now();
  const r = spawnSync(process.execPath, ['hooks/usage-stop.mjs'], { input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_MACHINE: 'testbox', CLAUDE_CONFIG_DIR: temp('cb-usage-nocfg-'), ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t };
};
// the same, without blocking this process: a board or relay served from here must keep answering while the hook runs
const hookAsync = (stdin: unknown, env: Record<string, string>) => new Promise<{ code: number | null; out: string; err: string; ms: number }>((resolve) => {
  const t = Date.now();
  const c = spawn(process.execPath, ['hooks/usage-stop.mjs'], { env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_MACHINE: 'testbox', CLAUDE_CONFIG_DIR: temp('cb-usage-nocfg-'), ...env } });
  let out = '', err = '';
  c.stdout.on('data', (b) => { out += b; });
  c.stderr.on('data', (b) => { err += b; });
  c.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t }));
  c.stdin.end(JSON.stringify(stdin));
});

test('the Stop hook: sends numbers only, prints nothing, exits 0; no herdr pane or a dead board costs nothing', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo'), cb.ensure_project('other')`;
  await sql`select cb.iam('testbox', ${`p-usage-${process.pid}`}, 'W1@test', 'demo', 'builder')`;
  const d = temp('cb-usage-hook-');
  const f = join(d, 'sess.jsonl');
  const { text, want } = transcript(30);
  writeFileSync(f, text);
  const stdin = { hook_event_name: 'Stop', session_id: 'syn-session-1', transcript_path: f, stop_hook_active: false };
  const env = { HERDR_PANE_ID: `p-usage-${process.pid}`, CB_USAGE_STATE_DIR: d };

  const r = hook(stdin, env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
  const [row] = await sql`select * from cb.session_usage where session_id = 'syn-session-1'`;
  assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens].map(Number), want);
  assert.deepEqual([row.machine, row.actor, row.project, row.model, row.cost_usd], ['testbox', 'W1@test', 'demo', 'claude-test-1', null]);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(MARK));
  assert.doesNotMatch(JSON.stringify(row), /sess\.jsonl/);
  const state = JSON.parse(readFileSync(join(d, 'cb-usage-syn-session-1.json'), 'utf8'));
  assert.deepEqual(state.sent, { model: 'claude-test-1', input: want[0], output: want[1], cacheRead: want[2], cacheWrite: want[3], cost: null });
  assert.doesNotMatch(JSON.stringify(state), new RegExp(MARK));

  // the status line's fresh cost rides along
  const cfg = temp('cb-usage-cfg2-');
  mkdirSync(join(cfg, 'plugins', 'claude-hud'), { recursive: true });
  writeFileSync(join(cfg, 'plugins', 'claude-hud', 'daily-cost.json'), JSON.stringify({ sessions: { 'syn-session-1': { total: 0.75, ts: Date.now() } } }));
  assert.equal(hook(stdin, { ...env, CLAUDE_CONFIG_DIR: cfg }).code, 0);
  assert.equal((await sql`select cost_usd from cb.session_usage where session_id = 'syn-session-1'`)[0].cost_usd, '0.7500');

  // no herdr pane: not a board session, nothing read or written
  const d2 = temp('cb-usage-nopane-');
  const n = hook({ ...stdin, session_id: 'syn-session-2' }, { HERDR_PANE_ID: '', CB_USAGE_STATE_DIR: d2 });
  assert.equal(n.code, 0);
  assert.equal(existsSync(join(d2, 'cb-usage-syn-session-2.json')), false);
  // garbage on stdin, a bad session id: exit 0, silent
  for (const bad of ['not json', { session_id: '../../etc', transcript_path: f }]) {
    const b = hook(bad, { ...env, CB_USAGE_STATE_DIR: d2 });
    assert.deepEqual([b.code, b.out, b.err], [0, '', '']);
  }
  // a board that refuses: exit 0 at once, silent
  const dead = hook({ ...stdin, session_id: 'syn-session-3' }, { ...env, CB_DATABASE_URL: 'postgres://cb@127.0.0.1:1/claude_board' });
  assert.deepEqual([dead.code, dead.out, dead.err], [0, '', '']);
  // a board that takes the connection and never answers: the deadline (DEADLINE_MS 1.9 s) ends the hook, exit 0, silent
  const hung = net.createServer((s) => { s.on('error', () => {}); });
  await new Promise<void>((r) => hung.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (hung.address() as net.AddressInfo).port;
    const h = await hookAsync({ ...stdin, session_id: 'syn-session-4' }, { ...env, CB_DATABASE_URL: `postgres://cb@127.0.0.1:${port}/claude_board` });
    assert.deepEqual([h.code, h.out, h.err], [0, '', '']);
    assert.ok(h.ms > 1000 && h.ms < 10_000, `${h.ms} ms: the deadline, not an early exit, ended it (slack for a loaded machine)`);
  } finally { hung.close(); }
});

// every live seat has a relay, so this is the path the hook takes in production: it rides the relay's connection
test('the Stop hook reports through its seat\'s relay bridge when one is up', { timeout: 60_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  const pane = `p-usage-bridge-${process.pid}`;
  const relaySql = connect(TEST_URL, { app: 'cb-relay', max: 1 }); clients.push(relaySql);
  const served: string[] = [];
  const stop = await serveBridge(relaySql, seatKey('testbox', pane), TEST_URL, undefined, { served: (t: string) => served.push(t) });
  try {
    const d = temp('cb-usage-bridge-');
    const f = join(d, 'sess.jsonl');
    const { text, want } = transcript(8);
    writeFileSync(f, text);
    const h = await hookAsync({ hook_event_name: 'Stop', session_id: 'syn-bridge', transcript_path: f }, { HERDR_PANE_ID: pane, CB_USAGE_STATE_DIR: d });
    assert.deepEqual([h.code, h.out, h.err], [0, '', '']);
    assert.ok(served.some((t) => /cb\.usage_report\(/.test(t)), `served: ${served.join(' | ')}`);
    const [row] = await sql`select * from cb.session_usage where session_id = 'syn-bridge'`;
    assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens].map(Number), want);
  } finally { await stop(); }
});

test('the Stop hook on a large transcript reads at most BYTES_PER_RUN a Stop and catches up over the next ones', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo'), cb.ensure_project('other')`;
  const d = temp('cb-usage-big-');
  const f = join(d, 'big.jsonl');
  const part = transcript(2000, { pad: 4000 });
  let want = [0, 0, 0, 0], i = 0;
  writeFileSync(f, '');
  // ~2000 turns of ~5 KB each, repeated (with fresh ids) to well over a whole run's bytes
  while (statSync(f).size < BYTES_PER_RUN * 1.5) {
    const p = i === 0 ? part : transcript(2000, { from: 2000 * i, pad: 4000 });
    appendFileSync(f, p.text); want = add(want, p.want); i++;
  }
  const stdin = { hook_event_name: 'Stop', session_id: 'syn-big', transcript_path: f };
  const env = { HERDR_PANE_ID: `p-big-${process.pid}`, CB_USAGE_STATE_DIR: d };
  const first = hook(stdin, env);
  assert.equal(first.code, 0, first.err);
  const offset = JSON.parse(readFileSync(join(d, 'cb-usage-syn-big.json'), 'utf8')).files.main.offset;
  assert.ok(offset > 0 && offset <= BYTES_PER_RUN, `read ${offset} bytes`);
  for (let k = 0; k < 20 && JSON.parse(readFileSync(join(d, 'cb-usage-syn-big.json'), 'utf8')).files.main.offset < statSync(f).size; k++)
    assert.equal(hook(stdin, env).code, 0);
  const [row] = await sql`select * from cb.session_usage where session_id = 'syn-big'`;
  assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens].map(Number), want);
});
