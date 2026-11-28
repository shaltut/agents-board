// #4763 slice 2: each machine sends the model lists its own agent CLIs print (cb models report); the settings page offers
// the chosen machine's list. The CLI output is read as data: only model names of the agent's own shape are kept.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';
import { LIST_ARGS, makeLister, modelsShow, parseModels, reportModels, type Lister } from '../cli/models.ts';
import { effortChoices, machineModels, type SquadOptions } from '../web/src/lib/squad.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

// the shapes the three CLIs print (codex 0.160.0, agy 1.5.19, opencode 1.19.4)
const CODEX = JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], base_instructions: 'x' },
  { slug: 'gpt-reserve', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
  { slug: 'gpt-6-luna', visibility: 'list' },
] });
const AGY = 'Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n\n';
const OPENCODE = 'opencode/big-pickle\nanthropic/claude-opus-5-5\r\nUpdate available: run opencode upgrade\n';

test('parseModels reads each CLI\'s list and nothing else', () => {
  assert.deepEqual(parseModels('codex', CODEX), [{ id: 'gpt-6.1-sol', efforts: ['low', 'ultra'] }, { id: 'gpt-6-luna' }], 'a hidden model is not offered');
  assert.deepEqual(parseModels('agy', AGY), [{ id: 'gemini-4-neon-high' }, { id: 'claude-opus-5-5-high' }]);
  assert.deepEqual(parseModels('opencode', OPENCODE), [{ id: 'opencode/big-pickle' }, { id: 'anthropic/claude-opus-5-5' }]);
  assert.throws(() => parseModels('codex', 'error: unrecognized subcommand'), /codex debug models did not print its JSON list/);
  assert.deepEqual(parseModels('agy', 'Error: please sign in\n'), [], 'a message is not a model');
});

test('the list commands are fixed words: each one only lists', () => {
  assert.deepEqual(LIST_ARGS, { codex: ['debug', 'models'], opencode: ['models'], agy: ['models'] });
});

// a fake CLI on PATH (a .cmd on Windows) that runs a node script: it prints its arguments and more than the probe's 256 KB
function fakeCli(t: { after: (fn: () => void) => void }, name: string, script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-fake-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'fake.cjs'), script);
  if (process.platform === 'win32') writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
  else { writeFileSync(join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.cjs" "$@"\n`); chmodSync(join(dir, name), 0o755); }
  return dir;
}

test('the lister runs the CLI\'s list command and reads all of a long answer', (t) => {
  const dir = fakeCli(t, 'codex', `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), pad: 'x'.repeat(700000) }));`);
  const list = makeLister({ timeoutMs: 20_000, env: { ...process.env, PATH: [dir, process.env.PATH ?? process.env.Path ?? ''].join(delimiter) } });
  const r = list('codex');
  assert.ok(r.path && !r.error, r.error);
  const got = JSON.parse(r.out!);
  assert.deepEqual(got.args, ['debug', 'models']);
  assert.equal(got.pad.length, 700000);
});

test('the lister says why a list could not be read', (t) => {
  const dir = fakeCli(t, 'agy', `console.error('please sign in'); process.exit(3);`);
  const list = makeLister({ timeoutMs: 20_000, env: { ...process.env, PATH: dir } });
  assert.match(list('agy').error ?? '', /exit 3/);
  assert.match(list('agy').err ?? '', /please sign in/, '#4856: what it printed is kept, to name a sign-out');
  assert.deepEqual(list('opencode'), { path: null });
});

const fake = (table: Partial<Record<string, { out?: string; err?: string; error?: string }>>): Lister =>
  (agent) => (table[agent] ? { path: `/bin/${agent}`, ...table[agent] } : { path: null });

test('#4856: agy asking to sign in is named as that, however it exits and whichever stream says it', async () => {
  const words = 'Please sign in to view available models\n';
  for (const agy of [{ out: words }, { out: '', err: words }, { error: 'exit 1', out: words }, { error: 'exit 1', err: words }]) {
    const r = await reportModels({ machine: 'pc', save: async () => ({}), list: fake({ agy }) });
    assert.match(r.join('\n'), /agy: list not read \(agy is not signed in in this session\): the board keeps the last one\. [^\n]*ssh[^\n]*herdr pane/, JSON.stringify(agy));
    assert.doesNotMatch(r.join('\n'), /view available models/, 'what the CLI printed is not repeated');
  }
  // a list that was read is sent, whatever else it said; the words from another agent are not read as agy's
  const read = await reportModels({ machine: 'pc', save: async () => ({ agy: 2 }), list: fake({ agy: { out: AGY, err: words } }) });
  assert.match(read.join('\n'), /agy: 2 models sent for pc/);
  const other = await reportModels({ machine: 'pc', save: async () => ({}), list: fake({ opencode: { out: words } }) });
  assert.match(other.join('\n'), /opencode: list not read \(no model names in what `opencode models` printed\)/);
});

test('reportModels sends the lists it could read, and says what it left out', async () => {
  const calls: any[] = [];
  const save = async (machine: string, lists: unknown) => { calls.push([machine, lists]); return { codex: 2 }; };
  const r = await reportModels({ machine: 'pc', save, list: fake({ codex: { out: CODEX }, agy: { error: 'exit 3' } }) });
  assert.deepEqual(calls, [['pc', { codex: parseModels('codex', CODEX) }]]);
  assert.deepEqual(r, [
    'codex: 2 models sent for pc',
    'opencode: not installed here',
    'agy: list not read (exit 3): the board keeps the last one. Run `agy models` here to see why',
  ]);
});

test('reportModels sends nothing when no list could be read', async () => {
  let called = false;
  const r = await reportModels({ machine: 'pc', save: async () => { called = true; return {}; }, list: fake({ agy: { out: 'Error: sign in\n' } }) });
  assert.equal(called, false);
  assert.match(r.join('\n'), /agy: list not read \(no model names in what `agy models` printed\)/);
});

test('machine_models_set keeps only names of the agent\'s own shape and efforts the agent takes', async () => {
  const sql = await db();
  const lists = {
    codex: [{ id: 'gpt-6.1-sol', efforts: ['ultra', 'low', 'banana'] }, { id: 'gpt-6.1-sol' }, { id: 'Not A Model' }, { id: 'opus' }, 'x', { efforts: ['low'] }, { id: 'gpt-6-luna', efforts: 'low' }],
    opencode: [{ id: 'anthropic/claude-opus-5-5', efforts: ['high'] }, { id: 'no-provider' }],
    agy: [{ id: '$(x)' }],
  };
  const [{ r }] = await sql`select cb.machine_models_set('PC', ${sql.json(lists)}, 'B1@pc') as r`;
  assert.deepEqual(r, { codex: 2, opencode: 1, agy: 0 });
  const [{ o }] = await sql`select cb.squad_options() as o`;
  assert.deepEqual(Object.keys(o.machine_models), ['pc']);
  assert.deepEqual(o.machine_models.pc.codex.models, [{ id: 'gpt-6.1-sol', efforts: ['low', 'ultra'] }, { id: 'gpt-6-luna' }], 'the CLI\'s order, each once, efforts in the board\'s order');
  assert.deepEqual(o.machine_models.pc.opencode.models, [{ id: 'anthropic/claude-opus-5-5' }]);
  assert.ok(o.machine_models.pc.codex.at);
  assert.ok(!('agy' in o.machine_models.pc), 'a list with no usable name is not saved');
  // a later report replaces that agent's list and leaves the others; one with nothing usable keeps the last
  await sql`select cb.machine_models_set('pc', ${sql.json({ codex: [{ id: 'gpt-7' }], opencode: [] })}, 'B1@pc')`;
  const [{ o: o2 }] = await sql`select cb.squad_options() as o`;
  assert.deepEqual(o2.machine_models.pc.codex.models, [{ id: 'gpt-7' }]);
  assert.deepEqual(o2.machine_models.pc.opencode.models, [{ id: 'anthropic/claude-opus-5-5' }]);
});

test('machine_models_set refuses a bad report by name', async () => {
  const sql = await db();
  const set = (m: string, l: any, a = 'B1@pc') => sql`select cb.machine_models_set(${m}, ${sql.json(l)}, ${a})`;
  const one = { codex: [{ id: 'gpt-7' }] };
  await assert.rejects(set('my pc', one), /machine must be a machine name .*--machine/);
  await assert.rejects(set('pc', {}), /no model list given/);
  await assert.rejects(set('pc', [1]), /no model list given/);
  await assert.rejects(set('pc', { claude: [] }), /a model list is for codex, opencode or agy \(got claude\)/);
  await assert.rejects(set('pc', { codex: 'gpt-7' }), /codex models must be a list of at most 500/);
  await assert.rejects(set('pc', { codex: Array.from({ length: 501 }, (_, i) => ({ id: `m-${i}` })) }), /at most 500/);
  await assert.rejects(set('pc', one, ' '), /actor is required/);
  // freshDb connects as the dashboard: a session's connection may not take Ahmed's name
  await assert.rejects(sql.begin(async (tx: any) => {
    await tx`set local application_name = 'cb'`;
    await tx`select cb.machine_models_set('pc', ${sql.json(one)}, 'ahmed')`;
  }), /only Ahmed's dashboard can act as ahmed/);
});

test('cb models shows what each machine sent', async () => {
  const sql = await db();
  const cb = (args: string[]) => spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'B1@pc', HERDR_PANE_ID: '' } });
  const empty = cb(['models']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No machine has sent a model list yet\. On each machine run: cb models report/);
  await sql`select cb.machine_models_set('pc', ${sql.json({ codex: [{ id: 'gpt-7' }] })}, 'B1@pc')`;
  assert.match(cb(['models']).stdout, /^pc\n  codex \(1, sent \d{4}-\d\d-\d\d\): gpt-7$/m);
  assert.match(cb(['models', 'reprot']).stderr, /usage: cb models/);
});

test('modelsShow lists machines and agents in a steady order', () => {
  const at = '2026-01-02T03:04:05Z';
  assert.equal(modelsShow({ b: { agy: { models: [{ id: 'g' }], at } }, a: { opencode: { models: [{ id: 'p/m' }, { id: 'p/n' }], at }, codex: { models: [{ id: 'c' }], at } } }),
    'a\n  codex (1, sent 2026-01-02): c\n  opencode (2, sent 2026-01-02): p/m, p/n\nb\n  agy (1, sent 2026-01-02): g');
});

const OPTS = {
  efforts: { claude: ['low', 'high'], codex: ['low', 'high', 'ultra'], opencode: [], agy: ['low', 'high'] },
  machine_models: { pc: { codex: { models: [{ id: 'gpt-7', efforts: ['low'] }, { id: 'gpt-6' }], at: 'x' } }, macbook: { agy: { models: [{ id: 'g' }], at: 'y' } } },
} as unknown as SquadOptions;

test('the page takes the chosen machine\'s list, by its squad name or its herdr label', () => {
  assert.equal(machineModels(OPTS, 'pc', { herdr: null, board: '/b' }, 'codex')!.models.length, 2);
  assert.equal(machineModels(OPTS, 'mac', { herdr: 'MacBook', board: '/b' }, 'agy')!.models[0]!.id, 'g');
  assert.equal(machineModels(OPTS, 'pc', { herdr: null, board: '/b' }, 'agy'), null, 'another machine\'s list is not offered');
  assert.equal(machineModels({ ...OPTS, machine_models: undefined } as any, 'pc', undefined, 'codex'), null);
});

test('the effort list narrows to what the listed model takes, and keeps the saved one', () => {
  const list = OPTS.machine_models!.pc!.codex!;
  assert.deepEqual(effortChoices(OPTS, 'codex', list, 'gpt-7'), ['low']);
  assert.deepEqual(effortChoices(OPTS, 'codex', list, 'gpt-7', 'ultra'), ['low', 'ultra']);
  assert.deepEqual(effortChoices(OPTS, 'codex', list, 'gpt-6'), ['low', 'high', 'ultra'], 'a model that names none: the agent\'s');
  assert.deepEqual(effortChoices(OPTS, 'codex', null, 'gpt-7'), ['low', 'high', 'ultra']);
  assert.deepEqual(effortChoices(OPTS, 'opencode', null, 'p/m'), []);
});
