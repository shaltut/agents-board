// #4352 slice 1: the release manifest (cli/release.ts) and cb doctor (cli/doctor.ts). Pure: no database; every file
// is in a temp folder, never the real ~/.claude-board or ~/.claude.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, readManifest, compareManifest, headSha, FORMAT } from '../cli/release.ts';
import { doctor } from '../cli/doctor.ts';

const tmp = mkdtempSync(join(tmpdir(), `cb-doctor-${process.pid}-`));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = () => { const d = join(tmp, String(n++)); mkdirSync(d, { recursive: true }); return d; };
const put = (root: string, p: string, body: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), body); };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const git = (root: string, ...a: string[]) => {
  const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
// every file under a folder with its bytes and mtime: doctor must leave it exactly as it was
const snapshot = (root: string): string => readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
  .map((f) => `${f} ${statSync(f).mtimeMs} ${sha(readFileSync(f, 'utf8'))}`).sort().join('\n');

/** A small checkout: release files, a guard source, a file outside the release folders. */
function checkout() {
  const root = dir();
  put(root, 'bin/cb', '#!/bin/sh\n');
  put(root, 'bin/cb.cmd', '@node cb\r\n');
  put(root, 'cli/cb.ts', 'console.log(1)\n');
  put(root, 'kit/guard/core.mjs', 'export const core = 1;\n');
  put(root, 'kit/guard/shim-claude.mjs', 'export const shim = 1;\n');
  put(root, 'README.md', 'not released\n');
  return root;
}
const FIXTURE = ['bin/cb', 'bin/cb.cmd', 'cli/cb.ts', 'kit/guard/core.mjs', 'kit/guard/shim-claude.mjs'];
/** A manifest of the fixture's release files as they are now, written to a file. */
function manifestOf(root: string, c: string) {
  const f = join(dir(), 'release.json');
  writeFileSync(f, JSON.stringify({ format: FORMAT, sha: c.repeat(40), files: Object.fromEntries(FIXTURE.map((p) => [p, sha(readFileSync(join(root, p), 'utf8'))])) }));
  return f;
}
/** The installed guard, a copy of the checkout's. */
function guardOf(root: string) {
  const g = dir();
  for (const f of ['core.mjs', 'shim-claude.mjs']) writeFileSync(join(g, f), readFileSync(join(root, 'kit/guard', f)));
  return g;
}

test('the manifest lists every tracked release file with its sha256 and the commit; untracked and other files stay out', () => {
  const root = checkout();
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'one');
  put(root, 'cli/scratch.ts', 'untracked\n');
  const m = buildManifest(root);
  assert.equal(m.format, FORMAT);
  assert.equal(m.sha, git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(Object.keys(m.files), ['bin/cb', 'bin/cb.cmd', 'cli/cb.ts', 'kit/guard/core.mjs', 'kit/guard/shim-claude.mjs']);
  assert.equal(m.files['bin/cb.cmd'], sha('@node cb\r\n')); // the bytes on disk, CRLF and all
  assert.deepEqual(buildManifest(root), m); // the same tree, the same manifest

  // a changed release file would make the hashes lie about the commit: refused
  put(root, 'cli/cb.ts', 'console.log(2)\n');
  assert.throws(() => buildManifest(root), /uncommitted changes in the release files[\s\S]*cli\/cb\.ts/);
  assert.throws(() => buildManifest(dir()), /not a git checkout/);
  // review M1: git looks up the parents; a copy inside another repo has no commit of its own
  assert.equal(headSha(join(root, 'cli')), null);
  assert.equal(headSha(root), m.sha);
});

test('node cli/release.ts --out writes the manifest; a bad argument is refused', () => {
  const out = join(dir(), 'release.json');
  const r = spawnSync(process.execPath, ['cli/release.ts', '--out', out], { encoding: 'utf8' });
  if (r.status === 0) { // this checkout is clean: the file is a valid manifest of HEAD
    const m = readManifest(out);
    assert.ok(m.files['cli/release.ts'] && m.files['kit/guard/install.mjs']);
    assert.match(r.stdout, /release\.json: \d+ files at [0-9a-f]{7}/);
  } else assert.match(r.stderr, /uncommitted changes in the release files/); // a worktree being edited
  const bad = spawnSync(process.execPath, ['cli/release.ts', '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage: node cli\/release\.ts \[--out <file>\]/);
});

test('a manifest is checked before use: format, commit, and no path outside the release folders', () => {
  const d = dir();
  const write = (m: any) => { const f = join(d, `m${n++}.json`); writeFileSync(f, JSON.stringify(m)); return f; };
  const ok = { format: FORMAT, sha: 'a'.repeat(40), files: { 'cli/cb.ts': 'b'.repeat(64) } };
  assert.deepEqual(readManifest(write(ok)), ok);
  for (const p of ['../etc/passwd', 'cli/../../x', '/etc/passwd', 'C:/x', 'cli\\cb.ts', 'README.md', 'cli//cb.ts'])
    assert.throws(() => readManifest(write({ ...ok, files: { [p]: 'b'.repeat(64) } })), /outside the release folders/, p);
  assert.throws(() => readManifest(write({ ...ok, format: 'x' })), /not a release manifest/);
  assert.throws(() => readManifest(write({ ...ok, sha: 'main' })), /no commit sha/);
  assert.throws(() => readManifest(write({ ...ok, files: { 'cli/cb.ts': 'zz' } })), /bad hash for cli\/cb\.ts/);
  assert.throws(() => readManifest(join(d, 'none.json')), /cannot read the manifest .*ENOENT/);
});

test('cb doctor: a machine matching the release passes; missing and changed files are named and fail it; nothing is written', () => {
  const root = checkout();
  const files = Object.fromEntries(['bin/cb', 'bin/cb.cmd', 'cli/cb.ts', 'kit/guard/core.mjs', 'kit/guard/shim-claude.mjs']
    .map((p) => [p, sha(readFileSync(join(root, p), 'utf8'))]));
  const mf = join(dir(), 'release.json');
  writeFileSync(mf, JSON.stringify({ format: FORMAT, sha: 'c'.repeat(40), files }));
  const guard = guardOf(root);
  const opts = { root, manifest: mf, guardTarget: guard, settingsFile: null };

  const good = doctor(opts);
  assert.equal(good.ok, true, good.lines.join('\n'));
  assert.match(good.lines[0]!, /^files: all 5 match release ccccccc$/);
  assert.match(good.lines[1]!, /^guard: .* matches this checkout \(core\.mjs, shim-claude\.mjs\)$/);
  assert.equal(good.lines.at(-1), 'doctor: this machine matches the release');

  // the Mac's half-extracted archive: one file gone, one different
  put(root, 'cli/cb.ts', 'console.log("old")\n');
  unlinkSync(join(root, 'bin/cb'));
  const before = snapshot(tmp);
  const bad = doctor(opts);
  assert.equal(snapshot(tmp), before, 'doctor changed a file');
  assert.equal(bad.ok, false);
  assert.match(bad.lines[0]!, /^files: 2 differ from release ccccccc \(of 5; 1 missing, 1 changed\); this checkout is at unknown\. Update this machine to the release$/);
  assert.ok(bad.lines.includes('  missing: bin/cb'));
  assert.ok(bad.lines.includes('  changed: cli/cb.ts'));
  assert.deepEqual(bad.json.files, { missing: ['bin/cb'], changed: ['cli/cb.ts'], extra: [], outside: [], total: 5 });
  assert.equal(bad.lines.at(-1), 'doctor: 1 check failed');
});

test('cb doctor: no manifest, a stale guard and a missing hook each fail it, worded as Ahmed\'s fix', () => {
  const root = checkout();
  const guard = guardOf(root);
  writeFileSync(join(guard, 'core.mjs'), 'export const core = 0;\n'); // last release's guard
  const r = doctor({ root, manifest: null, guardTarget: guard, settingsFile: join(dir(), 'settings.json'), probes: false });
  assert.equal(r.ok, false);
  assert.match(r.lines[0]!, /^files: not compared: no release\.json in .*\. Pass --manifest <file>/); // a check that did not run is no pass
  assert.match(r.lines[1]!, /^guard: .* differs from this checkout's kit\/guard: core\.mjs; the fix is Ahmed's \(ask him with cb ask; never install the guard/);
  assert.ok(r.lines.some((l) => /^hook: cannot read .*settings\.json: ENOENT$/.test(l)), r.lines.join('\n'));
  assert.equal(r.lines.at(-1), 'doctor: 3 checks failed');
  assert.equal(r.json.problems, 3);
  // release.json in the checkout is the default manifest
  writeFileSync(join(root, 'release.json'), readFileSync(manifestOf(root, 'd')));
  assert.match(doctor({ root, manifest: null, guardTarget: guard, settingsFile: null }).lines[0]!, /^files: all 5 match release ddddddd$/);
});

test('cb doctor runs with the board unreachable and in a bound pane: it never connects', () => {
  const root = checkout();
  const mf = manifestOf(root, 'e');
  const home = dir(); // this run's ~: the guard installed from the checkout, no Claude settings
  mkdirSync(join(home, '.claude-board'));
  const g = guardOf(root);
  for (const f of ['core.mjs', 'shim-claude.mjs']) put(home, `.claude-board/guard/${f}`, readFileSync(join(g, f), 'utf8'));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['cli/cb.ts', 'doctor', '--root', root, '--manifest', mf, '--json'], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CB_DATABASE_URL: 'postgres://cb@192.0.2.1:5434/claude_board', HERDR_PANE_ID: `p-doc-${process.pid}`,
      CB_MACHINE: 'testbox', CB_ACTOR: '', HOME: home, USERPROFILE: home, CLAUDE_CODE_MESSAGING_SOCKET: '' } });
  assert.ok(Date.now() - t0 < 15_000, 'doctor waited on the board');
  assert.equal(r.status, 1, r.stderr); // the hook check fails: this home has no settings.json
  assert.doesNotMatch(r.stderr, /board|ECONN|ETIMEDOUT/);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.files, { missing: [], changed: [], extra: [], outside: [], total: 5 });
  assert.equal(j.release, 'e'.repeat(40));
  assert.equal(j.guard.ok, true);
  assert.equal(j.wiring.ok, false);
  assert.match(j.wiring.problems[0], /cannot read .*settings\.json/);
});

test('compareManifest reads only the listed files', () => {
  const root = checkout();
  const r = compareManifest(root, { format: FORMAT, sha: 'f'.repeat(40), files: { 'cli/cb.ts': sha('console.log(1)\n'), 'cli/gone.ts': sha('') } });
  assert.deepEqual(r, { missing: ['cli/gone.ts'], changed: [], extra: ['bin/cb', 'bin/cb.cmd', 'kit/guard/core.mjs', 'kit/guard/shim-claude.mjs'], outside: [], total: 2 });
});

// review M3: the Mac update is tar xzf over a copy, which never deletes: a file a release dropped stays behind
test('cb doctor: a file on disk the release does not list is extra and fails it; node_modules and dist are left out', () => {
  const root = checkout();
  const mf = manifestOf(root, '1');
  put(root, 'cli/old-relay.ts', 'dropped in this release\n');
  put(root, 'kit/agy/settings.json', '{}\n');
  put(root, 'cli/node_modules/x/index.js', 'installed\n');
  put(root, 'server/dist/a.js', 'built\n');
  const r = doctor({ root, manifest: mf, guardTarget: guardOf(root), settingsFile: null });
  assert.equal(r.ok, false);
  assert.match(r.lines[0]!, /^files: 2 differ from release 1111111 \(of 5; 2 extra\); .*Extra = not in the release \(a tar extract never deletes\): remove it$/);
  assert.ok(r.lines.includes('  extra: cli/old-relay.ts') && r.lines.includes('  extra: kit/agy/settings.json'), r.lines.join('\n'));
  assert.deepEqual(r.json.files.extra, ['cli/old-relay.ts', 'kit/agy/settings.json']);
  assert.equal(r.json.ok, false);
});

// review M2: a link planted in the checkout must not make doctor read a file outside it
test('cb doctor: a release file that resolves outside the checkout is reported as outside and never read', () => {
  const root = checkout();
  const away = dir();
  put(away, 'x.mjs', 'export const x = 1;\n');
  symlinkSync(away, join(root, 'kit', 'linked'), 'junction'); // a junction on Windows (no admin needed), a link elsewhere
  const mf = join(dir(), 'release.json');
  writeFileSync(mf, JSON.stringify({ format: FORMAT, sha: '2'.repeat(40), files: { ...JSON.parse(readFileSync(manifestOf(root, '2'), 'utf8')).files,
    'kit/linked/x.mjs': sha('export const x = 1;\n') } })); // the right hash: a read through the link would call it a match
  const r = doctor({ root, manifest: mf, guardTarget: guardOf(root), settingsFile: null });
  assert.equal(r.ok, false);
  assert.deepEqual(r.json.files.outside, ['kit/linked/x.mjs']);
  assert.deepEqual(r.json.files.changed, []);
  assert.ok(r.lines.includes('  outside: kit/linked/x.mjs'), r.lines.join('\n'));
  assert.match(r.lines[0]!, /Outside = a link that leaves this checkout: replace it with the file/);
});
