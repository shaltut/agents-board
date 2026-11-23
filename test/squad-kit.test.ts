import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { loadRoleTexts } from '../db/roles.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('role texts load from prompts/roles and survive freshDb', async () => {
  const sql = await db();
  const [{ n }] = await sql`select count(*)::int as n from cb.role_texts`;
  assert.equal(n, 8);
  const common = readFileSync('prompts/roles/_common.md', 'utf8').trim();
  const [{ t }] = await sql`select cb.role_text('builder') as t`;
  assert.equal(t, common + '\n\n' + readFileSync('prompts/roles/builder.md', 'utf8').trim());
});

test('loadRoleTexts updates and deletes', async () => {
  const sql = await db();
  const dir = mkdtempSync(join(tmpdir(), 'roles-'));
  try {
    writeFileSync(join(dir, '_common.md'), 'common\n');
    writeFileSync(join(dir, 'builder.md'), 'one\n');
    await loadRoleTexts(sql, dir);
    assert.equal((await sql`select cb.role_text('builder') as t`)[0].t, 'common\n\none');
    writeFileSync(join(dir, 'builder.md'), 'two\n');
    await loadRoleTexts(sql, dir);
    assert.equal((await sql`select cb.role_text('builder') as t`)[0].t, 'common\n\ntwo');
    unlinkSync(join(dir, 'builder.md'));
    await loadRoleTexts(sql, dir);
    assert.equal((await sql`select count(*)::int as n from cb.role_texts where role = 'builder'`)[0].n, 0);
    assert.equal((await sql`select count(*)::int as n from cb.role_texts`)[0].n, 1);
  } finally {
    rmSync(dir, { recursive: true });
    await loadRoleTexts(sql, 'prompts/roles'); // put the real texts back for later tests
  }
});

test('cb.role_text refuses an unknown role', async () => {
  const sql = await db();
  await assert.rejects(sql`select cb.role_text('ghost')`, /unknown role ghost: one of lead, architect, owner, builder, reviewer, qa, investigator/);
});

test('every command a role file names exists', async () => {
  const help = readFileSync('cli/help.ts', 'utf8');
  const known = new Set([...help.matchAll(/^    ([a-z-]+): \{/gm)].map((m) => m[1]));
  for (const f of readdirSync('prompts/roles')) {
    const text = readFileSync(join('prompts/roles', f), 'utf8');
    assert.ok(text.split('\n').length <= 60, `${f} is over 60 lines`);
    for (const m of text.matchAll(/\bcb ([a-z]+)(?: ([a-z]+))?/g)) {
      assert.ok(known.has(m[1]), `${f}: cb ${m[1]} is not a command`);
      // commands whose help lists subcommands: the second word must be one of them
      const subs = ({ page: ['show', 'set'], huddle: ['open', 'say', 'add', 'show', 'close'], lock: ['take', 'release', 'queue'] } as Record<string, string[]>)[m[1]];
      if (subs && m[2]) assert.ok(subs.includes(m[2]), `${f}: cb ${m[1]} ${m[2]} is not a subcommand`);
    }
  }
});

test('cb role prints the text; cb iam ends with the role line', async () => {
  const sql = await db();
  const r = cb(['role', 'reviewer']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, (await sql`select cb.role_text('reviewer') as t`)[0].t);
  const j = cb(['role', 'reviewer', '--json']);
  const p = JSON.parse(j.out);
  assert.equal(p.role, 'reviewer');
  assert.equal(p.text, r.out);
  await sql`select cb.ensure_project('demo')`;
  const i = cb(['iam', 'R9@mac', 'demo', '--role', 'reviewer'], { HERDR_PANE_ID: 'p9' });
  assert.equal(i.code, 0, i.err);
  assert.equal(i.out.split('\n').at(-1), 'Your role: cb role reviewer');
});

test('cb resume ends with the role line in a pipeline project', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`update cb.projects set pipeline = true where name = 'demo'`;
  await sql`select cb.iam('mac', 'p8', 'B8@mac', 'demo', 'builder')`;
  const r = cb(['resume'], { CB_ACTOR: 'B8@mac' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n').at(-1), 'Your role: cb role builder');
});

const SQUAD = {
  machines: { macbook: { herdr: 'macbook', repo: '~/Work/x', board: '~/Work/claude-board' }, shaltoot: { herdr: null, repo: 'F:/Work/x', board: 'F:/Work/claude-board' } },
  roles: { lead: { count: 1, model: 'opus', machine: 'shaltoot' }, builder: { count: 3, model: 'sonnet', machine: 'macbook' }, owner: { model: 'opus', machine: 'macbook' } },
  areas: ['claims', 'preauth'],
};
const mod = (f: (s: any) => void) => { const s = structuredClone(SQUAD); f(s); return s; };

test('squad_set saves a valid squad and squad_get returns it', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  assert.equal((await sql`select cb.squad_get('demo') as s`)[0].s, null);
  await sql`select cb.squad_set('demo', ${sql.json(SQUAD)}, 'ahmed')`;
  assert.deepEqual((await sql`select cb.squad_get('demo') as s`)[0].s, SQUAD);
  assert.equal((await sql`select count(*)::int as n from cb.events where summary = 'squad updated'`)[0].n, 1);
});

test('squad_set refuses each invalid squad with the field named', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const bad: [any, RegExp][] = [
    [mod((s) => { s.roles.wizard = { count: 1, machine: 'macbook' }; }), /unknown role wizard/],
    [mod((s) => { s.roles.builder.count = 0; }), /builder count must be/],
    [mod((s) => { s.roles.builder.count = 9; }), /builder count must be/],
    [mod((s) => { s.roles.builder.count = 99999999999; }), /builder count must be/],
    [mod((s) => { s.roles.lead.count = 2; }), /lead count must be 1/],
    [mod((s) => { s.roles.builder.model = 'gpt'; }), /builder model must be/],
    [mod((s) => { s.roles.builder.machine = 'nowhere'; }), /builder machine is not in machines/],
    [mod((s) => { delete s.machines.macbook.repo; }), /machine macbook needs a repo/],
    [mod((s) => { delete s.machines.macbook.board; }), /machine macbook needs a board/],
    [mod((s) => { s.areas = []; }), /owner needs areas/],
    [mod((s) => { delete s.roles.owner; }), /areas need an owner role/],
    [mod((s) => { s.areas = ['Bad Area']; }), /area "Bad Area" must be a slug/],
    [mod((s) => { s.areas = [null]; }), /area null must be a slug/],
    [mod((s) => { s.areas = ['claims', 'claims']; }), /area claims is listed twice/],
    [mod((s) => { s.roles.builder.count = 7; }), /macbook would run 9 sessions/],
    [mod((s) => { s.extra = 1; }), /unknown key: only machines, roles and areas/],
    [mod((s) => { s.roles.builder.extra = 1; }), /role builder has an unknown key/],
    [mod((s) => { s.machines.macbook.extra = 1; }), /machine macbook has an unknown key/],
    [mod((s) => { s.roles.owner.count = 2; }), /owner takes no count/],
    [mod((s) => { s.machines.macbook.herdr = 5; }), /herdr must be a text or null/],
    [[1, 2] as any, /squad needs machines and roles objects/],
  ];
  await assert.rejects(() => sql`select cb.squad_set('', ${sql.json(SQUAD)}, 'ahmed')`, /project is required|unknown project/);
  assert.equal((await sql`select count(*)::int as n from cb.events where summary = 'squad updated'`)[0].n, 0);
  for (const [s, re] of bad) await assert.rejects(() => sql`select cb.squad_set('demo', ${sql.json(s)}, 'ahmed')`, re);
});

test('squad_set: only the dashboard or a lead; role-less and unknown callers are refused', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values
    ('mac','p1','W1@mac','demo','builder'), ('mac','p3','W2@mac','demo',null), ('pc','p2','orch@pc','demo',null), ('pc','p4','L1@pc','demo','lead')`;
  const session = postgres(TEST_URL, { onnotice: () => {} }); clients.push(session);
  for (const who of ['W1@mac', 'W2@mac', 'nobody@nowhere'])
    await assert.rejects(() => session`select cb.squad_set('demo', ${session.json(SQUAD)}, ${who})`, /only Ahmed or the lead/);
  await session`select cb.squad_set('demo', ${session.json(SQUAD)}, 'orch@pc')`;
  await session`select cb.squad_set('demo', ${session.json(SQUAD)}, 'L1@pc')`;
});

test('squad_set saves complete: areas [] and models filled; show prints', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const s = { machines: SQUAD.machines, roles: { lead: { count: 1, machine: 'shaltoot' }, builder: { count: 2, machine: 'macbook' }, reviewer: { count: 1, machine: 'macbook' } } };
  const saved = (await sql`select cb.squad_set('demo', ${sql.json(s as any)}, 'ahmed') as s`)[0].s;
  assert.deepEqual(saved.areas, []);
  assert.equal(saved.roles.lead.model, 'opus');
  assert.equal(saved.roles.builder.model, 'sonnet');
  assert.deepEqual((await sql`select cb.squad_get('demo') as s`)[0].s, saved);
  assert.deepEqual((await sql`select data from cb.events where summary = 'squad updated'`)[0].data, { squad: saved });
  const show = cb(['squad', 'show', 'demo']);
  assert.equal(show.code, 0, show.err);
  assert.equal(show.out, 'lead  1 × opus on shaltoot\nbuilder  2 × sonnet on macbook\nreviewer  1 × opus on macbook\nareas: none');
});

test('cb squad set reads stdin', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('pc','p2','orch@pc','demo',null)`;
  const r = spawnSync('node', ['cli/cb.ts', 'squad', 'set', 'demo', '-f', '-'], { encoding: 'utf8', input: JSON.stringify(SQUAD),
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'orch@pc', HERDR_PANE_ID: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual((await sql`select cb.squad_get('demo') as s`)[0].s, SQUAD);
});

test('cb squad set / show', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('pc','p2','orch@pc','demo',null)`;
  const dir = mkdtempSync(join(tmpdir(), 'squad-'));
  try {
    writeFileSync(join(dir, 's.json'), JSON.stringify(SQUAD));
    const set = cb(['squad', 'set', 'demo', '-f', join(dir, 's.json')], { CB_ACTOR: 'orch@pc' });
    assert.equal(set.code, 0, set.err);
    const show = cb(['squad', 'show', 'demo']);
    assert.equal(show.code, 0, show.err);
    assert.match(show.out, /builder {2}3 × sonnet on macbook/);
    assert.match(show.out, /areas: claims, preauth/);
    assert.deepEqual(JSON.parse(cb(['squad', 'show', 'demo', '--json']).out), SQUAD);
  } finally { rmSync(dir, { recursive: true }); }
});

// Q2357: a card that waits on a person's answer is not chased for silence
async function waitingCard(sql: any) {
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('pc', 'p1', 'W1@pc', 'demo')`;
  await sql`select cb.iam('pc', 'p2', 'orch@pc', 'demo')`;
  await sql`select cb.task_add(project => 'demo', title => 'Fix the thing', status => 'in_progress', assignee => 'W1@pc', actor => 'W1@pc')`;
  await sql`select cb.task_ping_set('1', true, 'ahmed')`;
  const age = (mins: number) => sql`update cb.tasks set updated_at = now() - ${mins + ' minutes'}::interval where id = 1`
    .then(() => sql`update cb.events set at = now() - ${mins + ' minutes'}::interval where task_id = 1 and not (data ? 'nudge')`);
  const pings = async () => (await sql`select cb.pings_due() as n`)[0].n;
  return { age, pings };
}

test('pings_due: an open question holds the pings; answering restarts the clock (Q2357)', async () => {
  const sql = await db();
  const { age, pings } = await waitingCard(sql);
  const [{ q }] = await sql`select cb.ask(project => 'demo', body => 'Which way?', task_id => '1', actor => 'W1@pc') as q`;
  await age(120);
  assert.equal(await pings(), 0, 'waiting on a person is not silence');
  await sql`select cb.answer(${String(q)}, 'This way', 'ahmed')`;
  assert.equal(await pings(), 0, 'the answer is an update: the clock restarted');
  await age(120);
  assert.equal(await pings(), 2, 'two hours after the answer it is chased again');
});

test('pings_due: a withdrawn, dormant, answered or sent-back question does not hold the pings (Q2357)', async () => {
  for (const status of ['withdrawn', 'dormant', 'answered', 'sent_back']) {
    const sql = await db();
    const { age, pings } = await waitingCard(sql);
    await sql`select cb.ask(project => 'demo', body => 'Which way?', task_id => '1', actor => 'W1@pc')`;
    await sql`update cb.questions set status = ${status}, answer = 'x' where task_id = 1`;
    await age(120);
    assert.equal(await pings(), 2, status);
  }
});

test('stage_stalls_due: no nudge to the holder of a card waiting on a person (Q2357)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p2','B1@mac','demo','builder'), ('pc','p4','orch@pc','demo',null)`;
  await sql`select cb.task_add(project => 'demo', title => 'Fix the thing', type => 'bug', stage => 'build', why => 'small', actor => 'orch@pc')`;
  await sql`update cb.tasks set status = 'in_progress', assignee = 'B1@mac' where id = 1`;
  const [{ q }] = await sql`select cb.ask(project => 'demo', body => 'Which way?', task_id => '1', actor => 'B1@mac') as q`;
  const m = '40 minutes';
  await sql`update cb.tasks set updated_at = now() - ${m}::interval where id = 1`;
  await sql`update cb.sessions set started_at = now() - ${m}::interval where actor = 'B1@mac'`;
  await sql`update cb.events set at = now() - ${m}::interval where (task_id = 1 or actor = 'B1@mac') and not (data ? 'nudge')`;
  const due = async () => (await sql`select cb.stage_stalls_due() as n`)[0].n;
  assert.equal(await due(), 0, 'open question: no nudge');
  await sql`update cb.questions set status = 'dormant' where id = ${q}`;
  await sql`update cb.events set at = now() - ${m}::interval where task_id = 1 and not (data ? 'nudge')`; // the flip wrote an event
  assert.equal(await due(), 1, 'a dormant question does not hold it');
});
