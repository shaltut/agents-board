// #4351: after a compaction or a resume, the SessionStart hook hands a bound pane what cb resume and cb role print.
// It runs at every session start on every machine: it never fails the start, never waits past its budget, and with the
// board unreachable it prints the hint alone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { serveBridge, seatKey } from '../cli/bridge.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

const M = 'testbox';
const paneOf = (n: string) => `p-ss-${n}-${process.pid}`;
// never this run's own seat: no inbox, no PGAPPNAME (cb would skip its bridge and name its connection by it)
const { PGAPPNAME: _app, ...base } = process.env;
const envFor = (pane: string, o: Record<string, string> = {}) => ({ ...base, CB_DATABASE_URL: TEST_URL, CB_MACHINE: M, HERDR_PANE_ID: pane,
  CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '', CB_ROLE: '', ...o });

/** The hook as Claude runs it (async, so a silent server in this process can still accept), with its wall time. */
function hook(pane: string, source: string | null, o: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const c = spawn('node', ['hooks/session-start.mjs'], { env: envFor(pane, o) });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0 }));
    c.stdin.end(source === null ? '' : JSON.stringify({ hook_event_name: 'SessionStart', source }));
  });
}
const contextOf = (r: { stdout: string }) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
const cb = (pane: string, args: string[]) => {
  const r = spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8', timeout: 30_000, env: envFor(pane) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.replace(/\n$/, '');
};

test('after a compaction or a resume, a bound pane gets what cb resume and cb role print; startup and an unbound pane do not (#4351)', { timeout: 120_000 }, async () => {
  const sql = await db();
  const [bound, loose] = [paneOf('bound'), paneOf('loose')];
  await sql`select cb.task_add(project => 'demo', title => 'Fix the widget', status => 'in_progress', assignee => 'W5@testbox')`;
  await sql`select cb.iam(${M}, ${bound}, 'W5@testbox', 'demo', 'builder')`;
  await sql`select cb.inbox(${M}, ${loose})`; // the relay's own row: no project, so not bound

  const start = await hook(bound, 'startup');
  assert.equal(start.status, 0, start.stderr);
  const hint = contextOf(start);
  assert.match(hint, /^Agents Board: .*run `cb start`/);
  assert.doesNotMatch(hint, /cb resume/);

  const resume = cb(bound, ['resume']), role = cb(bound, ['role', 'builder']);
  assert.match(resume, /#1 \[in_progress\] Fix the widget/);
  // the role text every seat reads carries the rule for when the hook does not print it (review I1)
  // (#4525: in words every agent reads the same way) and, bound in a project, that project's block last
  assert.match(role.replace(/\s+/g, ' '), /If the output of `cb resume` and `cb role <your role>` is not in front of you, run both\./);
  assert.match(role, /\n\n# This project: demo\n\nAsk first when stuck or a decision is needed: the lead /);
  for (const source of ['compact', 'resume', 'fork']) {
    const r = await hook(bound, source);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(contextOf(r), `${hint}\n\nAgents Board, after this ${source}: what \`cb resume\` and \`cb role builder\` print now.\n\n${resume}\n\n${role}`);
    assert.ok(r.ms < 3000, `took ${r.ms} ms`);
    console.log(`# hook wall time, ${source}, bound pane, board up: ${r.ms} ms`);
  }
  // bound with no role (an orchestrator's cb iam names none): cb resume alone
  const plain = paneOf('plain');
  await sql`select cb.iam(${M}, ${plain}, 'W8@testbox', 'demo')`;
  assert.equal(contextOf(await hook(plain, 'compact')), `${hint}\n\nAgents Board, after this compact: what \`cb resume\` prints now.\n\n${cb(plain, ['resume'])}`);
  // clear, no source, or not JSON: today's hint only
  for (const source of ['clear', null]) assert.equal(contextOf(await hook(bound, source)), hint);
  // a pane the relay knows but cb iam never bound, and a pane with no row at all
  assert.equal(contextOf(await hook(loose, 'compact')), hint);
  assert.equal(contextOf(await hook(paneOf('none'), 'compact')), hint);
  // no herdr pane: nothing at all, as before
  const bare = await hook('', 'compact');
  assert.equal(bare.status, 0);
  assert.equal(bare.stdout, '');
});

test('with the seat\'s relay running, the hook asks the board through it, not on a connection of its own (#4351)', { timeout: 120_000 }, async () => {
  const sql = await db();
  const pane = paneOf('relay');
  await sql`select cb.task_add(project => 'demo', title => 'Through the relay', status => 'in_progress', assignee => 'W7@testbox')`;
  await sql`select cb.iam(${M}, ${pane}, 'W7@testbox', 'demo', 'reviewer')`;
  const relaySql = postgres(TEST_URL, { onnotice: () => {}, max: 1 });
  const served: string[] = [];
  const stop = await serveBridge(relaySql, seatKey(M, pane), TEST_URL, undefined, { served: (t) => served.push(t) });
  try {
    const hint = contextOf(await hook(pane, 'startup'));
    assert.deepEqual(served, []); // a plain start never asks the board
    const r = await hook(pane, 'compact');
    assert.equal(r.status, 0, r.stderr);
    const resume = cb(pane, ['resume']), role = cb(pane, ['role', 'reviewer']); // these go through the relay too
    assert.equal(contextOf(r), `${hint}\n\nAgents Board, after this compact: what \`cb resume\` and \`cb role reviewer\` print now.\n\n${resume}\n\n${role}`);
    assert.equal(served[0], 'resume_for_pane');
    assert.equal(served[1], 'role_text');
  } finally {
    await stop();
    await relaySql.end();
  }
});

test('the re-injected block is capped near 7500 characters and says which command prints the rest (#4351, #4525)', { timeout: 120_000 }, async () => {
  const sql = await db();
  const pane = paneOf('big');
  for (let i = 0; i < 40; i++)
    await sql`select cb.task_add(project => 'demo', title => ${`Card ${i} ` + 'x'.repeat(200)}, status => 'in_progress', assignee => 'W6@testbox')`;
  await sql`select cb.iam(${M}, ${pane}, 'W6@testbox', 'demo', 'builder')`;
  const hint = contextOf(await hook(pane, 'startup'));
  const r = await hook(pane, 'compact');
  assert.equal(r.status, 0, r.stderr);
  const block = contextOf(r).slice(hint.length);
  assert.ok(block.length <= 7700, `block is ${block.length} characters`);
  assert.match(block, /\[cut here: run `cb resume` for the rest\]/);
  // the role text keeps its place, whole with the project's block (#4525): the cards are what gets cut
  assert.match(block, /# Rules for every role/);
  assert.doesNotMatch(block, /\[cut here: run `cb role/);
  assert.ok(block.endsWith((await sql`select cb.role_text('builder', 'demo') as t`)[0].t), 'cb role builder printed whole, project block last');
});

// #4525 review M6: a board whose schema predates the project argument (rolled back, or a copy updated out of order)
// still hands the role over: the board-wide text alone, never nothing
test('the project-aware read failing, the hook falls back to the board-wide role text (#4525)', { timeout: 120_000 }, async () => {
  const sql = await db();
  const pane = paneOf('old');
  await sql`select cb.task_add(project => 'demo', title => 'On an older board', status => 'in_progress', assignee => 'W4@testbox')`;
  await sql`select cb.iam(${M}, ${pane}, 'W4@testbox', 'demo', 'qa')`;
  const board = (await sql`select cb.role_text('qa') as t`)[0].t;
  await sql`alter function cb.role_text(text, text, text) rename to role_text_4525`;
  try {
    await sql`create function cb.role_text(role text) returns text language sql stable as $$ select cb.role_text_4525(role) $$`;
    const r = await hook(pane, 'compact');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(contextOf(r).endsWith(`\n\n${board}`), 'the board-wide qa text, whole and last');
    assert.match(contextOf(r), /what `cb resume` and `cb role qa` print now/);
  } finally {
    await sql`drop function if exists cb.role_text(text)`;
    await sql`alter function cb.role_text_4525(text, text, text) rename to role_text`;
  }
});

test('a stdin left open after its JSON does not hold a plain start (#4351)', { timeout: 30_000 }, async () => {
  const down = { CB_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' };
  const ended = (await hook(paneOf('open'), 'startup', down)).ms;
  const t0 = Date.now();
  const c = spawn('node', ['hooks/session-start.mjs'], { env: envFor(paneOf('open'), down) });
  let stdout = '';
  c.stdout.on('data', (d) => { stdout += d; });
  c.stdin.write(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' })); // never ended
  const status = await new Promise((r) => c.on('close', r));
  const ms = Date.now() - t0;
  c.stdin.destroy();
  assert.equal(status, 0);
  assert.match(contextOf({ stdout }), /^Agents Board: /);
  assert.ok(ms < ended + 500, `took ${ms} ms, ${ended} ms with stdin ended`); // not the 1 s stdin wait
});

test('the board unreachable (refused, silent, or an error): the hint alone, exit 0, nothing on stderr, under 3 s (#4351)', { timeout: 60_000 }, async () => {
  const pane = paneOf('down');
  const hint = contextOf(await hook(pane, 'startup', { CB_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }));
  // a sleeping board: the connection opens and nothing ever answers
  const held: net.Socket[] = [];
  const silent = net.createServer((s) => { s.on('error', () => {}); held.push(s); }); // the hook's exit resets it
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  const port = (silent.address() as net.AddressInfo).port;
  try {
    const wrongDb = new URL(TEST_URL); wrongDb.pathname = '/claude_board_test_no_such_db';
    for (const url of ['postgres://nobody@127.0.0.1:1/none', `postgres://nobody@127.0.0.1:${port}/none`, wrongDb.href]) {
      const r = await hook(pane, 'compact', { CB_DATABASE_URL: url });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
      // review I1: the hint names the commands to run by hand, never why the board failed
      assert.equal(contextOf(r), `${hint}\nAfter this compact the board did not answer in time: if you hold a seat, run \`cb resume\` and \`cb role <your role>\` yourself.`, url);
      assert.ok(r.ms < 3000, `${url}: took ${r.ms} ms`);
      console.log(`# hook wall time, board ${url.includes(`:${port}/`) ? 'silent' : url.includes(':1/') ? 'refused' : 'answers with an error'}: ${r.ms} ms`);
    }
    // the pane's CB_ROLE (squad up sets it) names the role when it is one; anything else stays a placeholder
    const silentUrl = `postgres://nobody@127.0.0.1:${port}/none`;
    assert.match(contextOf(await hook(pane, 'resume', { CB_DATABASE_URL: silentUrl, CB_ROLE: 'reviewer' })),
      /\nAfter this resume the board did not answer in time: if you hold a seat, run `cb resume` and `cb role reviewer` yourself\.$/);
    assert.match(contextOf(await hook(pane, 'fork', { CB_DATABASE_URL: silentUrl, CB_ROLE: 'x; rm -rf' })), /`cb role <your role>` yourself\.$/);
    // a plain start says nothing of it
    assert.doesNotMatch(contextOf(await hook(pane, 'startup', { CB_DATABASE_URL: silentUrl, CB_ROLE: 'reviewer' })), /did not answer/);
  } finally {
    for (const s of held) s.destroy();
    silent.close();
  }
});

test('the prompts keep the compaction rule for seats the hook does not reach (#4351 review I1)', async () => {
  const { readFileSync } = await import('node:fs');
  const one = (f: string) => readFileSync(f, 'utf8').replace(/\s+/g, ' ');
  for (const f of ['prompts/roles/_common.md', 'prompts/session.md'])
    // #4525: agent-neutral, so a seat on any agent reads the same rule
    assert.match(one(f), /Lost context \(a compaction, a restart\)\? If the output of `cb resume` and `cb role <your role>` is not in front of you, run both\./, f);
  assert.match(one('prompts/orchestrator.md'), /After a compaction, if the start hook did not print `cb resume` and `cb role` \(or you run on another agent\), run them\./);
});
