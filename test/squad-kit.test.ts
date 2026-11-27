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
    await loadRoleTexts(sql, join(dir, 'missing')); // a missing folder leaves the texts alone and does not throw
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
  machines: { macbook: { herdr: 'macbook', repo: '/Users/me/Work/x', board: '/Users/me/Work/claude-board' }, shaltoot: { herdr: null, repo: 'F:/Work/x', board: 'F:/Work/claude-board' } },
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
    [mod((s) => { s.extra = 1; }), /unknown key: only machines, roles, areas and supervise .*protected/],
    [mod((s) => { s.roles.builder.extra = 1; }), /role builder has an unknown key/],
    [mod((s) => { s.machines.macbook.extra = 1; }), /machine macbook has an unknown key/],
    [mod((s) => { s.roles.owner.count = 2; }), /owner takes no count/],
    [mod((s) => { s.machines.macbook.herdr = 5; }), /herdr must be a text or null/],
    [mod((s) => { delete s.machines.macbook.herdr; }), /machine macbook needs a herdr key/],
    [mod((s) => { s.machines.Mac_Book = s.machines.macbook; delete s.machines.macbook; s.roles.builder.machine = 'Mac_Book'; s.roles.owner.machine = 'Mac_Book'; }), /machine Mac_Book must be a slug/],
    [mod((s) => { s.machines.macbook.repo = '~/Work/x'; }), /machine macbook repo must be an absolute path/],
    [mod((s) => { s.machines.macbook.board = '~/Work/claude-board'; }), /machine macbook board must be an absolute path/],
    [mod((s) => { s.machines.macbook.repo = 'Work/x'; }), /machine macbook repo must be an absolute path/],
    [mod((s) => { s.machines.macbook.repo = '/Users/me/my work'; }), /machine macbook repo must be an absolute path/],
    [mod((s) => { s.machines.macbook.repo = '/x; rm -rf y'; }), /machine macbook repo must be an absolute path/],
    [mod((s) => { s.machines.macbook.board = '/x\ny'; }), /machine macbook board must be an absolute path/],
    [mod((s) => { s.machines.macbook.workspace = 5; }), /machine macbook workspace must be a herdr workspace label/],
    [mod((s) => { s.machines.macbook.workspace = ''; }), /machine macbook workspace must be a herdr workspace label/],
    [mod((s) => { s.machines.macbook.workspace = 'x'.repeat(65); }), /machine macbook workspace must be a herdr workspace label/],
    [mod((s) => { s.machines.macbook.workspace = 'a\nb'; }), /machine macbook workspace must be a herdr workspace label/],
    [mod((s) => { s.machines.macbook.workspace = '   '; }), /machine macbook workspace must be a herdr workspace label/],
    [mod((s) => { s.machines.macbook.workspace = 'iHop Squad '; }), /machine macbook workspace must be a herdr workspace label/],
    [mod((s) => { s.machines.macbook.workspace = '--focus'; }), /machine macbook workspace must be a herdr workspace label/],
    // the Mac cap counts by the herdr label, whatever the machine key
    [mod((s) => { s.machines.mac = { ...s.machines.macbook }; s.roles.builder.machine = 'mac'; s.roles.builder.count = 7; s.roles.owner.machine = 'mac'; }), /macbook would run 9 sessions/],
    [[1, 2] as any, /squad needs machines and roles objects/],
  ];
  await assert.rejects(() => sql`select cb.squad_set('', ${sql.json(SQUAD)}, 'ahmed')`, /project is required|unknown project/);
  assert.equal((await sql`select count(*)::int as n from cb.events where summary = 'squad updated'`)[0].n, 0);
  for (const [s, re] of bad) await assert.rejects(() => sql`select cb.squad_set('demo', ${sql.json(s)}, 'ahmed')`, re);
});

test('squad_set keeps a machine workspace label (#3719)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const s = mod((x) => { x.machines.macbook.workspace = 'iHop Squad'; });
  await sql`select cb.squad_set('demo', ${sql.json(s)}, 'ahmed')`;
  assert.equal((await sql`select cb.squad_get('demo') as s`)[0].s.machines.macbook.workspace, 'iHop Squad');
});

test('squad_set keeps protected branches; a squad without them saves no protected key (#3746)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const list = ['development', 'releases/*', 'athena-production'];
  await sql`select cb.squad_set('demo', ${sql.json(mod((x) => { x.protected = list; }))}, 'ahmed')`;
  assert.deepEqual((await sql`select cb.squad_get('demo') as s`)[0].s.protected, list);
  await sql`select cb.squad_set('demo', ${sql.json(SQUAD)}, 'ahmed')`;
  assert.deepEqual((await sql`select cb.squad_get('demo') as s`)[0].s, SQUAD);
});

test('squad_set refuses a bad protected list and says what to give (#3746)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const list = /protected: give a list of at most 30 branch names or globs, like \["development", "releases\/\*"\]/;
  const entry = (e: string) => new RegExp(`protected: ${e} is not a branch name or glob: give names like "development" or "releases/\\*" \\(letters, digits, \\. _ / \\* -, at most 100 characters, not starting with -\\)`);
  const bad: [any, RegExp][] = [
    ['development', list],
    [{ development: true }, list],
    [null, list],
    [Array.from({ length: 31 }, (_, i) => `b${i}`), list],
    [[''], entry('""')],
    [['-x'], entry('"-x"')],
    [['my branch'], entry('"my branch"')],
    [['dev;rm'], entry('"dev;rm"')],
    [['x'.repeat(101)], entry(`"${'x'.repeat(101)}"`)],
    [[5], entry('5')],
    [[null], entry('null')],
  ];
  for (const [p, re] of bad) await assert.rejects(() => sql`select cb.squad_set('demo', ${sql.json(mod((x) => { x.protected = p; }))}, 'ahmed')`, re, JSON.stringify(p));
  // the edges that pass: 30 entries, 100 characters, every allowed character
  await sql`select cb.squad_set('demo', ${sql.json(mod((x) => { x.protected = [...Array.from({ length: 29 }, (_, i) => `b${i}`), 'x'.repeat(100)]; }))}, 'ahmed')`;
  await sql`select cb.squad_set('demo', ${sql.json(mod((x) => { x.protected = ['A.z_0/*-9']; }))}, 'ahmed')`;
});

test('squad_set refuses a protected entry the push hook can never match: refs/, heads/ or origin/ first, / last (#3746 C11)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const asGit = (e: string) => new RegExp(`protected: give the branch name as git shows it, like "development" or "releases/\\*", not ${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const bad: [string[], RegExp][] = [
    [['refs/heads/development'], asGit('"refs/heads/development"')],
    [['heads/development'], asGit('"heads/development"')],
    [['origin/development'], asGit('"origin/development"')],
    [['refs/heads/*'], asGit('"refs/heads/*"')],
    [['releases/'], asGit('"releases/"')],
    [['development', 'origin/staging'], asGit('"origin/staging"')], // the bad entry is named, not the list
  ];
  for (const [p, re] of bad) await assert.rejects(() => sql`select cb.squad_set('demo', ${sql.json(mod((x) => { x.protected = p; }))}, 'ahmed')`, re, JSON.stringify(p));
  // the same words inside a name, or without the slash, are names
  const fine = ['releases/*', 'feat/refs/x', 'my-heads/x', 'origin-x', 'refsx/y', 'release/v1', '*'];
  await sql`select cb.squad_set('demo', ${sql.json(mod((x) => { x.protected = fine; }))}, 'ahmed')`;
  assert.deepEqual((await sql`select cb.squad_get('demo') as s`)[0].s.protected, fine);
});

test('squad_set accepts absolute paths on both OS shapes', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const s = mod((x) => { x.machines.shaltoot.repo = 'C:/Work/x'; x.machines.shaltoot.board = 'F:/Work/claude-board'; });
  await sql`select cb.squad_set('demo', ${sql.json(s)}, 'ahmed')`;
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

test('cb squad show prints Claude roles unchanged and prints seats and fallback when configured (#4002)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const s = { machines: SQUAD.machines, roles: { lead: { count: 1, machine: 'shaltoot' },
    builder: { count: 2, machine: 'macbook', fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }], seats: { '2': { model: 'opus' } } },
    reviewer: { count: 1, machine: 'macbook', seats: { '1': { fallback: [{ agent: 'opencode', model: 'anthropic/claude-opus-5-5' }] } } } } };
  await sql`select cb.squad_set('demo', ${sql.json(s as any)}, 'ahmed')`;
  const show = cb(['squad', 'show', 'demo']);
  assert.equal(show.code, 0, show.err);
  assert.equal(show.out, ['lead  1 × opus on shaltoot',
    'builder  2 × sonnet on macbook; fallback gpt-6.1-sol (codex)',
    '  seat 2: opus',
    'reviewer  1 × opus on macbook',
    '  seat 1: opus; fallback anthropic/claude-opus-5-5 (opencode)',
    'areas: none'].join('\n'));
});

// ---- agent-neutral core (#4002): a session and a squad seat carry an agent; claude is the default and never written ----
test('cb.iam stores agent, defaults to claude, preserves on rebind, refuses unknown (#4002)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const agent = async (pane: string) => (await sql`select agent from cb.sessions where machine = 'mac' and pane = ${pane}`)[0].agent;
  await sql`select cb.iam('mac', 'p1', 'W1@mac', 'demo')`;
  assert.equal(await agent('p1'), 'claude', 'a new session without an agent is claude');
  await sql`select cb.iam('mac', 'p2', 'W2@mac', 'demo', agent => 'codex')`;
  assert.equal(await agent('p2'), 'codex');
  await sql`select cb.iam('mac', 'p2', 'W2@mac')`;
  assert.equal(await agent('p2'), 'codex', 'the same name re-binding keeps its agent');
  await sql`select cb.iam('mac', 'p2', 'W2@mac', agent => 'opencode')`;
  assert.equal(await agent('p2'), 'opencode');
  await sql`select cb.iam('mac', 'p2', 'W3@mac')`;
  assert.equal(await agent('p2'), 'claude', 'a pane taken over by another actor starts clean');
  await assert.rejects(() => sql`select cb.iam('mac', 'p3', 'W4@mac', agent => 'grok')`, /agent must be one of claude, codex, opencode, agy/);
  await assert.rejects(() => sql`update cb.sessions set agent = 'grok' where pane = 'p1'`, /sessions_agent_check/);
  // the relay hears a change of agent (cb_bind), and still nothing for a re-bind that changes nothing
  const got: string[] = [];
  const listener = postgres(TEST_URL, { onnotice: () => {} }); clients.push(listener);
  await listener.listen('cb_bind', (x: string) => got.push(x));
  await sql`select cb.iam('mac', 'p1', 'W1@mac')`;
  await sql`select cb.iam('mac', 'p1', 'W1@mac', agent => 'agy')`;
  await sql`select pg_notify('cb_bind', 'end')`;
  for (let i = 0; i < 100 && !got.includes('end'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, ['mac:p1', 'end']);
});

test('cb.sessions_overview, cb.inbox and cb.resume return agent (#4002)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('mac', 'p1', 'W1@mac', 'demo')`;
  await sql`select cb.iam('mac', 'p2', 'W2@mac', 'demo', agent => 'codex')`;
  const rows = (await sql`select cb.sessions_overview('demo') as o`)[0].o as any[];
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.actor, r.agent])), { 'W1@mac': 'claude', 'W2@mac': 'codex' });
  const inbox = async (pane: string) => (await sql`select cb.inbox('mac', ${pane}, 0) as i`)[0].i;
  assert.equal((await inbox('p1')).agent, 'claude');
  assert.equal((await inbox('p2')).agent, 'codex');
  assert.equal((await inbox('p9')).agent, 'claude', 'a relay before cb iam makes a claude session');
  assert.equal((await sql`select cb.resume('W1@mac') as r`)[0].r.agent, 'claude');
  assert.equal((await sql`select cb.resume('W2@mac') as r`)[0].r.agent, 'codex');
});

test('squad_set validates agent gate, per-agent models in fallback, and seats (#4002)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const set = async (s: any) => (await sql`select cb.squad_set('demo', ${sql.json(s)}, 'ahmed') as s`)[0].s;
  const stored = async () => (await sql`select squad::text as t from cb.projects where slug = 'demo'`)[0].t;
  const asJsonb = async (s: any) => (await sql`select ${sql.json(s)}::jsonb::text as t`)[0].t;
  // a Claude-only squad saves byte for byte as before: no agent, fallback or seats keys appear
  assert.deepEqual(await set(SQUAD), SQUAD);
  assert.equal(await stored(), await asJsonb(SQUAD));
  // claude given explicitly is the default: not written
  assert.deepEqual(await set(mod((s) => { s.roles.builder.agent = 'claude'; s.roles.lead.agent = 'claude'; })), SQUAD);
  assert.equal(await stored(), await asJsonb(SQUAD));
  // an empty fallback or seats map, and a seat that only says claude, are not written either
  assert.deepEqual(await set(mod((s) => { s.roles.builder.fallback = []; s.roles.builder.seats = {}; s.roles.owner.seats = { claims: { agent: 'claude' } }; })), SQUAD);

  const fallback = [{ agent: 'codex', model: 'gpt-6.1-sol' }, { agent: 'opencode', model: 'anthropic/claude-opus-5-5' }, { agent: 'agy', model: 'gemini-4-neon-xhigh' }];
  const seat2 = { model: 'opus', fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }] };
  const saved = await set(mod((s) => {
    s.roles.builder.fallback = fallback;
    s.roles.builder.seats = { '2': seat2 };
    s.roles.owner.seats = { claims: { model: 'sonnet' } };
    s.roles.lead.seats = { '1': { agent: 'claude', fallback: [{ agent: 'claude', model: 'sonnet' }] } };
  }));
  assert.deepEqual(saved.roles.builder, { count: 3, model: 'sonnet', machine: 'macbook', fallback, seats: { '2': seat2 } });
  assert.deepEqual(saved.roles.owner, { model: 'opus', machine: 'macbook', seats: { claims: { model: 'sonnet' } } });
  assert.deepEqual(saved.roles.lead, { count: 1, model: 'opus', machine: 'shaltoot', seats: { '1': { fallback: [{ agent: 'claude', model: 'sonnet' }] } } });
  assert.deepEqual((await sql`select cb.squad_get('demo') as s`)[0].s, saved);
  assert.deepEqual(await set(saved), saved, 'a saved squad saves again unchanged');

  const gate = (label: string, k: string) => new RegExp(`: ${label} agent "${k}" cannot be assigned as a primary seat yet \\(phase 1 supports claude only; non-Claude agents are allowed in fallback\\)$`);
  const fb = (f: any) => mod((s) => { s.roles.builder.fallback = f; });
  const bad: [any, RegExp][] = [
    [mod((s) => { s.roles.builder.agent = 'grok'; }), /: builder agent must be one of claude, codex, opencode, agy \(got "grok"\)$/],
    [mod((s) => { s.roles.builder.agent = 5; }), /: builder agent must be one of claude, codex, opencode, agy/],
    [mod((s) => { s.roles.builder.agent = 'codex'; s.roles.builder.model = 'gpt-6.1-sol'; }), gate('builder', 'codex')],
    [mod((s) => { s.roles.owner.agent = 'opencode'; }), gate('owner', 'opencode')],
    [mod((s) => { s.roles.lead.agent = 'agy'; }), gate('lead', 'agy')],
    [mod((s) => { s.roles.builder.seats = { '2': { agent: 'codex', model: 'gpt-6.1-sol' } }; }), gate('builder seat 2', 'codex')],
    [mod((s) => { s.roles.builder.model = null; }), /: builder model must be opus, sonnet, haiku or fable$/],
    [fb({ agent: 'codex', model: 'gpt-6.1-sol' }), /: builder fallback must be a list of at most 5/],
    [fb(Array.from({ length: 6 }, (_, i) => ({ agent: 'codex', model: `gpt-${i}` }))), /: builder fallback must be a list of at most 5/],
    [fb(['codex']), /: builder fallback 1 must be \{"agent": "<agent>", "model": "<model>"\}/],
    [fb([{ agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]), /: builder fallback 1 has an unknown key: only agent and model$/],
    [fb([{ agent: 'grok', model: 'x' }]), /: builder fallback 1 agent must be one of claude, codex, opencode, agy/],
    [fb([{ model: 'gpt-6.1-sol' }]), /: builder fallback 1 agent must be one of claude, codex, opencode, agy/],
    [fb([{ agent: 'codex', model: 'sonnet' }]), /: builder fallback 1 model for codex must be/],
    [fb([{ agent: 'codex', model: 'GPT-6' }]), /: builder fallback 1 model for codex must be/],
    [fb([{ agent: 'codex' }]), /: builder fallback 1 model for codex must be/],
    [fb([{ agent: 'codex', model: 5 }]), /: builder fallback 1 model for codex must be/],
    [fb([{ agent: 'opencode', model: 'claude-opus-5-5' }]), /: builder fallback 1 model for opencode must be provider\/model/],
    [fb([{ agent: 'agy', model: 'opus' }]), /: builder fallback 1 model for agy must be/],
    [fb([{ agent: 'claude', model: 'gpt' }]), /: builder fallback 1 model must be opus, sonnet, haiku or fable$/],
    [fb([{ agent: 'codex', model: 'gpt-6.1-sol' }, { agent: 'codex', model: 'gpt-6.1-sol' }]), /: builder fallback 2 \(codex gpt-6.1-sol\) is listed twice$/],
    [fb([{ agent: 'claude', model: 'sonnet' }]), /: builder fallback 1 \(claude sonnet\) is the same as its own agent and model: a fallback must be another$/],
    [mod((s) => { s.roles.builder.seats = { '2': { model: 'opus', fallback: [{ agent: 'claude', model: 'opus' }] } }; }), /: builder seat 2 fallback 1 \(claude opus\) is the same as its own agent and model/],
    [mod((s) => { s.roles.builder.seats = ['opus']; }), /: builder seats must be an object of seats: \{"<seat>": \{"agent", "model", "fallback"\}\}/],
    [mod((s) => { s.roles.builder.seats = { '4': { model: 'opus' } }; }), /: builder seat 4 is not one of its seats: 1, 2, 3$/],
    [mod((s) => { s.roles.builder.seats = { '01': { model: 'opus' } }; }), /: builder seat 01 is not one of its seats: 1, 2, 3$/],
    [mod((s) => { s.roles.builder.seats = { '1': {} }; }), /: builder seat 1 is empty: give agent, model or fallback$/],
    [mod((s) => { s.roles.builder.seats = { '1': 'opus' }; }), /: builder seat 1 must be an object: \{"agent", "model", "fallback"\}$/],
    [mod((s) => { s.roles.builder.seats = { '1': { machine: 'shaltoot' } }; }), /: builder seat 1 has an unknown key: only agent, model and fallback$/],
    [mod((s) => { s.roles.builder.seats = { '1': { model: 'gpt' } }; }), /: builder seat 1 model must be opus, sonnet, haiku or fable$/],
    [mod((s) => { s.roles.owner.seats = { other: { model: 'sonnet' } }; }), /: owner seat other is not one of its seats: claims, preauth$/],
    [mod((s) => { s.roles.lead.seats = { '2': { model: 'sonnet' } }; }), /: lead seat 2 is not one of its seats: 1$/],
    [mod((s) => { s.roles.builder.extra = 1; }), /: role builder has an unknown key: only count, model, machine, agent, fallback and seats$/],
  ];
  for (const [s, re] of bad) await assert.rejects(() => sql`select cb.squad_set('demo', ${sql.json(s)}, 'ahmed')`, re, JSON.stringify(s.roles));
  assert.deepEqual((await sql`select cb.squad_get('demo') as s`)[0].s, saved, 'a refused squad changes nothing');
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

// #4335: a builder working on its PR went quiet, so the sweep freed the card. Its reviews: keyed on links.pr alone, that
// kept every reviewer and QA holder (links.pr is on every card past build) and held a merged PR's card forever; keyed on
// the poller's open list, it almost never fired (the poller lists only PRs with its card). Kept now while a builder
// holds the card (or part) at build with a PR linked, for a quiet spell under 24 h; then the usual nudge, then free.
test('stage_stalls_due: a builder at build with a PR linked keeps a quiet card for up to 24 h, then the usual rules (#4335)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p2','B1@mac','demo','builder'),
    ('mac','p3','R1@mac','demo','reviewer'), ('mac','p5','B2@mac','demo','builder'), ('pc','p4','orch@pc','demo',null)`;
  const PR = (n: number) => `https://github.com/o/r/pull/${n}`;
  // each freed case differs from the kept one in one thing only (the second review, M4)
  const cases: [string, string, string, string | null][] = [ // title, holder, stage, pr
    ['builder at build, PR linked', 'B1@mac', 'build', PR(5947)],
    ['no PR', 'B1@mac', 'build', null],
    ['the lead at build', 'orch@pc', 'build', PR(5947)],
    ['a reviewer at build', 'R1@mac', 'build', PR(5947)],
    ['builder at review', 'B1@mac', 'review', PR(5947)],
    ['quiet 25 h', 'B2@mac', 'build', PR(5948)], // quiet counts the holder's work anywhere: its own builder
  ];
  for (const [title, who, stage, pr] of cases) {
    const [{ id }] = await sql`select cb.task_add(project => 'demo', title => ${title}, type => 'bug', stage => 'build', why => 'small', actor => 'orch@pc') as id`;
    await sql`update cb.tasks set status = 'in_progress', assignee = ${who}, stage = ${stage}, links = ${pr ? sql.json({ pr }) : sql.json({})} where id = ${id}`;
  }
  const quiet = async (m: string, ids: number[]) => {
    await sql`update cb.tasks set updated_at = now() - ${m}::interval where id = any(${ids})`;
    await sql`update cb.events set at = now() - ${m}::interval where task_id = any(${ids}) and not (data ? 'nudge')`;
  };
  const idle = async (m: string, who: string[]) => {
    await sql`update cb.sessions set started_at = now() - ${m}::interval where actor = any(${who})`;
    await sql`update cb.events set at = least(at, now() - ${m}::interval) where actor = any(${who}) and not (data ? 'nudge')`;
  };
  const nudge = async (id: number) => (await sql`select summary from cb.events where task_id = ${id} and data ? 'nudge' order by id desc limit 1`)[0]?.summary;
  const holder = async (id: number) => (await sql`select assignee from cb.tasks where id = ${id}`)[0].assignee;
  const sweep = () => sql`select cb.stage_stalls_due()`;
  const ALL = [1, 2, 3, 4, 5];
  await idle('40 minutes', ['B1@mac', 'R1@mac', 'orch@pc']); await quiet('40 minutes', ALL);
  await idle('25 hours', ['B2@mac']); await quiet('25 hours', [6]);
  await sweep();
  assert.match(await nudge(1), /^#1 "builder at build, PR linked" has PR #5947 linked, with no update for 0h 40m at .*cb log 1 /);
  assert.doesNotMatch(await nudge(1), /back to the queue/);
  for (const id of [2, 3, 4, 5, 6]) assert.match(await nudge(id), /goes back to the queue in an hour/, `card ${id}`);
  // 110 minutes quiet, the nudges 70 minutes old: only card 1 keeps its holder
  await sql`update cb.stage_nudges set nudged_at = now() - interval '70 minutes'`;
  await idle('110 minutes', ['B1@mac', 'R1@mac', 'orch@pc']); await quiet('110 minutes', ALL);
  await idle('26 hours', ['B2@mac']); await quiet('26 hours', [6]);
  await sweep();
  const held = await sql`select id, assignee from cb.tasks order by id`;
  assert.deepEqual(held.map((r: any) => [Number(r.id), r.assignee]), [[1, 'B1@mac'], [2, null], [3, null], [4, null], [5, null], [6, null]]);
  // a Next hold: kept the same way
  await sql`update cb.tasks set status = 'next' where id = 1`;
  await quiet('110 minutes', [1]);
  await sweep();
  assert.equal(await holder(1), 'B1@mac', 'a Next hold with a PR linked is kept');
  // past 24 h: the PR nudge was no warning (the second review, M1), so first the usual nudge, and free an hour later
  await sql`update cb.tasks set status = 'in_progress' where id = 1`;
  await idle('25 hours', ['B1@mac']); await quiet('25 hours', [1]);
  await sql`update cb.stage_nudges set nudged_at = now() - interval '24 hours 30 minutes' where task_id = 1`;
  await sweep();
  assert.equal(await holder(1), 'B1@mac', 'not freed on the strength of the PR nudge');
  assert.match(await nudge(1), /^#1 .*has had no update for 25h 0m.*goes back to the queue in an hour/);
  await idle('26 hours', ['B1@mac']); await quiet('26 hours', [1]);
  await sql`update cb.stage_nudges set nudged_at = now() - interval '70 minutes' where task_id = 1`;
  await sweep();
  assert.equal(await holder(1), null, 'freed an hour after the usual nudge');

  // parts: the same rule on the part's own holder and stage
  const [{ id: pid }] = await sql`select cb.task_add(project => 'demo', title => 'Parts', type => 'bug', stage => 'build', why => 'small', actor => 'orch@pc') as id`;
  await sql`update cb.tasks set status = 'in_progress', stage = 'build' where id = ${pid}`;
  const part = (repo: string, stage: string, who: string) => sql`insert into cb.task_parts (task_id, repo, stage, status, assignee, pr, since, nudged_at)
    values (${pid}, ${repo}, ${stage}, 'in_progress', ${who}, ${PR(6001)}, now() - interval '110 minutes', now() - interval '70 minutes')`;
  await part('api', 'build', 'B1@mac'); await part('db', 'build', 'R1@mac'); await part('ui', 'review', 'B1@mac');
  await idle('110 minutes', ['B1@mac', 'R1@mac']); await quiet('110 minutes', [Number(pid)]);
  await sweep();
  const parts = await sql`select repo, assignee from cb.task_parts where task_id = ${pid} order by repo`;
  assert.deepEqual(parts.map((r: any) => [r.repo, r.assignee]), [['api', 'B1@mac'], ['db', null], ['ui', null]],
    'only the builder part at build is kept');
  await sql`update cb.task_parts set since = now() - interval '25 hours', nudged_at = now() - interval '24 hours 30 minutes' where task_id = ${pid} and repo = 'api'`;
  await idle('25 hours', ['B1@mac']); await quiet('25 hours', [Number(pid)]);
  await sweep();
  assert.equal((await sql`select assignee from cb.task_parts where task_id = ${pid} and repo = 'api'`)[0].assignee, 'B1@mac', 'part: the usual nudge first');
  assert.match(await nudge(Number(pid)), /\(part api\) has had no update .*goes back to the queue/);
  await sql`update cb.task_parts set since = now() - interval '26 hours', nudged_at = now() - interval '70 minutes' where task_id = ${pid} and repo = 'api'`;
  await idle('26 hours', ['B1@mac']); await quiet('26 hours', [Number(pid)]);
  await sweep();
  assert.equal((await sql`select assignee from cb.task_parts where task_id = ${pid} and repo = 'api'`)[0].assignee, null, 'part: freed an hour later');
});

test('role texts name the repo rules', () => {
  const role = (r: string) => readFileSync(`prompts/roles/${r}.md`, 'utf8');
  const has = (r: string, s: string) => assert.ok(role(r).includes(s), `${r} lacks: ${s}`);
  has('builder', 'cb next gives you cards of your repo');
  has('builder', 'for a card with parts, cb pass passes your part');
  has('reviewer', "you review your repo's part");
  has('qa', 'cb fail <id> --repo <repo>');
  has('lead', '--repo <repo> --commit <sha>');
  has('lead', 'cb stage <id> build --repo');
  has('owner', 'cb edit <id> --repo');
  has('architect', 'cb edit <id> --repo');
  // #3746: an Azure DevOps PR has its own block in each role that handles PRs
  for (const r of ['builder', 'reviewer', 'lead']) has(r, '## On Azure DevOps (a dev.azure.com PR link)');
  has('builder', 'az repos pr create --repository <repo> --source-branch <branch> --target-branch <base>');
  has('reviewer', 'az rest --method post --resource 499b84ac-1321-427f-aa17-267ca6975798');
  has('reviewer', 'git rev-parse pr/<n>^2');
  has('lead', 'az repos pr update --id <n> --status completed');
});
