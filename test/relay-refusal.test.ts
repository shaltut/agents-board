import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';
import { seatKey } from '../cli/bridge.ts';
import { refusalWords } from '../cli/relay-refusal.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

// every pane carries this process's pid, so back-to-back runs never share a seat's files
const M = 'testbox';
const paneOf = (n: string) => `p-refuse-${n}-${process.pid}`;
const seatFiles = (pane: string) => ['pid', 'log', 'refused'].map((x) => join(tmpdir(), `cb-relay-${seatKey(M, pane)}.${x}`));
const rmSeat = (pane: string) => { for (const f of seatFiles(pane)) fs.rmSync(f, { force: true }); };
const relay = (pane: string, agent: string) => spawnSync('node', ['cli/relay.ts', '--pane', pane, '--agent', agent], {
  encoding: 'utf8', timeout: 20_000, env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_MACHINE: M, HERDR_PANE_ID: pane, CB_MCP_GATE_OK: '' } });
const messages = (sql: any) => sql`select actor, project, summary, data ->> 'to' as to from cb.events where kind = 'message' order by id`;

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

test('a relay that refuses its agent tells the bound seat\'s project lead once and exits 1; unbound: nobody told, exit 1 (#4429)', { timeout: 60_000 }, async () => {
  const sql = await db();
  const [bound, junk, loose] = [paneOf('bound'), paneOf('junk'), paneOf('loose')];
  for (const p of [bound, junk, loose]) rmSeat(p);
  try {
    await sql`select cb.task_add(project => 'demo', title => 'seed')`;
    await sql`select cb.iam('pc', 'w9:p1', 'orch', 'demo', 'lead')`;
    await sql`select cb.iam(${M}, ${bound}, 'W5@testbox', 'demo', 'builder')`;
    await sql`select cb.iam(${M}, ${junk}, 'W6@testbox', 'demo', 'builder')`;

    const r = relay(bound, 'codex');
    assert.equal(r.status, 1, r.stderr);
    const told = await messages(sql);
    assert.deepEqual(told.map((m: any) => ({ ...m })), [{ actor: 'W5@testbox', project: 'demo', to: 'orch',
      summary: "W5@testbox's relay did not start: the board does not run codex seats yet. Until it runs, that seat gets no answers, messages or task changes pushed; fix that, then run cb relay in its pane." }]);
    // the same refusal again (a hook start, a restart after a code change): nothing new on the board
    assert.equal(relay(bound, 'codex').status, 1);
    assert.equal((await messages(sql)).length, 1);
    assert.match(fs.readFileSync(seatFiles(bound)[1]!, 'utf8'), /not started: the board does not run codex seats yet[\s\S]*told orch[\s\S]*already told/);

    // an unknown agent name never reaches the board text
    assert.equal(relay(junk, "it's;rm -rf ~").status, 1);
    const last = (await messages(sql)).at(-1);
    assert.equal(last.summary, "W6@testbox's relay did not start: the pane names an agent the board does not know. Until it runs, that seat gets no answers, messages or task changes pushed; fix that, then run cb relay in its pane.");

    // a pane nobody bound yet (a hook start before cb iam): exit 1, nothing told, so its next refusal still tells
    assert.equal(relay(loose, 'codex').status, 1);
    assert.equal((await messages(sql)).length, 2);
    assert.equal(fs.existsSync(seatFiles(loose)[2]!), false);
    assert.match(fs.readFileSync(seatFiles(loose)[1]!, 'utf8'), /nobody told: the pane is not bound to a project yet/);
  } finally { for (const p of [bound, junk, loose]) rmSeat(p); }
});
