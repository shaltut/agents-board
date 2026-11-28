// The board guard in OpenCode 2.x (#4817): its plugin shape and tool names differ from 1.x, whose plugin it never runs. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runOpencodeShim } from '../kit/guard/shim-opencode.mjs';

const kit = (f: string) => fileURLToPath(new URL(`../kit/guard/${f}`, import.meta.url));
const fwd = (p: string) => p.replace(/\\/g, '/');
const CB = ['CB_ROLE', 'CB_AGENT', 'CB_PROTECTED_BRANCHES', 'CB_ALLOW_ASK', 'CB_GUARD_MARKER', 'CB_GUARD_NONCE'];

// the template as the installer fills it: this node, and the shim of this checkout
async function load(t: { after: (fn: () => void) => void }, shim: string | null = kit('shim-opencode.mjs')) {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-plugin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let src = readFileSync(kit('opencode-plugin-v2.js'), 'utf8');
  if (shim !== null) src = src.replace('"__CB_NODE__"', JSON.stringify(fwd(process.execPath))).replace('"__CB_SHIM__"', JSON.stringify(fwd(shim)));
  const file = join(dir, 'cb-guard-v2.mjs');
  writeFileSync(file, src);
  return await import(pathToFileURL(file).href);
}
// what OpenCode 2 does with it: setup once, then the hook before each tool call, with one event object
async function hooked(plugin: any) {
  const hooks: Record<string, (event: unknown) => unknown> = {};
  await plugin.setup({ tool: { hook: async (name: string, fn: (event: unknown) => unknown) => { hooks[name] = fn; } } });
  assert.deepEqual(Object.keys(hooks), ['execute.before']);
  return async (tool: string, input: unknown) => { await hooks['execute.before']!({ tool, input, sessionID: 's1', id: 'c1' }); };
}
function seat(t: { after: (fn: () => void) => void }, role: string) {
  const saved = Object.fromEntries(CB.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of CB) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  for (const k of CB) delete process.env[k];
  Object.assign(process.env, { CB_ROLE: role, CB_AGENT: 'opencode' });
}

test('#4817: the 2.x plugin is one default export with an id, setup, and a server() that adds nothing in 1.x', async (t) => {
  const mod = await load(t);
  assert.deepEqual(Object.keys(mod), ['default']);
  assert.equal(mod.default.id, 'cb-guard');
  assert.deepEqual(await mod.default.server(), {});
});

test('#4817: the 2.x plugin throws the guard\'s reason on a blocked call and lets an allowed one run', async (t) => {
  seat(t, 'builder');
  const call = await hooked((await load(t)).default);
  await call('shell', { command: 'ls -la' });
  await assert.rejects(call('shell', { command: 'git reset --hard' }), /^Error: Blocked dangerous command: git reset --hard/);
  await assert.rejects(call('subagent', { prompt: 'x' }), /unrecognized tool/);
  await call('edit', { path: 'src/a.ts', oldString: 'a', newString: 'b' });
  await call('patch', { patchText: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' });
  await assert.rejects(call('patch', { patchText: '*** Begin Patch\n*** Update File: .claude/settings.json\n*** End Patch' }), /^Error: Blocked/);
});

test('#4817: the 2.x plugin blocks when it is not filled in or the shim is missing', async (t) => {
  seat(t, 'builder');
  for (const shim of [null, join(tmpdir(), 'cb-no-such-folder', 'shim-opencode.mjs')]) {
    const call = await hooked((await load(t, shim)).default);
    await assert.rejects(call('shell', { command: 'ls' }), /^Error: Blocked: the board guard/);
  }
});

// the proof from inside the agent: with no marker holding this launch's nonce, the board refuses the seat
function proof(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-proof-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'marker.json');
  Object.assign(process.env, { CB_GUARD_MARKER: marker, CB_GUARD_NONCE: 'nonce-1' });
  const standIn = (body: string) => { const f = join(dir, 'stand-in-shim.mjs'); writeFileSync(f, body); return f; };
  return { dir, marker, standIn };
}

test('#4817: the loaded 2.x plugin leaves its marker once its hook is in and the shim allowed one call and refused one', async (t) => {
  seat(t, 'builder');
  const { marker } = proof(t);
  await hooked((await load(t)).default);
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).nonce, 'nonce-1');
});

test('#4817: no marker from a guard that did not run, allows everything or refuses everything, or outside a seat', async (t) => {
  seat(t, 'builder');
  const { marker, standIn } = proof(t);
  for (const [what, shim] of [
    ['not filled in', null],
    ['missing shim', join(tmpdir(), 'cb-no-such-folder', 'shim-opencode.mjs')],
    ['allows everything', standIn('process.stdout.write("{}")')],
  ] as const) {
    await hooked((await load(t, shim)).default);
    assert.equal(existsSync(marker), false, what);
  }
  await hooked((await load(t, standIn('process.stdout.write(JSON.stringify({ decision: "block", reason: "Blocked by role (builder): all" }))'))).default);
  assert.equal(existsSync(marker), false, 'refuses everything');
  delete process.env.CB_ROLE;
  delete process.env.CB_AGENT;
  await hooked((await load(t)).default);
  assert.equal(existsSync(marker), false, 'not a seat');
});

test('#4817: with no nonce nothing is written, and a marker that cannot be written leaves the hook in place', async (t) => {
  seat(t, 'builder');
  const { dir, marker } = proof(t);
  delete process.env.CB_GUARD_NONCE;
  await hooked((await load(t)).default);
  assert.equal(existsSync(marker), false);
  Object.assign(process.env, { CB_GUARD_NONCE: 'nonce-2', CB_GUARD_MARKER: join(dir, 'no-such-folder', 'marker.json') });
  const call = await hooked((await load(t)).default);
  await assert.rejects(call('shell', { command: 'git reset --hard' }), /^Error: Blocked dangerous command/);
});

test('#4817: 2.x calls its shell tool "shell", judged as a shell command', () => {
  const run = (command: string, env: Record<string, string>) => runOpencodeShim(JSON.stringify({ tool: 'shell', args: { command } }), env) as { decision?: string; reason?: string };
  assert.deepEqual(run('git status', { CB_ROLE: 'reviewer' }), {});
  assert.match(run('git commit -m x', { CB_ROLE: 'reviewer' }).reason!, /^Blocked by role \(reviewer\): /);
});

test('a shell call\'s workdir is where its command runs: a relative write there is judged there', () => {
  const run = (workdir: unknown, command: string, env: Record<string, string> = { CB_ROLE: 'builder' }) =>
    runOpencodeShim(JSON.stringify({ tool: 'shell', args: { command, workdir } }), env) as { decision?: string; reason?: string };
  assert.equal(run('/home/u/.claude', 'cp x settings.json').decision, 'block');
  assert.equal(run('C:\\Users\\u\\.claude', 'cp x settings.json').decision, 'block');
  assert.deepEqual(run('/home/u/repo', 'cp x settings.json'), {});
  assert.deepEqual(run('/home/u/my repo', 'ls'), {});
  assert.deepEqual(run('', 'ls'), {});
  // a folder name that cannot be quoted safely stops a seat's call
  for (const bad of ['/tmp/a"b', '/tmp/$(x)', '/tmp/a\nb', '/tmp/`x`', 7]) assert.match(run(bad, 'ls').reason!, /workdir/, JSON.stringify(bad));
});
