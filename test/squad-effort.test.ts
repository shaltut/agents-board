// #4763 slice 1: an optional effort on a squad role, seat and backup: what cb.squad_set takes, what each agent is started
// with, and how the squad file and the settings page show it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts';
import { ADAPTERS } from '../cli/agents/index.ts';
import { EFFORTS } from '../cli/agents/effort.ts';
import { launchFor, launchSpec, seatSpec, wantList } from '../cli/squad-up.ts';
import { squadShow } from '../cli/squad-show.ts';
import { diffSquads, patchRole, seatEffort, setupLabel, summarizeSquad, type Squad } from '../web/src/lib/squad.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); await s`select cb.ensure_project('demo')`; return s; }

// a made-up one-machine squad (the repo is public: no real names or paths)
const SQUAD: any = {
  machines: { pc: { herdr: null, repo: 'C:/src/demo', board: 'C:/board' } },
  roles: { lead: { count: 1, model: 'opus', machine: 'pc' }, builder: { count: 3, model: 'sonnet', machine: 'pc' } },
  areas: [],
};
const mod = (f: (s: any) => void) => { const s = structuredClone(SQUAD); f(s); return s; };

test('squad_set saves an effort on a role, a seat and a backup, and writes none where none is given', async () => {
  const sql = await db();
  const set = async (s: any) => (await sql`select cb.squad_set('demo', ${sql.json(s)}, 'ahmed') as s`)[0].s;
  assert.deepEqual(await set(SQUAD), SQUAD, 'no effort anywhere: nothing added');
  const saved = await set(mod((s) => {
    s.roles.builder.effort = 'high';
    s.roles.builder.fallback = [{ agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' }, { agent: 'agy', model: 'gemini-4-neon' }];
    // a seat with only an effort of its own; and a seat on another agent, with that agent's effort
    s.roles.builder.seats = { '2': { effort: 'low' }, '3': { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' } };
  }));
  assert.equal(saved.roles.builder.effort, 'high');
  assert.deepEqual(saved.roles.builder.fallback, [{ agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' }, { agent: 'agy', model: 'gemini-4-neon' }]);
  assert.deepEqual(saved.roles.builder.seats, { '2': { effort: 'low' }, '3': { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' } });
  assert.deepEqual(await set(saved), saved, 'a saved squad saves again unchanged');
  assert.ok(!('effort' in saved.roles.lead));
});

test('squad_set refuses an effort the agent does not take, naming the field and the choices', async () => {
  const sql = await db();
  const bad: [any, RegExp][] = [
    [mod((s) => { s.roles.builder.effort = 'ultra'; }), /: builder effort for claude must be one of low, medium, high, xhigh, max \(got "ultra"\): leave it out for the agent's own default$/],
    [mod((s) => { s.roles.builder.effort = 'High'; }), /: builder effort for claude must be one of/],
    [mod((s) => { s.roles.builder.effort = 3; }), /: builder effort for claude must be one of .*\(got 3\)/],
    [mod((s) => { s.roles.builder.effort = null; }), /: builder effort for claude must be one of .*\(got null\)/],
    [mod((s) => { s.roles.builder.agent = 'opencode'; s.roles.builder.model = 'anthropic/claude-opus-5-5'; s.roles.builder.effort = 'high'; }),
      /: builder effort: opencode takes no effort when a seat starts: leave it out$/],
    [mod((s) => { s.roles.builder.seats = { '1': { effort: 'minimal' } }; }), /: builder seat 1 effort for claude must be one of/],
    [mod((s) => { s.roles.builder.fallback = [{ agent: 'agy', model: 'gemini-4-neon', effort: 'ultra' }]; }), /: builder fallback 1 effort for agy must be one of/],
    [mod((s) => { s.roles.builder.fallback = [{ agent: 'codex', model: 'gpt-6.1-sol', speed: 'x' }]; }), /: builder fallback 1 has an unknown key: only agent, model and effort$/],
  ];
  for (const [s, re] of bad) await assert.rejects(() => sql`select cb.squad_set('demo', ${sql.json(s)}, 'ahmed')`, re, JSON.stringify(s.roles.builder));
});

test('squad_options lists the same effort levels the adapters take', async () => {
  const sql = await db();
  const [{ o }] = await sql`select cb.squad_options() as o`;
  assert.deepEqual(o.efforts, EFFORTS);
});

const input = (agent: any, model: string, effort?: string) => ({ name: 'demo-B1@pc', role: 'builder', repo: 'main', agent, model,
  board: 'C:/board', cwd: 'C:/src/demo', env: { CB_ROLE: 'builder', CB_AGENT: agent, CB_OPENCODE_PORT: '41001' }, ...(effort ? { effort } : {}) });
const pair = (args: string[], flag: string, value: string) => args.some((a, i) => a === flag && args[i + 1] === value);

test('each adapter starts a seat with its effort, and adds nothing without one', () => {
  const claude = ADAPTERS.claude.buildLaunch(input('claude', 'sonnet', 'xhigh')).args;
  assert.ok(pair(claude, '--effort', 'xhigh'), claude.join(' '));
  const codex = ADAPTERS.codex.buildLaunch(input('codex', 'gpt-6.1-sol', 'ultra')).args;
  assert.ok(pair(codex, '-c', 'model_reasoning_effort=ultra'), codex.join(' '));
  const agy = ADAPTERS.agy.buildLaunch(input('agy', 'gemini-4-neon', 'low')).args;
  assert.ok(pair(agy, '--effort', 'low'), agy.join(' '));
  for (const [agent, model] of [['claude', 'sonnet'], ['codex', 'gpt-6.1-sol'], ['agy', 'gemini-4-neon']] as const) {
    assert.doesNotMatch(ADAPTERS[agent].buildLaunch(input(agent, model)).args.join(' '), /effort/, agent);
  }
});

test('each adapter refuses an effort it does not take, by name, before anything starts', () => {
  assert.throws(() => ADAPTERS.claude.buildLaunch(input('claude', 'sonnet', 'ultra')), /claude seat demo-B1@pc: effort must be one of low, medium, high, xhigh, max \(got "ultra"\)/);
  assert.throws(() => ADAPTERS.codex.buildLaunch(input('codex', 'gpt-6.1-sol', 'high -s read-only')), /codex seat .*effort must be one of/);
  assert.throws(() => ADAPTERS.agy.buildLaunch(input('agy', 'gemini-4-neon', 'ultra')), /agy seat .*effort must be one of/);
  assert.throws(() => ADAPTERS.opencode.buildLaunch(input('opencode', 'anthropic/claude-opus-5-5', 'high')), /opencode seat demo-B1@pc: opencode takes no effort when a seat starts/);
});

const MIXED: any = mod((s) => {
  s.roles.builder.effort = 'high';
  s.roles.builder.seats = { '2': { effort: 'low' }, '3': { agent: 'codex', model: 'gpt-6.1-sol' } };
});
const want = (n: string) => wantList('demo', MIXED).find((w) => w.name === n)!;

test('a seat takes its own effort, else its role\'s when it runs the role\'s agent', () => {
  assert.equal(seatSpec(MIXED, want('demo-B1@pc')).effort, 'high');
  assert.equal(seatSpec(MIXED, want('demo-B2@pc')).effort, 'low');
  assert.equal(seatSpec(MIXED, want('demo-B3@pc')).effort, undefined, 'another agent does not inherit the effort');
  assert.ok(!('effort' in seatSpec(MIXED, wantList('demo', MIXED).find((w) => w.role === 'lead')!)));
});

test('the effort reaches the launch command, and the seat\'s first prompt says it (#4766)', () => {
  const l = launchFor('demo', MIXED, want('demo-B1@pc'));
  assert.equal(l.effort, 'high');
  assert.ok(pair(launchSpec(l).spec.args, '--effort', 'high'));
  assert.match(l.prompt, / --effort high, then /);
});

test('squad show names the effort each line runs at', () => {
  assert.equal(squadShow(MIXED), [
    'lead  1 × opus on pc',
    'builder  3 × sonnet effort high on pc',
    '  seat 2: sonnet effort low',
    '  seat 3: gpt-6.1-sol (codex)',
    'areas: none'].join('\n'));
  const fb: any = mod((s) => { s.roles.builder.fallback = [{ agent: 'codex', model: 'gpt-6.1-sol', effort: 'max' }]; });
  assert.match(squadShow(fb), /fallback gpt-6\.1-sol effort max \(codex\)/);
});

test('the settings page says the effort, and drops it when the agent changes', () => {
  assert.equal(setupLabel('claude', 'sonnet'), 'Claude Code, Sonnet');
  assert.equal(setupLabel('codex', 'gpt-6.1-sol', 'high'), 'Codex, gpt-6.1-sol, high effort');
  const sq = MIXED as Squad;
  assert.equal(seatEffort(sq.roles.builder!, sq.roles.builder!.seats!['2']!), 'low');
  assert.equal(seatEffort(sq.roles.builder!, sq.roles.builder!.seats!['3']!), undefined);
  const moved = patchRole(sq, 'builder', { agent: 'agy' }, {});
  assert.ok(!('effort' in moved.roles.builder!), 'levels differ by agent, so a new agent starts at its default');
  assert.equal(patchRole(sq, 'builder', { model: 'opus' }, {}).roles.builder!.effort, 'high');
  const back = patchRole(sq, 'builder', { effort: undefined }, {});
  assert.ok(!('effort' in back.roles.builder!), 'picking the default removes the key, which squad_set would refuse as null');
  // a seat on the role's agent would inherit the new one: its effort goes too, and a seat left with nothing goes with it
  const seats = mod((s) => { s.roles.builder.seats = { '1': { effort: 'max' }, '2': { model: 'opus', effort: 'low' }, '3': { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' } }; });
  assert.deepEqual(patchRole(seats, 'builder', { agent: 'opencode' }, {}).roles.builder!.seats,
    { '2': { model: 'opus' }, '3': { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' } });
  assert.match(summarizeSquad(sq).join('\n'), /Claude Code, Sonnet, high effort/);
  assert.match(diffSquads(patchRole(sq, 'builder', { effort: undefined }, {}), sq).join('\n'), /Builders: Claude Code, Sonnet → Claude Code, Sonnet, high effort\./);
});
