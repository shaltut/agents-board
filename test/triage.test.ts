// #4535: cb triage. The judge is a fake (CB_TRIAGE_AGENT_CMD): a script that answers from a plan file next to it and
// records the environment and the prompt it got. The board is the test database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';
import { buildLine } from '../kit/fault-line.mjs';
import { redactionProblem, ruleFor, PROJECT } from '../cli/triage.ts';
import { childEnv } from '../cli/triage-agent.ts';

const clients: any[] = [];
const temps: string[] = [];
after(async () => { await Promise.all(clients.map((c) => c.end())); for (const t of temps) rmSync(t, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'cb-triage-')); temps.push(d); return d; };
async function db() { const s = await freshDb(); clients.push(s); await s`select cb.ensure_project(${PROJECT})`; return s; }

const FAKE = `import { readFileSync, writeFileSync } from 'node:fs';
const plan = JSON.parse(readFileSync(new URL('./plan.json', import.meta.url), 'utf8'));
let input = ''; for await (const c of process.stdin) input += c;
writeFileSync(new URL('./seen.json', import.meta.url), JSON.stringify({ env: Object.keys(process.env), args: process.argv.slice(2), prompt: input }));
if (plan.mode === 'hang') await new Promise((r) => setTimeout(r, 60_000));
if (plan.mode === 'garbage') { console.log('not json'); process.exit(0); }
if (plan.mode === 'budget') { console.log(JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 1.01 })); process.exit(1); }
const groups = JSON.parse(input.slice(input.indexOf('GROUPS') + 6));
// the plan's verdict for the groups of its kind (db by default); every other group is a user error
const out = groups.map((g) => g.kind !== (plan.kind ?? 'db') ? { tmpl: g.tmpl, verdict: 'user_error', why: 'the message says what to do' } : ({ tmpl: plan.tmpl ?? g.tmpl, verdict: plan.verdict, why: plan.why ?? 'cli/cb.ts:1 makes it',
  ...(plan.card === 'candidate' ? { existing_card: g.candidates[0]?.id ?? null } : plan.card != null ? { existing_card: plan.card } : {}),
  ...(plan.title ? { title: plan.title, body: plan.body } : {}) }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.12, structured_output: { groups: out } }));`;

function setup() {
  const dir = temp(), home = join(dir, 'faults');
  writeFileSync(join(dir, 'fake.mjs'), FAKE);
  return { dir, home };
}
const plan = (dir: string, p: any) => writeFileSync(join(dir, 'plan.json'), JSON.stringify(p));
const seen = (dir: string) => JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
const BUG = { verdict: 'bug', title: 'Deadlock in the inbox read', body: 'Two reads take the locks in opposite order; cli/cb.ts:1. Expected one answer, got a deadlock.' };

/** Writes fault lines into a fault home: a db error by one seat, wrong use by one and by four seats, an outage. */
function seed(home: string, extra: any[] = []) {
  const now = Date.now(), at = (i: number) => new Date(now - 60_000 * (i + 1));
  const l = (o: any, i: number) => buildLine({ machine: 'testbox', src: 'cb', exit: 1, release: 'abcdef1234', at: at(i), ...o });
  const ls = [
    l({ cmd: 'mine', kind: 'db', code: '40P01', msg: 'deadlock detected', pane: 'p1' }, 0),
    l({ cmd: 'show', kind: 'usage', msg: 'unknown option ‹v›', pane: 'p1' }, 1),
    ...['p1', 'p2', 'p3', 'p4'].map((p, i) => l({ cmd: 'inbox', kind: 'usage', msg: 'unknown command "‹v›"', pane: p }, 2 + i)),
    l({ cmd: 'show', kind: 'not_run', code: 'CONNECT_TIMEOUT', msg: 'board unreachable', pane: 'p1' }, 7),
    ...extra.map((o, i) => l(o, 8 + i)),
  ];
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, `${new Date().toISOString().slice(0, 10)}.jsonl`), ls.map((x) => JSON.stringify(x)).join('\n') + '\n', { flag: 'a' });
  return ls;
}

function cbArgs(dir: string, home: string, env: Record<string, string> = {}) {
  return { encoding: 'utf8' as const, timeout: 60_000,
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'T1@testbox', HERDR_PANE_ID: 'p-triage-secret', CB_MACHINE: 'testbox', CB_AGENT: '',
      CLAUDE_CODE_MESSAGING_SOCKET: '', CB_FAULTS_HOME: home, HOME: dir, USERPROFILE: dir, CB_TRIAGE_AGENT_CMD: join(dir, 'fake.mjs'), CB_SECRET_X: 'x', ...env } };
}
function cb(args: string[], dir: string, home: string, env: Record<string, string> = {}) {
  // HERDR_PANE_ID is set for the child-env check, so cb would try this pane's relay: there is none for this pane
  const r = spawnSync(process.execPath, ['cli/cb.ts', ...args], cbArgs(dir, home, env));
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const bugs = (sql: any) => sql`select id, title, body, type, status, project from cb.tasks where project = ${PROJECT} order by id`;
const notes = (sql: any, id: number) => sql`select summary from cb.events where task_id = ${id} and kind = 'note' order by id`;

test('rules: one or two sessions\' wrong use is a user error and never sent; four sessions\' is sent; the outage is infra', async () => {
  const sql = await db();
  const [{ id: inboxCard }] = await sql`select cb.task_add(${PROJECT}, 'cb inbox is not a command', 'sessions keep typing it', 'next') as id`;
  const { dir, home } = setup();
  const ls = seed(home);
  plan(dir, { verdict: 'unsure' });
  const r = cb(['triage', '--dry-run', '--json'], dir, home);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  const by = (t: string) => j.decisions.find((d: any) => d.tmpl === t);
  assert.equal(by(ls[1]!.tmpl).verdict, 'user_error');
  assert.equal(by(ls[1]!.tmpl).by, 'rule');
  assert.equal(by(ls[6]!.tmpl).verdict, 'infra');
  const groups = JSON.parse(seen(dir).prompt.slice(seen(dir).prompt.indexOf('GROUPS') + 6));
  assert.deepEqual(groups.map((g: any) => g.tmpl).sort(), [ls[0]!.tmpl, ls[2]!.tmpl].sort());
  // the masked message hides the command word: the card about "cb inbox" is found by the command itself
  assert.deepEqual(groups.find((g: any) => g.tmpl === ls[2]!.tmpl).candidates.map((c: any) => c.id), [Number(inboxCard)]);
  // read-only judge, opus by default, the budget passed on
  const args = seen(dir).args;
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob']);
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '1.00');
  assert.ok(!seen(dir).env.some((k: string) => /^(HERDR_|CB_)/.test(k) || k === 'CLAUDE_CODE_MESSAGING_SOCKET'), 'the judge got a session or board variable');
  assert.equal(j.cost_usd, 0.12);
  assert.equal(ruleFor({ kind: 'usage', seats: 3 } as any, undefined, false), null);
  assert.ok(!('HERDR_PANE_ID' in childEnv({ HERDR_PANE_ID: 'x', PATH: 'p' } as any)));
});

test('a dry run writes nothing: no card, no note, no triage.json', async () => {
  const sql = await db();
  const { dir, home } = setup();
  seed(home);
  plan(dir, BUG);
  const before = (await sql`select (select count(*) from cb.tasks)::int t, (select count(*) from cb.events)::int e`)[0];
  const r = cb(['triage', '--dry-run'], dir, home);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /would file +ft-[0-9a-f]{12} +db 40P01 x1 .*"Deadlock in the inbox read"/);
  assert.match(r.out, /judge: \d+ s, USD 0\.12 \(list price\); dry run: nothing filed, triage\.json unchanged/);
  assert.deepEqual((await sql`select (select count(*) from cb.tasks)::int t, (select count(*) from cb.events)::int e`)[0], before);
  assert.equal(existsSync(join(home, 'triage.json')), false);
});

test('the judge\'s answer is checked: garbage, a hang and a spent budget file nothing (exit 1); a card that is not a candidate, or an address in the body, is held', async () => {
  const sql = await db();
  const { dir, home } = setup();
  seed(home);
  for (const p of [{ mode: 'garbage' }, { mode: 'budget' }]) {
    plan(dir, p);
    const r = cb(['triage'], dir, home);
    assert.equal(r.code, 1, r.out);
    assert.match(r.err, /nothing was filed and triage\.json is unchanged/);
  }
  plan(dir, { mode: 'hang' });
  const hung = cb(['triage'], dir, home, { CB_TRIAGE_TIMEOUT_MS: '1500' });
  assert.equal(hung.code, 1);
  assert.match(hung.err, /did not finish within 2 s/);
  plan(dir, { ...BUG, card: 999999 });
  assert.match(cb(['triage', '--dry-run'], dir, home).out, /held +ft-\S+ +db .*card #999999 was not one of its candidates/);
  plan(dir, { ...BUG, body: 'It reads from 10.0.0.7 and fails.', why: 'it read the URL https://example.invalid/x' });
  const held = cb(['triage'], dir, home);
  assert.equal(held.code, 0, held.err);
  assert.match(held.out, /held .*failed the redaction check \(an IPv4 address\)/);
  // the judge's reason is printed too: checked the same way, withheld on a hit
  const why = cb(['triage', '--dry-run', '--json'], dir, home);
  assert.equal(why.code, 0, why.err);
  assert.match(why.out, /the judge's reason is withheld: it failed the redaction check, a URL/);
  assert.doesNotMatch(why.out, /example\.invalid/);
  assert.equal((await bugs(sql)).length, 0);
  assert.equal(redactionProblem('see C:\\Users\\x\\y'), 'a path outside the repo');
  assert.equal(redactionProblem('W1@macbook said so'), 'a session name');
  assert.equal(redactionProblem('token abcd01ef23gh45ij67kl89mn01'), 'a token-like string');
  assert.equal(redactionProblem('on mybox it fails', ['mybox']), 'a machine name');
  assert.equal(redactionProblem('cli/cb.ts:120 throws at 09:12 UTC'), null);
});

test('filing: one bug with the marker; a second run files nothing; another machine adds a note; the cooldown holds without --force', async () => {
  const sql = await db();
  const { dir, home } = setup();
  const ls = seed(home);
  plan(dir, BUG);
  const r = cb(['triage'], dir, home);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /filed #\d+ +ft-/);
  const [card, ...more] = await bugs(sql);
  assert.equal(more.length, 0);
  assert.equal(card.type, 'bug');
  assert.equal(card.title, BUG.title);
  assert.match(card.body, new RegExp(`\\nfault:${ls[0]!.tmpl}$`));
  assert.match(card.body, /- seen: 1 time by 1 session/);
  assert.doesNotMatch(card.body, /testbox|p1/);
  const marker = JSON.parse(readFileSync(join(home, 'triage.json'), 'utf8'));
  assert.equal(marker.groups[ls[0]!.tmpl].card, Number(card.id));
  // the cooldown: one filing run per machine per 6 h
  const again = cb(['triage'], dir, home);
  assert.equal(again.code, 1);
  assert.match(again.err, /one filing run per 6 hours per machine/);
  // --force: already judged here, so nothing new is sent or filed
  const forced = cb(['triage', '--force'], dir, home);
  assert.equal(forced.code, 0, forced.err);
  assert.equal((await bugs(sql)).length, 1);
  // a second machine (its own log and marker), the same fault: a note on the card, never a second card
  const other = setup();
  seed(other.home);
  plan(other.dir, { ...BUG, card: 'candidate' });
  const second = cb(['triage'], other.dir, other.home, { CB_MACHINE: 'otherbox' });
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, new RegExp(`noted #${card.id}`));
  assert.equal((await bugs(sql)).length, 1);
  assert.match((await notes(sql, card.id)).at(-1).summary, /^seen 1 more time by 1 session from .* UTC, release abcdef1234 \(cb triage\)$/);
});

test('filing writes only marked claude-board cards: a named card without the marker gets nothing; a cancelled marked card means noise', async () => {
  const sql = await db();
  const { dir, home } = setup();
  const ls = seed(home);
  const [{ id: plain }] = await sql`select cb.task_add(${PROJECT}, 'deadlock detected in mine', 'a card with the same words, no marker', 'next') as id`;
  plan(dir, { verdict: 'bug', card: 'candidate' });
  // the dry run says the same as the filing run: a card without the marker is shown, never noted
  assert.match(cb(['triage', '--dry-run'], dir, home).out, new RegExp(`same as #${plain} `));
  const r = cb(['triage'], dir, home);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`same as #${plain}`));
  assert.equal((await notes(sql, plain)).length, 0);
  // a cancelled card carrying the marker: the lead ruled it not a fault
  const [{ id: gone }] = await sql`select cb.task_add(${PROJECT}, 'Deadlock', ${`old\n\nfault:${ls[0]!.tmpl}`}, 'next') as id`;
  await sql`select cb.task_move(${String(gone)}, 'cancelled', null, 'ahmed')`;
  const other = setup();
  seed(other.home);
  plan(other.dir, BUG);
  const r2 = cb(['triage'], other.dir, other.home);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, new RegExp(`noise \\(#${gone} cancelled\\)`));
  assert.equal((await bugs(sql)).length, 2);
  // a user_error with a title is never filed
  const third = setup();
  seed(third.home);
  plan(third.dir, { ...BUG, verdict: 'user_error' });
  assert.equal(cb(['triage', '--force'], third.dir, third.home).code, 0);
  assert.equal((await bugs(sql)).length, 2);
});

test('two machines triaging the same new fault at once make one card', async () => {
  const sql = await db();
  const runs = [setup(), setup()];
  for (const m of runs) { seed(m.home); plan(m.dir, BUG); }
  const go = (m: any, name: string) => new Promise<number>((res) => {
    const c = spawn(process.execPath, ['cli/cb.ts', 'triage'], { ...cbArgs(m.dir, m.home, { CB_MACHINE: name }), stdio: 'ignore' });
    c.on('exit', (code) => res(code ?? 1));
  });
  assert.deepEqual(await Promise.all([go(runs[0], 'boxa'), go(runs[1], 'boxb')]), [0, 0]);
  const cards = await bugs(sql);
  assert.equal(cards.length, 1);
  assert.equal((await notes(sql, cards[0].id)).length, 1);
});
