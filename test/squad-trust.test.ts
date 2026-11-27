// #4575 cb squad trust: the adapters' folder-trust preseed, the run against a temp home, squad up's early stop and the
// guard's block. Pure: no database, and never the real home folder (every file is under a temp HOME).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ADAPTERS } from '../cli/agents/index.ts';
import { editFile, squadTrust, trustTargets, homeTrust } from '../cli/squad-trust.ts';
import { squadUp, type Runner } from '../cli/squad-up.ts';
import { evaluate } from '../kit/guard/core.mjs';

const pre = (agent: 'claude' | 'codex' | 'agy', platform: NodeJS.Platform) => ADAPTERS[agent].trustSpec([], platform).preseed!;
const home = () => mkdtempSync(join(tmpdir(), `cb-trust-${process.pid}-`));
const put = (h: string, rel: string, text: string) => { mkdirSync(dirname(join(h, rel)), { recursive: true }); writeFileSync(join(h, rel), text); };
const CLAUDE = '.claude.json', CODEX = '.codex/config.toml', AGY = '.gemini/antigravity-cli/settings.json';

test('claude preseed: projects[<forward-slash path>].hasTrustDialogAccepted, other keys kept', () => {
  const p = pre('claude', 'win32');
  assert.equal(p.file, CLAUDE);
  const text = JSON.stringify({ numStartups: 3, projects: { 'C:/w/other': { allowedTools: [], hasTrustDialogAccepted: true }, 'C:/w/x': { allowedTools: ['a'] } } }, null, 2);
  assert.equal(p.state(text, 'C:\\w\\x\\'), 'absent');
  const out = p.add(text, 'C:\\w\\x\\');
  const j = JSON.parse(out);
  assert.deepEqual(j.projects['C:/w/x'], { allowedTools: ['a'], hasTrustDialogAccepted: true });
  assert.equal(j.numStartups, 3);
  assert.equal(j.projects['C:/w/other'].hasTrustDialogAccepted, true);
  assert.equal(p.state(out, 'C:/w/x'), 'trusted');
  assert.equal(p.state(out, 'C:/w/other'), 'trusted');
  assert.match(out, /^\{\n  "numStartups"/); // the file's own 2-space layout
  // no projects yet: made
  assert.equal(JSON.parse(p.add('{"a":1}', '/home/me/repo')).projects['/home/me/repo'].hasTrustDialogAccepted, true);
});

test('codex preseed: [projects.\'<path>\'] trust_level = "trusted"; Windows keys lower case with backslashes, as Codex writes them', () => {
  const w = pre('codex', 'win32'), x = pre('codex', 'linux');
  assert.equal(w.file, CODEX);
  const base = 'model = "gpt"\n\n[features]\nhooks = true\n';
  assert.equal(w.state(base, 'C:/W/Sq-Board'), 'absent');
  const out = w.add(base, 'C:/W/Sq-Board');
  assert.ok(out.startsWith(base), 'the existing lines stay as they were');
  assert.match(out, /\n\[projects\.'c:\\w\\sq-board'\]\ntrust_level = "trusted"\n$/);
  assert.equal(w.state(out, 'c:\\w\\sq-board\\'), 'trusted');
  // Codex's own entries, either quoting, any case on Windows
  assert.equal(w.state(`[projects.'C:\\W\\X']\ntrust_level = "trusted"\n`, 'c:/w/x'), 'trusted');
  assert.equal(w.state(`[projects."c:\\\\w\\\\x"]\ntrust_level = "trusted"\n`, 'C:/w/x'), 'trusted');
  // a folder Ahmed marked untrusted is left alone
  assert.equal(w.state(`[projects.'c:\\w\\x']\ntrust_level = "untrusted"\n`, 'C:/w/x'), 'untrusted');
  // a table with no trust_level gets the line, never a second header (a duplicate table is a TOML error)
  const bare = `[projects.'c:\\w\\x']\nfoo = 1\n\n[other]\nk = 2\n`;
  const fixed = w.add(bare, 'C:/w/x');
  assert.equal(fixed.match(/\[projects\./g)!.length, 1);
  assert.equal(w.state(fixed, 'C:/w/x'), 'trusted');
  assert.match(fixed, /\[other\]\nk = 2\n$/);
  // POSIX keeps case and slashes; no trailing newline in the file still gives a valid table
  assert.match(x.add('a = 1', '/Users/Me/Work/demo/'), /^a = 1\n\n\[projects\.'\/Users\/Me\/Work\/demo'\]\ntrust_level = "trusted"\n$/);
  assert.equal(x.state(`[projects.'/users/me/work/demo']\ntrust_level = "trusted"\n`, '/Users/Me/Work/demo'), 'absent');
  assert.throws(() => x.add('', "/w/it's"), /quote/);
});

test('agy preseed: trustedWorkspaces gets the native path; Windows compares without case', () => {
  const w = pre('agy', 'win32'), x = pre('agy', 'darwin');
  assert.equal(w.file, AGY);
  const text = JSON.stringify({ runningLightSpeed: 'fast', trustedWorkspaces: ['C:\\Users\\me'] }, null, 2);
  assert.equal(w.state(text, 'c:/users/ME'), 'trusted');
  const out = w.add(text, 'C:/w/x/');
  assert.deepEqual(JSON.parse(out).trustedWorkspaces, ['C:\\Users\\me', 'C:\\w\\x']);
  assert.equal(JSON.parse(out).runningLightSpeed, 'fast');
  assert.deepEqual(JSON.parse(x.add('{}', '/Users/me/Work/demo')).trustedWorkspaces, ['/Users/me/Work/demo']);
});

test('opencode has no folder-trust dialog: no preseed', () => {
  assert.equal(ADAPTERS.opencode.trustSpec([], 'win32').preseed, undefined);
});

const SQUAD = {
  machines: { pc: { herdr: null, repo: 'C:/w/demo', board: 'C:/b' }, mac: { herdr: 'macbook', repo: '/Users/me/demo', board: '/Users/me/b' } },
  roles: {
    lead: { count: 1, model: 'opus', machine: 'pc' },
    builder: { count: 2, model: 'sonnet', machine: 'pc', fallback: [{ agent: 'agy' as const, model: 'm' }], seats: { '2': { agent: 'codex' as const, model: 'gpt' } } },
    reviewer: { count: 1, model: 'gpt', machine: 'mac', agent: 'opencode' as const },
  },
  areas: [],
};

test('trustTargets: the machine\'s seat folders and every agent its roles, seats and fallbacks name', () => {
  assert.deepEqual(trustTargets(SQUAD, 'pc'), { paths: ['C:/w/demo'], agents: ['claude', 'agy', 'codex'] });
  assert.deepEqual(trustTargets(SQUAD, 'mac'), { paths: ['/Users/me/demo'], agents: ['opencode'] });
  const multi = { ...SQUAD, repos: { api: { home: true, paths: { pc: 'C:/w/api' } }, web: { home: false, paths: { pc: 'C:/w/web', mac: '/w/web' } } } };
  assert.deepEqual(trustTargets(multi, 'pc').paths, ['C:/w/api', 'C:/w/web']);
});

test('squadTrust: writes each agent\'s entry once under the given home; a second run adds nothing; dry run writes nothing', async () => {
  const h = home();
  try {
    put(h, CLAUDE, JSON.stringify({ projects: {} }, null, 2));
    put(h, CODEX, 'model = "gpt"\n');
    // the seat folder: a real one (the squad file's path is resolved to its real folder before anything is written)
    const repo = join(h, 'Work', 'demo');
    mkdirSync(join(repo, '.git'), { recursive: true }); // a git work tree's top folder (review 89 S2)
    const real = realpathSync.native(repo), key = real.replace(/\\/g, '/');
    const sq = { ...SQUAD, machines: { ...SQUAD.machines, pc: { herdr: null, repo: `${repo}/`, board: 'C:/b' } } };
    // agy never ran here: its file is missing, so it is named, not made
    const call = async (fn: string) => (fn === 'squad_get' ? sq : null);
    const o = { machine: 'pc', home: h, platform: process.platform, env: {}, thisMachine: 'pc', callFn: call };
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dry = await squadTrust('demo', { ...o, dryRun: true });
    assert.match(dry, new RegExp(`would add claude: ${esc(real)}`));
    assert.deepEqual(JSON.parse(readFileSync(join(h, CLAUDE), 'utf8')), { projects: {} });
    const out = await squadTrust('demo', o);
    assert.match(out, new RegExp(`added claude: ${esc(real)}`));
    assert.match(out, new RegExp(`added codex: ${esc(real)}`));
    assert.match(out, /skip agy: .*settings\.json not found: start agy once on this machine/);
    assert.match(out, /on mac: cb squad trust demo --machine mac/);
    assert.equal(JSON.parse(readFileSync(join(h, CLAUDE), 'utf8')).projects[key].hasTrustDialogAccepted, true);
    assert.equal(ADAPTERS.codex.trustSpec([], process.platform).preseed!.state(readFileSync(join(h, CODEX), 'utf8'), real), 'trusted');
    assert.ok(!existsSync(join(h, AGY)));
    const again = await squadTrust('demo', o);
    assert.match(again, new RegExp(`already claude: ${esc(real)}`));
    assert.doesNotMatch(again, /added/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('editFile: a save made during the edit is kept (the edit runs again on it); no temp file is left', () => {
  const h = home();
  try {
    const f = join(h, 'c.json');
    writeFileSync(f, 'a');
    let n = 0;
    const out = editFile(f, (t) => { if (++n === 1) writeFileSync(f, 'a+other'); return t + '!'; });
    assert.equal(n, 2);
    assert.equal(out, 'a+other!');
    assert.equal(readFileSync(f, 'utf8'), 'a+other!');
    assert.deepEqual(readdirSync(h), ['c.json']);
    assert.equal(editFile(f, (t) => t), 'a+other!'); // nothing to change: nothing written
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('editFile: keeps the file mode (0600 ~/.claude.json) and the link of a symlinked dotfile', { skip: process.platform === 'win32' }, () => {
  const h = home();
  try {
    const target = join(h, 'real.json'), link = join(h, 'link.json');
    writeFileSync(target, '{}');
    chmodSync(target, 0o600);
    symlinkSync(target, link);
    editFile(link, () => '{"a":1}');
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(readFileSync(target, 'utf8'), '{"a":1}');
    assert.ok(readdirSync(h).includes('link.json') && readFileSync(link, 'utf8') === '{"a":1}');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('squadTrust: refused inside a squad seat, and the machine must be named when it is not clear', async () => {
  const call = async (fn: string) => (fn === 'squad_get' ? SQUAD : null);
  await assert.rejects(squadTrust('demo', { machine: 'pc', home: '/nowhere', platform: 'win32', env: { CB_ROLE: 'builder' }, callFn: call }), /Ahmed runs it in his own terminal/);
  await assert.rejects(squadTrust('demo', { machine: 'nope', home: '/nowhere', platform: 'win32', env: {}, callFn: call }), /no machine nope.*pc, mac/);
  const two = { ...SQUAD, machines: { a: { herdr: null, repo: '/a', board: '/b' }, b: { herdr: null, repo: '/c', board: '/b' } } };
  await assert.rejects(squadTrust('demo', { home: '/nowhere', platform: 'win32', env: {}, callFn: async () => two }), /--machine/);
  await assert.rejects(squadTrust('demo', { home: '/nowhere', platform: 'win32', env: {}, callFn: async () => null }), /no squad/);
  // review 89 L4: on a machine the squad names, --machine may not name another one (its paths would be trusted here)
  await assert.rejects(squadTrust('demo', { machine: 'pc', home: '/nowhere', platform: 'win32', env: {}, thisMachine: 'MAC', callFn: call }), /--machine pc is not this machine \(mac\)/);
});

test('squadTrust: only a real seat folder is trusted; roots, shares, home and its parents, . and .. parts and missing folders are refused (review 89 M2)', async () => {
  const h = home();
  try {
    put(h, CLAUDE, JSON.stringify({ projects: {} }, null, 2));
    const ok = join(h, 'Work', 'demo');
    mkdirSync(join(ok, '.git'), { recursive: true });
    const notTop = join(ok, 'src'), plain = join(h, 'Plain');
    mkdirSync(notTop); mkdirSync(plain); // review 89 S2: a folder under a work tree, a folder with no git
    const bad = [process.platform === 'win32' ? 'C:/' : '/', '//srv/share', `${ok}/../demo`, `${ok}/./x`, h, dirname(h), join(h, 'missing'), notTop, plain];
    const sq = { machines: { pc: { herdr: null, board: '/b' } }, repos: Object.fromEntries([ok, ...bad].map((p, i) => [`r${i}`, { home: i === 0, paths: { pc: p } }])),
      roles: { builder: { count: 1, model: 'sonnet', machine: 'pc' } }, areas: [] };
    const out = await squadTrust('demo', { home: h, platform: process.platform, env: {}, thisMachine: 'pc', callFn: async () => sq });
    for (const p of bad) assert.ok(out.split('\n').some((l) => l.startsWith(`refused ${p}: `)), `${p}\n${out}`);
    const keys = Object.keys(JSON.parse(readFileSync(join(h, CLAUDE), 'utf8')).projects);
    assert.deepEqual(keys, [realpathSync.native(ok).replace(/\\/g, '/')]);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('codex: a folder written by hand as an inline or dotted entry is left alone, never given a second table (review 89 L1)', () => {
  const w = pre('codex', 'win32');
  for (const text of [`[projects]\n'c:\\w\\x' = { trust_level = "trusted" }\n`, `projects.'c:\\w\\x'.trust_level = "trusted"\n`]) {
    assert.equal(w.state(text, 'C:/w/x'), 'other', text);
    assert.throws(() => w.add(text, 'C:/w/x'), /by hand/);
  }
  assert.equal(w.state(`[projects.'c:\\w\\x'.extra]\nk = 1\n`, 'C:/w/x'), 'other');
  // review 89 S1: the folder in any other quoted string (a comment, an MCP server's cwd) is not a [projects] key
  for (const text of [`# trusted 'c:\\w\\x' by hand once\n`, `[mcp_servers.x]\ncwd = 'c:\\w\\x'\n`, `[projects]\n# 'c:\\w\\x' = { trust_level = "trusted" }\n`]) {
    assert.equal(w.state(text, 'C:/w/x'), 'absent', text);
    assert.match(w.add(text, 'C:/w/x'), /\[projects\.'c:\\w\\x'\]\ntrust_level = "trusted"\n$/);
  }
});

test('claude: a projects that is not an object is refused, never reported added (review 89 L3)', () => {
  assert.throws(() => pre('claude', 'win32').add('{"projects":[]}', 'C:/w/x'), /not an object/);
});

test('squad up: a seat whose folder is not trusted for its agent stops before any pane, naming cb squad trust', async () => {
  const h = home();
  try {
    put(h, CLAUDE, JSON.stringify({ projects: {} }));
    const calls: string[][] = [];
    const run: Runner = (_m, args) => { calls.push(args); return args[1] === 'get' ? { status: 1, stdout: '', stderr: 'agent_not_found' } : { status: 0, stdout: '{"pane_id":"p1"}', stderr: '' }; };
    const sq = { machines: { pc: { herdr: null, repo: 'C:/w/demo', board: 'C:/b' } }, roles: { builder: { count: 1, model: 'sonnet', machine: 'pc' } }, areas: [] };
    const out = await squadUp('demo', false, async (fn: string) => (fn === 'squad_get' ? sq : []), run, homeTrust(h, 'win32'));
    assert.match(out, /failed demo-B1@pc: C:\/w\/demo is not trusted for claude yet \(.*\.claude\.json\): run once in your own terminal: cb squad trust demo/);
    assert.ok(!calls.some((a) => a[0] === 'tab' || a[0] === 'pane'), 'no pane made');
    // trusted: it starts; a missing file says nothing (that agent never ran here: no claim)
    put(h, CLAUDE, JSON.stringify({ projects: { 'C:/w/demo': { hasTrustDialogAccepted: true } } }));
    assert.match(await squadUp('demo', false, async (fn: string) => (fn === 'squad_get' ? sq : []), run, homeTrust(h, 'win32')), /started demo-B1@pc/);
    // a seat on another machine (herdr label) is not read from this machine's home
    const remote = { ...sq, machines: { mac: { herdr: 'macbook', repo: '/w/demo', board: '/b' } }, roles: { builder: { count: 1, model: 'sonnet', machine: 'mac' } } };
    put(h, CLAUDE, JSON.stringify({ projects: {} }));
    assert.doesNotMatch(await squadUp('demo', true, async (fn: string) => (fn === 'squad_get' ? remote : []), run, homeTrust(h, 'win32')), /not trusted/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('guard: no role runs cb squad trust; a message that mentions it is text; a hand-started session may', () => {
  for (const role of ['lead', 'builder', 'reviewer']) {
    for (const cmd of ['cb squad trust demo', 'cd x && cb --as me squad trust demo --machine pc', 'bash -c "cb squad trust demo"',
      // review 89 M1: cb takes options anywhere, so a flag between squad and trust still runs it
      'cb squad --machine pc trust iris', 'cb squad --machine=pc trust iris', 'cb squad -- trust iris', 'cb --tag squad squad trust x',
      'cb squa`d trust x', 'CB_ROLE= CB_AGENT= cb squad --machine pc trust x', 'cb SQUAD Trust x']) {
      const r = evaluate({ tool: 'shell', command: cmd, role });
      assert.equal(r.allow, false, `${role}: ${cmd}`);
      // #4696: clearing CB_ROLE/CB_AGENT is its own block (PR 96) and checkRole answers it first; either reason is a deny,
      // and the same command without the prefix (cb squad --machine pc trust iris) still pins the trust reason
      assert.match(r.reason, cmd.startsWith('CB_ROLE=') ? /cb squad trust|changing CB_ROLE or CB_AGENT/ : /cb squad trust/, `${role}: ${cmd}`);
    }
  }
  assert.deepEqual(evaluate({ tool: 'shell', command: 'cb log 1 "run cb squad trust demo once"', role: 'builder' }), { allow: true });
  assert.deepEqual(evaluate({ tool: 'shell', command: 'cb squad show demo', role: 'lead' }), { allow: true });
  assert.deepEqual(evaluate({ tool: 'shell', command: 'cb squad trust demo', role: null }), { allow: true });
});
