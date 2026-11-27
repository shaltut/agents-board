import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';
import { seatKey } from '../cli/bridge.ts';
import { claimTell, refusalWords } from '../cli/relay-refusal.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// every pane carries this process's pid, so back-to-back runs never share a seat's files
const M = 'testbox';
const paneOf = (n: string) => `p-refuse-${n}-${process.pid}`;
const seatFiles = (pane: string) => ['pid', 'log', 'refused'].map((x) => join(tmpdir(), `cb-relay-${seatKey(M, pane)}.${x}`));
const memoOf = (pane: string) => seatFiles(pane)[2]!;
const logOf = (pane: string) => { try { return fs.readFileSync(seatFiles(pane)[1]!, 'utf8'); } catch { return ''; } };
const rmSeat = (pane: string) => { for (const f of seatFiles(pane)) fs.rmSync(f, { force: true }); };
const envFor = (pane: string, o: Record<string, string> = {}) =>
  ({ ...process.env, CB_DATABASE_URL: TEST_URL, CB_MACHINE: M, HERDR_PANE_ID: pane, CB_MCP_GATE_OK: '', CB_AGENT: '', ...o });
const relay = (pane: string, agent: string) => spawnSync('node', ['cli/relay.ts', '--pane', pane, '--agent', agent], { encoding: 'utf8', timeout: 20_000, env: envFor(pane) });
const messages = (sql: any) => sql`select actor, project, summary, data ->> 'to' as to from cb.events where kind = 'message' order by id`;
/** The refusal is told from a detached child: wait for its outcome line in the seat's log (the n-th such line). */
async function outcome(pane: string, n = 1) {
  for (let i = 0; i < 150; i++) {
    const lines = logOf(pane).split('\n').filter((l) => / (told |already told|nobody told)/.test(l));
    if (lines.length >= n) return lines[n - 1]!;
    await wait(100);
  }
  throw new Error(`no outcome ${n} in the log of ${pane}: ${logOf(pane)}`);
}

test('refusalWords (#4429): plain words per reason, never the adapter text (config paths) or a raw agent name', () => {
  assert.equal(refusalWords('claude'), null);
  assert.equal(refusalWords('codex'), 'the board does not run codex seats yet');
  const installed = new Set(['claude', 'codex', 'agy'] as const);
  const gate = refusalWords('codex', { installed, env: {} })!;
  assert.equal(gate, "the MCP check for codex is not done on this seat's machine (CB_MCP_GATE_OK does not name codex there)");
  assert.doesNotMatch(gate, /config|~|\//);
  assert.equal(refusalWords('codex', { installed, env: { CB_MCP_GATE_OK: 'codex' } }), null);
  assert.equal(refusalWords("it's; rm -rf ~"), 'the pane names an agent the board does not know');
});

test('claimTell (#4429 review M1, M2): one claim per mark a day; another mark or a day-old one is claimed again', () => {
  const memo = join(tmpdir(), `cb-relay-claim-${process.pid}.refused`);
  fs.rmSync(memo, { force: true });
  try {
    assert.equal(claimTell(memo, 'W5\nwhy'), true);
    assert.equal(claimTell(memo, 'W5\nwhy'), false); // the second of two at once: the exclusive create refuses it
    assert.equal(claimTell(memo, 'W5\nother'), true);
    assert.equal(fs.readFileSync(memo, 'utf8'), 'W5\nother');
    const old = new Date(Date.now() - 25 * 3600_000);
    fs.utimesSync(memo, old, old);
    assert.equal(claimTell(memo, 'W5\nother'), true);
    assert.equal(claimTell(memo, 'W5\nother'), false);
  } finally { fs.rmSync(memo, { force: true }); }
});

test('the SessionStart hook (relay.ts, no --agent) in a refusing pane returns at once with exit 0, the board unreachable (#4429 review I1)', { timeout: 30_000 }, async () => {
  const pane = paneOf('hook');
  rmSeat(pane);
  try {
    const t0 = Date.now();
    const r = spawnSync('node', ['cli/relay.ts'], { encoding: 'utf8', timeout: 20_000,
      env: envFor(pane, { CB_AGENT: 'codex', CB_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }) });
    const ms = Date.now() - t0;
    assert.equal(r.status, 0, r.stderr);
    // node's own start is most of it; before the fix this waited on the board (5 s connect timeout here) and exited 1
    assert.ok(ms < 2000, `took ${ms} ms`);
    // the detached child still tries, and logs that the board did not answer
    assert.match(await outcome(pane), /nobody told: /);
  } finally { rmSeat(pane); }
});

test('a relay that refuses its agent tells the bound seat\'s project lead once and exits 1; unbound: nobody told, exit 1 (#4429)', { timeout: 90_000 }, async () => {
  const sql = await db();
  const [bound, junk, loose, race] = [paneOf('bound'), paneOf('junk'), paneOf('loose'), paneOf('race')];
  for (const p of [bound, junk, loose, race]) rmSeat(p);
  try {
    await sql`select cb.task_add(project => 'demo', title => 'seed')`;
    await sql`select cb.iam('pc', 'w9:p1', 'orch', 'demo', 'lead')`;
    await sql`select cb.iam(${M}, ${bound}, 'W5@testbox', 'demo', 'builder')`;
    await sql`select cb.iam(${M}, ${junk}, 'W6@testbox', 'demo', 'builder')`;
    await sql`select cb.iam(${M}, ${race}, 'W7@testbox', 'demo', 'builder')`;
    const text = (who: string, words: string) => `${who}'s relay did not start: ${words}. Until it runs, that seat gets no answers, messages or task changes pushed; fix that, then run cb relay in its pane.`;

    const r = relay(bound, 'codex');
    assert.equal(r.status, 1, r.stderr); // an explicit --agent (cb relay): exit 1
    assert.match(await outcome(bound), /told orch$/);
    assert.deepEqual((await messages(sql)).map((m: any) => ({ ...m })),
      [{ actor: 'W5@testbox', project: 'demo', to: 'orch', summary: text('W5@testbox', 'the board does not run codex seats yet') }]);
    assert.match(logOf(bound), /not started: the board does not run codex seats yet/);
    // the same refusal again (a hook start, a restart after a code change): nothing new on the board
    assert.equal(relay(bound, 'codex').status, 1);
    assert.match(await outcome(bound, 2), /already told$/);
    assert.equal((await messages(sql)).length, 1);
    // M1: a start that never holds the seat (a Claude hook with no inbox here) leaves the memo; a day later it is news again
    assert.equal(relay(bound, 'claude').status, 0);
    assert.ok(fs.existsSync(memoOf(bound)));
    const old = new Date(Date.now() - 25 * 3600_000);
    fs.utimesSync(memoOf(bound), old, old);
    assert.equal(relay(bound, 'codex').status, 1);
    assert.match(await outcome(bound, 3), /told orch$/);
    assert.equal((await messages(sql)).length, 2);

    // an unknown agent name never reaches the board text
    assert.equal(relay(junk, "it's;rm -rf ~").status, 1);
    await outcome(junk);
    assert.equal((await messages(sql)).at(-1).summary, text('W6@testbox', 'the pane names an agent the board does not know'));

    // M2: two refusals at the same moment tell once
    const both = [0, 1].map(() => new Promise((res) => spawn('node', ['cli/relay.ts', '--pane', race, '--agent', 'codex'], { stdio: 'ignore', env: envFor(race) }).on('exit', res)));
    await Promise.all(both);
    await outcome(race, 2);
    assert.equal((await messages(sql)).filter((m: any) => m.actor === 'W7@testbox').length, 1);

    // a pane nobody bound yet (a hook start before cb iam): exit 1, nothing told, no memo, so its next refusal still tells
    const before = (await messages(sql)).length;
    assert.equal(relay(loose, 'codex').status, 1);
    assert.match(await outcome(loose), /nobody told: the pane is not bound to a project yet/);
    assert.equal((await messages(sql)).length, before);
    assert.equal(fs.existsSync(memoOf(loose)), false);
  } finally { for (const p of [bound, junk, loose, race]) rmSeat(p); }
});
