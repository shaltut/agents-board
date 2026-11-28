// #4513: --json on every command prints one JSON value; writes give an object naming what changed. The text is unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, onProject, TEST_URL } from './helpers.ts';
import { help, OVERVIEW_TEXT } from '../cli/help.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', CB_MACHINE: 'mac', CB_AGENT: '',
      CLAUDE_CODE_MESSAGING_SOCKET: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
/** The command with --json: exit 0 and one JSON value on stdout. */
function j(args: string[], env: Record<string, string> = {}) {
  const r = cb([...args, '--json'], env);
  assert.equal(r.code, 0, `cb ${args.join(' ')} --json: ${r.err}`);
  try { return JSON.parse(r.out); } catch { assert.fail(`cb ${args.join(' ')} --json printed text: ${r.out}`); }
}

test('--json: task writes give an object with the id and what changed; text is unchanged (#4513)', async () => {
  const sql = await db();
  // add: was a bare id; now what was stored. The text stays "#<id>".
  assert.equal(cb(['add', 'demo', 'Text stays']).out, '#1');
  assert.deepEqual(j(['add', 'demo', 'Blocker', '-s', 'next']), { id: 2, project: 'demo', status: 'next', stage: null });
  assert.equal(cb(['add', 'demo', 'Waits', '-s', 'next']).out, '#3');
  // block / unblock: was text only
  assert.deepEqual(j(['block', '3', '--by', '2']), { id: 3, by: 2, waits: true, status: 'blocked' });
  assert.equal(cb(['unblock', '3', '--by', '2']).out, '#3 no longer waits on #2 (now next)');
  assert.deepEqual(j(['block', '3', '--by', '#2']), { id: 3, by: 2, waits: true, status: 'blocked' });
  // move: the status read back (normalised), and the cards it released; the text keeps the word given
  assert.equal(cb(['move', '1', 'wip']).out, '#1 → wip');
  assert.deepEqual(j(['move', '1', 'todo']), { id: 1, status: 'next', released: [] });
  // done: #3 waited on #2 only, so it is released
  assert.deepEqual(j(['done', '2', 'merged']), { id: 2, status: 'done', released: [{ id: 3, status: 'next', blocked_on: null, waits_on: [] }] });
  assert.equal(cb(['done', '3', 'ok']).out, '#3 done');
  // edit: the field names given
  assert.deepEqual(j(['edit', '1', '--priority', 'P1', '--title', 'Renamed']), { id: 1, changed: ['title', 'priority'] });
  assert.equal(cb(['edit', '1', '--priority', 'P0']).out, '#1 updated');
  // log: the note's event id, on a card or a project
  const lg = j(['log', '1', 'found it']);
  const [ev] = await sql`select id from cb.events where kind = 'note' and summary = 'found it'`;
  assert.deepEqual(lg, { id: Number(ev.id), task: 1 });
  assert.deepEqual({ ...j(['log', 'demo', 'project note']), id: 0 }, { id: 0, task: null });
  assert.equal(cb(['log', '1', 'again']).out, 'logged');
  // assign: a task and a question
  await sql`select cb.user_add('cai', 'Cai', 'ahmed')`;
  await onProject(sql, 'cai', 'demo');
  assert.deepEqual(j(['assign', '1', 'cai']), { id: 1, kind: 'task', assignee: 'cai' });
});

test('--json: broadcast, huddle open, asks add and page set give objects, not a bare id (#4513)', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'Dates')`;
  for (const [p, a] of [['w1:p3', 'W2@macbook'], ['w1:p4', 'W3@macbook']]) await sql`select cb.iam('mac', ${p}, ${a}, 'demo')`;
  const as = { CB_ACTOR: 'W2@macbook' };
  // broadcast, the twin of tell
  const bc = j(['broadcast', 'deploy at noon', '--project', 'demo'], as);
  const [cast] = await sql`select id from cb.events where kind = 'broadcast'`;
  assert.deepEqual(bc, { id: Number(cast.id), project: 'demo' });
  assert.deepEqual({ ...j(['broadcast', 'hello', '--all'], as), id: 0 }, { id: 0, project: null });
  assert.match(cb(['broadcast', 'text', '--all'], as).out, /^broadcast #\d+ sent to every session$/);
  // huddle open / say / close
  assert.deepEqual(j(['huddle', 'open', 'Date parsing', 'W3@macbook', '-t', '1'], as), { id: 1, members: ['W3@macbook'], task: 1 });
  const say = j(['huddle', 'say', '1', 'partial dates?'], as);
  const [line] = await sql`select id from cb.events where kind = 'huddle' and summary = 'partial dates?'`;
  assert.deepEqual(say, { id: Number(line.id), huddle: 1 });
  assert.equal(cb(['huddle', 'say', '1', 'text'], as).out, 'said in huddle #1');
  assert.deepEqual(j(['huddle', 'close', '1', 'agreed'], as), { id: 1, status: 'closed' });
  assert.match(cb(['huddle', 'open', 'Second', 'W3@macbook'], as).out, /^huddle #2 open with W3@macbook; talk with: cb huddle say 2 "\.\.\."$/);
  // asks add / reply
  assert.deepEqual(j(['asks', 'add', 'Why 27/32?', '-t', '1'], as), { id: 1, task: 1 });
  assert.deepEqual(j(['reply', 'A1', 'a bad date row', '--done'], as), { id: 1, closed: true });
  assert.match(cb(['asks', 'add', 'Next?'], as).out, /^A2 recorded \(asked in your terminal\)/);
  // page set: task page and area page
  const f = join(mkdtempSync(join(tmpdir(), 'cb-json-')), 'p.md');
  writeFileSync(f, '# Design\n');
  assert.deepEqual(j(['page', 'set', '1', '-f', f], as), { task: 1, area: null, project: null, version: 1 });
  writeFileSync(f, '# Design, v2\n'); // the same body again saves no new version
  assert.equal(cb(['page', 'set', '1', '-f', f], as).out, 'page saved, v2');
  assert.deepEqual(j(['page', 'set', '--area', 'claims', '--project', 'demo', '-f', f], as), { task: null, area: 'claims', project: 'demo', version: 1 });
});

test('--json: question writes (withdraw, delivered, reask) give an object (#4513)', async () => {
  const sql = await db();
  const ask = (q: string) => j(['ask', 'demo', q, '-o', 'A', '-o', 'B']).id as number;
  const a = ask('First?'), b = ask('Second?'), c = ask('Third?');
  assert.deepEqual(j(['withdraw', `Q${a}`]), { id: a, status: 'withdrawn' });
  assert.equal(cb(['withdraw', `Q${b}`]).out, `Q${b} withdrawn`);
  await sql`select cb.answer(${String(c)}, 'A')`;
  assert.deepEqual(j(['delivered', `Q${c}`, 'W1@test']), { id: c, delivered_to: 'W1@test' });
  const d = ask('Fourth?');
  await sql`select cb.send_back(${String(d)}, 'details')`;
  assert.deepEqual(j(['reask', `Q${d}`, 'Fourth, with details?']), { id: d, status: 'open', assigned_to: null });
});

test('--json: cb mine rows say open or closed/moved off you; cb start gives an object (#4513)', async () => {
  const sql = await db();
  for (const [title, status, who] of [['working', 'in_progress', 'W1@test'], ['moved off', 'in_progress', 'W1@test'], ['finished', 'next', 'W1@test']] as const)
    await sql`select cb.task_add(project => 'demo', title => ${title}, status => ${status}, assignee => ${who}, actor => 'W1@test')`;
  await sql`select cb.task_update('2', '{"assignee": "W9@test"}'::jsonb, 'orch@test')`;
  await sql`select cb.task_done('3', 'done', '{}'::jsonb, 'W1@test')`;
  const rows = j(['mine']) as any[];
  assert.deepEqual(rows.map((t) => [Number(t.id), t.open]).sort(), [[1, true], [2, false], [3, false]]);
  assert.deepEqual(rows.map((t) => t.stage_words), [null, null, null]); // unstaged: null (staged cards: squad-stages.test.ts)
  // the text still splits them under the heading
  assert.match(cb(['mine']).out, /^#1 \[in_progress\] .*\n\nCLOSED OR MOVED OFF YOU/);
  // cb start: was text even with --json
  const s = j(['start']);
  assert.deepEqual({ ...s, text: typeof s.text }, { actor: 'W1@test', via: '$CB_ACTOR', project: null, relay: 'unavailable', text: 'string' });
  assert.match(s.text, /^You +W1@test \(\$CB_ACTOR\)/);
  assert.equal(cb(['start']).out, s.text);
});

test('cb help says exactly what --json gives: OUTPUT, the flag, cb help json, cb help mine (#4513)', () => {
  assert.match(OVERVIEW_TEXT, /^OUTPUT +plain text; --json prints one JSON value instead \(all but help, runner, supervise: cb help json lists each\)\.$/m);
  assert.match(OVERVIEW_TEXT, /Exit 1 = error on stderr, text even with --json/);
  assert.match(OVERVIEW_TEXT, /^  --json +one JSON value on stdout instead of the text \(cb help json\); errors stay text on stderr$/m);
  const page = help('json')!;
  for (const w of ['add', 'move, done', 'block, unblock', 'edit', 'log', 'broadcast', 'reask', 'withdraw', 'delivered', 'reply',
    'asks add', 'assign', 'huddle open', 'huddle say', 'huddle close', 'page set', 'iam', 'relay', 'start', 'mine'])
    assert.match(page, new RegExp(`(^|  )${w} +[{(a-z]`, 'm'), `cb help json has no entry for ${w}`);
  assert.match(page, /^  add +\{id, project, status, stage\}/m);
  assert.match(page, /^  mine +task rows, each with stage_words \(null when not staged\) and open: true .* or false\n +\(closed or moved off you in the last 24h\)$/m);
  assert.match(help('mine')!, /--json gives the task rows, each with stage_words \(.*\) and open: true \(yours to work on\) or false/);
});

// #4740: Ahmed: a broadcast must say on purpose whether it goes to one project or to every session
test('cb broadcast needs one scope, --project <p> or --all, in the CLI and in SQL (#4740)', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'Dates')`;
  await sql`select cb.iam('mac', 'w1:p3', 'W2@macbook', 'demo')`;
  const as = { CB_ACTOR: 'W2@macbook' };
  const count = async () => Number((await sql`select count(*) as n from cb.events where kind = 'broadcast'`)[0].n);
  for (const scope of [[], ['--project', 'demo', '--all'], ['--project', '']]) {
    const r = cb(['broadcast', 'freeze', ...scope], as);
    assert.equal(r.code, 1, `${scope.join(' ')}: ${r.out}`);
    assert.match(r.err, /one scope: cb broadcast "<message>" --project <p> .* or --all/, scope.join(' '));
  }
  await assert.rejects(sql`select cb.broadcast('freeze', null, 'orch')`, /one scope/);
  await assert.rejects(sql`select cb.broadcast('freeze', 'demo', 'orch', true)`, /one scope/);
  assert.equal(await count(), 0, 'a refused broadcast is not recorded');
  assert.match(cb(['broadcast', 'to all', '--all'], as).out, /^broadcast #\d+ sent to every session$/);
  assert.match(cb(['broadcast', 'to demo', '--project', 'demo'], as).out, /^broadcast #\d+ sent to every demo session$/);
  // the line a session reads names the scope
  const brief = cb(['brief', 'demo'], as).out;
  assert.match(brief, /W2@macbook to everyone: to all/);
  assert.match(brief, /W2@macbook to demo: to demo/);
});

// the goal notices are broadcasts made in SQL: a goal over every project still reaches every session
test('a goal with no project is still announced to every session (#4740)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const web = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'cb-web' } }); clients.push(web);
  await web`select cb.goal_create(title => 'Everywhere', actor => 'ahmed')`;
  const [cast] = await sql`select project, summary from cb.events where kind = 'broadcast'`;
  assert.equal(cast.project, null);
  assert.match(cast.summary, /Everywhere/);
});
