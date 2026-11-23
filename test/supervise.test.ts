import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { tick } from '../cli/supervise.ts';
import type { Runner } from '../cli/squad-up.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
const conn = (name: string, max = 10) => { const c = postgres(TEST_URL, { onnotice: () => {}, max, connection: { application_name: name } }); clients.push(c); return c; };

const SQUAD = {
  machines: { macbook: { herdr: 'macbook', repo: '/Users/me/Work/sv', board: '/Users/me/board' } },
  roles: { lead: { count: 1, model: 'opus', machine: 'macbook' }, builder: { count: 2, model: 'sonnet', machine: 'macbook' } },
  areas: [], supervise: true,
};
async function setup(projects = ['sv']) {
  const sql = await freshDb(); clients.push(sql);
  for (const p of projects) {
    await sql`select cb.ensure_project(${p})`;
    await sql`select cb.project_pipeline(${p}, true, 'ahmed')`;
    await sql`select cb.squad_set(${p}, ${sql.json(SQUAD)}, 'ahmed')`;
  }
  return { sql, sup: conn('cb-supervisor/test') };
}
async function card(sql: any, o: { stage?: string; assignee?: string | null; status?: string; project?: string } = {}) {
  const [{ id }] = await sql`select cb.task_add(project => ${o.project ?? 'sv'}, title => 'c', type => 'bug', status => 'next', actor => 'orch@pc') as id`;
  await sql`update cb.tasks set stage = ${o.stage ?? 'build'}, stage_since = now(), assignee = ${o.assignee ?? null}, status = ${o.status ?? 'next'} where id = ${id}`;
  return Number(id);
}
const session = (sql: any, actor: string, role: string, o: { live?: boolean; startedMin?: number } = {}) =>
  sql`insert into cb.sessions (machine, pane, actor, project, role, started_at, last_seen)
      values ('macbook', ${actor}, ${actor}, 'sv', ${role}, now() - make_interval(mins => ${o.startedMin ?? 0}), now() - make_interval(mins => ${o.live === false ? 10 : 0}))`;
const events = async (sql: any, what: string) => (await sql`select * from cb.events where actor = 'supervisor' and data ->> 'what' = ${what}`) as any[];

// ---- a fake herdr: nothing real is started; `live` holds the herdr names it reports ----
type Call = { m: string | null; args: string[] };
const OK = { status: 0, stdout: '{}', stderr: '' };
const GONE = { status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found"}}' };
const json = (o: unknown) => ({ status: 0, stdout: JSON.stringify(o), stderr: '' });
function fakeHerdr(o: { down?: string[]; start?: (c: Call) => any; prompt?: (c: Call) => any } = {}) {
  const calls: Call[] = [], live = new Map<string, string>(); // herdr name → pane
  let panes = 0;
  const run: Runner = (m, args) => {
    const c = { m, args }; calls.push(c);
    const [a, b, x] = args;
    if (a === 'agent' && b === 'list') return o.down?.includes(m ?? 'local') ? { status: 1, stdout: '', stderr: 'machine unreachable' }
      : json({ id: 'cli:agent:list', result: { agents: [...live].map(([name, pane_id]) => ({ name, pane_id, agent: 'claude', agent_status: 'idle' })), type: 'agent_list' } });
    if (a === 'agent' && b === 'get') return live.has(x!) ? json({ result: { agent: { name: x, pane_id: live.get(x!) } } }) : GONE;
    if (a === 'tab' || (a === 'pane' && b === 'split')) return json({ result: { pane: { pane_id: `p${++panes}` } } });
    if (a === 'agent' && b === 'start') { const r = o.start?.(c); live.set(x!, args[args.indexOf('--pane') + 1]!); return r ?? OK; }
    if (a === 'agent' && b === 'prompt' && args[3] === '/exit') live.delete(x!);
    if (a === 'agent' && b === 'prompt') return o.prompt?.(c) ?? OK;
    return OK;
  };
  return { calls, run, live };
}
const has = (calls: Call[], ...a: string[]) => calls.some((c) => a.every((x, i) => c.args[i] === x));
const memory = () => ({ failedAt: new Map<string, number>(), blockedTold: new Set<string>(), launched: new Set<string>(), runnerToldAt: 0, runnerStartedAt: 0 });
// a fake clock: sleep moves it, so the close wait's 60 s pass at once
const deps = (sup: any, run: Runner, o: Partial<Parameters<typeof tick>[0]> = {}) => {
  let t = Date.now();
  return { sql: sup, run, dryRun: false, now: Date.now(), memory: memory(), runnerConfig: null, probe: async () => false,
    sleep: async (ms: number) => { t += ms; }, clock: () => t, ...o };
};
const tells = (sql: any, to = 'orch@macbook') => sql`select summary from cb.events where kind = 'message' and data ->> 'to' = ${to}` as Promise<any[]>;

test('a waiting build card starts a builder', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  const h = fakeHerdr();
  const out = await tick(deps(sup, h.run));
  assert.ok(has(h.calls, 'tab', 'create'), out.join('\n'));
  const start = h.calls.find((c) => c.args[0] === 'agent' && c.args[1] === 'start');
  assert.ok(start, out.join('\n'));
  assert.equal(start.m, 'macbook');
  assert.equal(start.args[2], 'sv-b1-macbook');
  const native = start.args.slice(start.args.indexOf('--') + 1);
  assert.deepEqual(native, ['--model', 'sonnet', '--permission-mode', 'bypassPermissions', '--settings', '/Users/me/board/kit/permissions/builder.json']);
  assert.ok(h.calls.some((c) => c.args[1] === 'prompt' && c.args[2] === 'sv-b1-macbook' && c.args[3]!.startsWith('cb iam sv-B1@macbook sv --role builder')));
  assert.ok(!h.calls.some((c) => c.args[1] === 'start' && c.args[2] === 'sv-b2-macbook')); // one card, one builder
  const ev = await events(sql, 'start');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.session, 'sv-B1@macbook');
  assert.equal(ev[0].project, 'sv');
});

test('dry run acts on nothing', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  const h = fakeHerdr();
  const out = await tick(deps(sup, h.run, { dryRun: true }));
  assert.ok(out.includes('would start sv-B1@macbook (builder, sonnet) on macbook'), out.join('\n'));
  assert.ok(h.calls.every((c) => c.args[0] === 'agent' && (c.args[1] === 'list' || c.args[1] === 'get')), JSON.stringify(h.calls));
  assert.equal((await sql`select count(*)::int as n from cb.events where actor = 'supervisor'`)[0].n, 0);
  assert.equal((await sql`select count(*)::int as n from cb.sessions where closing_at is not null`)[0].n, 0);
});

test('herdr unreachable: no start, no restore', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  await session(sql, 'sv-B2@macbook', 'builder', { live: false });
  await card(sql, { assignee: 'sv-B2@macbook', status: 'in_progress' }); // B2 is down and holds a card
  const h = fakeHerdr({ down: ['macbook'] });
  const out = await tick(deps(sup, h.run));
  assert.ok(!h.calls.some((c) => ['start', 'prompt'].includes(c.args[1]!) || c.args[0] === 'tab'), out.join('\n'));
  assert.equal((await sql`select count(*)::int as n from cb.events where actor = 'supervisor'`)[0].n, 0);
});

test('a down session holding a card is restored with cb resume', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B2@macbook', 'builder', { live: false });
  await card(sql, { assignee: 'sv-B2@macbook', status: 'in_progress' });
  const h = fakeHerdr();
  await tick(deps(sup, h.run));
  assert.ok(h.calls.some((c) => c.args[1] === 'prompt' && c.args[2] === 'sv-b2-macbook' && c.args[3]!.endsWith('then cb resume')));
  assert.equal((await events(sql, 'restore')).length, 1);
});

test('close sequence: an idle 21-minute squad session is sent /exit and its pane closed', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 });
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  const out = await tick(deps(sup, h.run));
  assert.ok(has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.ok(has(h.calls, 'pane', 'close', 'w1:p9'), out.join('\n'));
  assert.ok(out.includes('closed sv-B1@macbook'), out.join('\n'));
  assert.equal((await events(sql, 'close')).length, 1);
  assert.notEqual((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null); // fenced until it lapses or the name binds again
});

test('a claim between mark and re-check stops the close', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 });
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  // a held card lands right after the mark committed, before the re-check
  const hooked = new Proxy(sup, {
    apply(t, self, args: any[]) {
      const q = Reflect.apply(t, self, args);
      if (!/supervise_mark\(.*, true\)/.test(String(args[0]?.join?.('?')))) return q;
      return q.then(async (r: any) => { await card(sql, { assignee: 'sv-B1@macbook', status: 'in_progress' }); return r; });
    },
  });
  const out = await tick(deps(hooked, h.run));
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.equal((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null);
  assert.equal((await events(sql, 'close')).length, 0);
});

test('a session that will not exit in 60 s keeps its pane and its mark is cleared', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 });
  const base = fakeHerdr();
  base.live.set('sv-b1-macbook', 'w1:p9');
  let t = 0, gets = 0;
  const run: Runner = (m, args) => {
    if (args[1] === 'prompt') return OK; // /exit ignored
    if (args[1] === 'get') { gets++; t += 35_000; } // each agent get takes 35 s
    return base.run(m, args);
  };
  const out = await tick(deps(sup, run, { clock: () => t, sleep: async (ms: number) => { t += ms; } }));
  assert.ok(gets <= 3, `${gets} agent gets: the wait is bounded by the clock, not by the number of polls`);
  assert.ok(out.includes('could not close sv-B1@macbook'), out.join('\n'));
  assert.ok(!has(base.calls, 'pane', 'close'));
  assert.equal((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null);
  assert.equal((await events(sql, 'close')).length, 0);
});

test('blocked start tells the lead once', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  await session(sql, 'orch@macbook', 'lead');
  const h = fakeHerdr({ start: () => ({ status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_ready","message":"blocked during startup"}}' }) });
  const d = deps(sup, h.run);
  await tick(d);
  await tick({ ...d, now: Date.now() }); // herdr now reports the blocked agent live
  assert.equal(h.calls.filter((c) => c.args[1] === 'start').length, 1);
  assert.ok(!h.calls.some((c) => c.args[1] === 'prompt'));
  assert.equal((await events(sql, 'blocked')).length, 1);
  assert.equal((await events(sql, 'blocked'))[0].data.note, 'p1');
  const tells = await sql`select summary from cb.events where kind = 'message' and data ->> 'to' = 'orch@macbook'`;
  assert.equal(tells.length, 1);
  assert.match(tells[0].summary, /sv-B1@macbook .*pane p1 on macbook.*herdr --machine macbook agent prompt sv-b1-macbook/);
});

test('a blocked start with no lead session to tell is not marked told', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  const h = fakeHerdr({ start: () => ({ status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_ready"}}' }) });
  const d = deps(sup, h.run);
  const out = await tick(d);
  assert.ok(out.some((l) => l.startsWith('could not tell orch@macbook')), out.join('\n'));
  assert.equal(d.memory.blockedTold.size, 0);
});

test('a started session whose first prompt failed is blocked: the lead gets the command once', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  await session(sql, 'orch@macbook', 'lead');
  const h = fakeHerdr({ prompt: (c) => (c.args[3]!.startsWith('cb iam') ? { status: 1, stdout: '', stderr: 'agent_blocked' } : undefined) });
  const d = deps(sup, h.run);
  await tick(d);
  await tick({ ...d, now: Date.now() + 60_000 });
  assert.equal(h.calls.filter((c) => c.args[1] === 'start').length, 1);
  const b = await events(sql, 'blocked');
  assert.equal(b.length, 1);
  assert.match(b[0].data.note, /prompt not sent/);
  assert.equal((await events(sql, 'failed')).length, 0);
  const t = await tells(sql);
  assert.equal(t.length, 1);
  assert.match(t[0].summary, /sv-B1@macbook .*first prompt was not sent.*herdr --machine macbook agent prompt sv-b1-macbook "cb iam sv-B1@macbook sv/);
  assert.ok(!d.memory.failedAt.has('sv-B1@macbook'));
});

test('two supervised projects in one tick share the 3 starts and the Mac count', async () => {
  const { sql, sup } = await setup(['sv', 'sw']);
  for (const project of ['sv', 'sv', 'sw', 'sw']) await card(sql, { project });
  let h = fakeHerdr();
  await tick(deps(sup, h.run));
  assert.equal(h.calls.filter((c) => c.args[1] === 'start').length, 3, 'one budget of 3 across projects');
  // 6 sessions already live on the Mac: room for 2 in all, not 2 per project
  await sql`delete from cb.events`;
  await sql`insert into cb.sessions (machine, pane, actor, last_seen) select 'macbook', 'o' || i, 'other-B' || i || '@macbook', now() from generate_series(1, 6) i`;
  h = fakeHerdr();
  await tick(deps(sup, h.run));
  assert.equal(h.calls.filter((c) => c.args[1] === 'start').length, 2, 'the Mac cap of 8 counts the starts planned for the first project');
});

test('a name that failed to start is not retried for 10 minutes', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  const h = fakeHerdr({ start: () => ({ status: 1, stdout: '', stderr: 'model missing' }) });
  const d = deps(sup, h.run);
  await tick(d);
  h.live.clear();
  await tick({ ...d, now: Date.now() + 60_000 });
  assert.equal(h.calls.filter((c) => c.args[1] === 'start' && c.args[2] === 'sv-b1-macbook').length, 1); // B2 is tried instead
  const f = (await events(sql, 'failed')).filter((e) => e.data.session === 'sv-B1@macbook');
  assert.equal(f.length, 1);
  assert.equal(f[0].data.note, 'model missing');
  assert.ok(d.memory.failedAt.has('sv-B1@macbook'));
});

function runnerJson() {
  const dir = mkdtempSync(join(tmpdir(), 'cb-sup-'));
  const cfg = { ...JSON.parse(readFileSync('docs/ops/runner.example.json', 'utf8')), name: 'pc-test' };
  writeFileSync(join(dir, 'runner.json'), JSON.stringify(cfg));
  return join(dir, 'runner.json');
}

test('runner: no beat and its port free, it is started in a herdr tab', async () => {
  const { sql, sup } = await setup();
  const h = fakeHerdr();
  const out = await tick(deps(sup, h.run, { runnerConfig: runnerJson(), probe: async () => false }));
  const tab = h.calls.find((c) => c.args[0] === 'tab');
  assert.ok(tab, out.join('\n'));
  assert.equal(tab.m, null);
  assert.deepEqual(tab.args.slice(4), ['--label', 'runner', '--no-focus']);
  assert.ok(has(h.calls, 'pane', 'run', 'p1', 'cb runner'));
  const ev = await events(sql, 'runner');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].project, null);
  assert.equal(ev[0].data.note, 'started');
});

test('runner: a beating runner is left alone; a held port is reported at most hourly', async () => {
  const { sql, sup } = await setup();
  const cfg = runnerJson();
  await sql`insert into cb.runners (name, last_seen) values ('pc-test', now())`;
  const h = fakeHerdr();
  await tick(deps(sup, h.run, { runnerConfig: cfg }));
  assert.equal(h.calls.filter((c) => c.args[0] !== 'agent').length, 0);
  await sql`update cb.runners set last_seen = now() - interval '4 minutes'`;
  const d = deps(sup, h.run, { runnerConfig: cfg, probe: async () => true });
  await tick(d);
  await tick({ ...d, now: Date.now() + 60_000 });
  assert.ok(!h.calls.some((c) => c.args[0] === 'tab' || c.args[0] === 'pane'));
  const ev = await events(sql, 'runner');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.note, 'not beating but its port is held');
});

test('runner: a start that does not beat is not retried for 10 minutes; the lead is told hourly', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'orch@macbook', 'lead');
  const h = fakeHerdr();
  const d = deps(sup, h.run, { runnerConfig: runnerJson(), probe: async () => false });
  await tick(d);
  const out = await tick({ ...d, now: d.now + 60_000 });
  await tick({ ...d, now: d.now + 120_000 });
  assert.equal(h.calls.filter((c) => c.args[0] === 'tab').length, 1, 'no second runner tab within 10 minutes');
  assert.ok(out.includes('runner started 1 min ago and still not beating'), out.join('\n'));
  assert.equal((await tells(sql)).length, 1);
  await tick({ ...d, now: d.now + 11 * 60_000 });
  assert.equal(h.calls.filter((c) => c.args[0] === 'tab').length, 2, 'started again after 10 minutes');
});

test('runner: a held port is told to the lead, hourly', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'orch@macbook', 'lead');
  const d = deps(sup, fakeHerdr().run, { runnerConfig: runnerJson(), probe: async () => true });
  await tick(d);
  await tick({ ...d, now: d.now + 60_000 });
  const t = await tells(sql);
  assert.equal(t.length, 1);
  assert.match(t[0].summary, /runner pc-test is not beating but its port is held/);
});

test('a second supervisor exits', async () => {
  await freshDb().then((s) => clients.push(s)); // empty board: nothing a stray tick could act on
  const holder = await conn('cb-supervisor/test', 1).reserve();
  try {
    assert.equal((await holder`select pg_try_advisory_lock(hashtext('cb-supervisor')) as ok`)[0].ok, true);
    const home = mkdtempSync(join(tmpdir(), 'cb-sup-'));
    const r = spawnSync('node', ['cli/supervise.ts', '--once'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_RUNNER_CONFIG: join(home, 'none.json'), CB_SUPERVISOR_HOME: home },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout + r.stderr, /another supervisor is running/);
    const dry = spawnSync('node', ['cli/supervise.ts', '--dry-run'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_RUNNER_CONFIG: join(home, 'none.json'), CB_SUPERVISOR_HOME: home },
    });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr); // a dry run writes nothing: it previews while a supervisor runs
  } finally {
    await holder`select pg_advisory_unlock_all()`;
    holder.release();
  }
});
