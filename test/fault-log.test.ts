// #4535: the local fault log. Every test points CB_FAULTS_HOME (and HOME/USERPROFILE) at a temp folder: nothing here
// may write to this machine's real log.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';
import { mask, tmplOf, buildLine, writeFault, readFaults, releaseOf, buildWords, wordsText, literals, CAP_BYTES } from '../kit/fault-line.mjs';
import { argvShape, kindOf } from '../cli/fault-hook.ts';

const clients: any[] = [];
const temps: string[] = [];
after(async () => { await Promise.all(clients.map((c) => c.end())); for (const t of temps) rmSync(t, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'cb-faults-')); temps.push(d); return d; };

/** cb with its own fault home and home folder; returns the lines it wrote. */
function cb(args: string[], env: Record<string, string> = {}, home = temp()) {
  const r = spawnSync(process.execPath, ['cli/cb.ts', ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W9@test', HERDR_PANE_ID: '', CB_MACHINE: 'testbox', CB_AGENT: '',
      CLAUDE_CODE_MESSAGING_SOCKET: '', CB_FAULTS_HOME: join(home, 'faults'), HOME: home, USERPROFILE: home, CB_FAULT_SLOW_MS: '', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, home, lines: lines(join(home, 'faults')) };
}
function lines(dir: string): any[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)));
}
const allText = (dir: string) => existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir, { recursive: true } as any).map((n: any) => { try { return readFileSync(join(dir, String(n)), 'utf8'); } catch { return ''; } }).join('\n') : '';

test('canaries: no argument value, flag value, URL part, path or environment value reaches the fault log', async () => {
  const sql = await freshDb(); clients.push(sql);
  const rnd = () => `zq${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 10)}`;
  const C = Array.from({ length: 8 }, rnd);
  // a title made only of cb's own words: random strings alone would pass while real titles leaked
  const words = 'show next card mine';
  const home = temp();
  const env = { FOO_TOKEN: C[0]!, CB_EXTRA: `${C[1]} ${words}` };
  const runs = [
    ['show', '--bogus', C[2]!, words],
    ['frob', C[3]!, words],
    ['show', words],
    ['move', '987654', 'done', `${words} ${C[4]}`],
    ['add', words.split(' ')[0]!, words, '-b', C[5]!, '--title', `${C[6]} ${words}`, '--as', `${C[7]}@testbox`, '-s', `${C[0]}x`],
    ['bug', 'board', `C:\\Users\\${C[1]}\\x`, '-b', `/home/${C[2]}/y 10.1.2.3 user:${C[3]}@host.example`],
  ];
  for (const a of runs) cb(a, env, home);
  // the board URL carries a user and a password; local and refused, so it fails fast (refused, not a retry wait)
  cb(['show', '42'], { ...env, CB_DATABASE_URL: `postgres://${C[4]}:${C[5]}@127.0.0.1:1/${C[6]}` }, home);
  const text = allText(join(home, 'faults'));
  const ls = lines(join(home, 'faults'));
  assert.ok(ls.length >= 6, `expected a line per failing run, got ${ls.length}`);
  for (const c of C) assert.ok(!text.includes(c), `canary ${c} leaked into the fault log`);
  assert.ok(!text.includes(words), 'a title of dictionary words leaked');
  for (const leak of ['10.1.2.3', 'Users', 'home/', 'host.example', '987654']) assert.ok(!text.includes(leak), `${leak} leaked`);
  for (const l of ls) assert.equal(l.flags.every((f: string) => /^[a-z][a-z0-9-]*$/.test(f)), true);
  assert.deepEqual(ls.find((l) => l.cmd === 'add')?.flags, ['as', 'body', 'status', 'title']);
});

test('mask: values echoed unquoted, quoted spans and words outside cb\'s source become ‹v›; numbers become N', () => {
  assert.equal(mask('board has no squad yet', ['board']), '‹v› has no squad yet');
  assert.equal(mask('"show next card mine" is not a task id'), '"‹v›" is not a task id');
  assert.equal(mask('task #4242 not found at zzyzxhost'), 'task #N not found at ‹v›');
  assert.equal(mask('--image C:\\Users\\someone\\shot.png: no such file', ['C:\\Users\\someone\\shot.png']), '--image ‹v›: no such file');
  assert.match(mask('read ECONNRESET at أحمد'), /‹v›$/);
});

test('kinds: wrong use, a refusal, a database error, a crash, the board unreachable', async () => {
  const sql = await freshDb(); clients.push(sql);
  const usage = cb(['show', '--bogus']);
  assert.equal(usage.code, 1);
  assert.equal(usage.lines[0].kind, 'usage');
  assert.equal(usage.lines[0].exit, 1);
  const refused = cb(['move', '987654', 'done']); // the schema raises (P0001)
  assert.equal(refused.lines[0]?.kind, 'refused', refused.err);
  const local = cb(['show', '42'], { CB_DATABASE_URL: 'postgres://cb@127.0.0.1:1/claude_board_test_none' });
  assert.equal(local.lines[0]?.kind, 'not_run'); // this machine's own board refused: nothing ran (no retry wait)
  assert.equal(local.lines[0]?.board, 'local');
  // a board on another machine that never answers: retried, then exit 3, not_run with the tries
  const remote = cb(['show', '42'], { CB_DATABASE_URL: 'postgres://cb@cb-fault-test.invalid:5432/claude_board_test_none' });
  assert.equal(remote.code, 3, remote.err);
  assert.equal(remote.lines[0].kind, 'not_run');
  assert.equal(remote.lines[0].board, 'remote');
  assert.ok(remote.lines[0].tries >= 2);
  assert.equal(kindOf(Object.assign(new Error('x'), { code: '40P01' }), null, ''), 'db');
  assert.equal(kindOf(new TypeError('x is undefined'), null, ''), 'crash');
  assert.equal(kindOf(Object.assign(new Error('nope'), { code: 'P0001' }), null, 'nope'), 'refused');
});

test('not faults: a queued lock (exit 2) writes nothing; cb start unreachable exits 0 and writes not_run; slow writes slow', async () => {
  const sql = await freshDb(); clients.push(sql);
  assert.equal(cb(['lock', 'take', 'db'], { CB_ACTOR: 'A1@test' }).code, 0);
  const queued = cb(['lock', 'take', 'db'], { CB_ACTOR: 'B1@test' });
  assert.equal(queued.code, 2, queued.err);
  assert.equal(queued.lines.length, 0);
  const start = cb(['start'], { CB_DATABASE_URL: 'postgres://cb@127.0.0.1:1/claude_board_test_none' });
  assert.equal(start.code, 0);
  assert.equal(start.lines[0]?.kind, 'not_run');
  const slow = cb(['help'], { CB_FAULT_SLOW_MS: '1' });
  assert.equal(slow.code, 0);
  assert.equal(slow.lines[0]?.kind, 'slow');
  assert.equal(slow.lines[0]?.cmd, 'help');
});

test('a success creates no folder; under node:test without CB_FAULTS_HOME nothing is written at all', () => {
  const ok = cb(['help']);
  assert.equal(ok.code, 0);
  assert.equal(existsSync(join(ok.home, 'faults')), false);
  const home = temp();
  const r = cb(['show', '--bogus'], { CB_FAULTS_HOME: '' }, home); // NODE_TEST_CONTEXT reaches the child
  assert.equal(r.code, 1);
  assert.equal(existsSync(join(home, '.claude-board')), false);
});

test('never fails the command: an unwritable fault home leaves output and exit code as with the log off', () => {
  const home = temp();
  writeFileSync(join(home, 'faults'), 'a file where the folder should be');
  for (const args of [['show', '--bogus'], ['frob'], ['help', 'faults']]) {
    const a = cb(args, {}, home), b = cb(args, { CB_FAULTS_OFF: '1' }, home);
    assert.deepEqual([a.code, a.out, a.err], [b.code, b.out, b.err]);
  }
});

test('templates: the same fault with other values is one group; an outage is one group across commands; wrong use is per command', () => {
  const l = (o: any) => buildLine({ machine: 'a', src: 'cb', exit: 1, ...o });
  const a = l({ cmd: 'show', kind: 'refused', msg: mask('task #12 not found at hostone', ['hostone']) });
  const b = l({ cmd: 'show', kind: 'refused', msg: mask('task #9876 not found at hosttwo', ['hosttwo']), machine: 'b', release: 'abcdef1234' });
  assert.equal(a.tmpl, b.tmpl);
  const outage = ['show', 'mine', 'next'].map((cmd) => l({ cmd, kind: 'not_run', code: 'CONNECT_TIMEOUT', msg: 'board unreachable' }).tmpl);
  assert.equal(new Set(outage).size, 1);
  const usage = ['show', 'mine'].map((cmd) => l({ cmd, kind: 'usage', msg: 'unknown option ‹v›' }).tmpl);
  assert.equal(new Set(usage).size, 2);
  // a database missing at connect is the seat's, not the command's: one group, whatever cb help hint follows
  const missing = ['mine', 'brief'].map((cmd) => l({ cmd, kind: 'db', code: '3D000', msg: `database "‹v›" does not exist. Run: cb help ${cmd}` }).tmpl);
  assert.equal(new Set(missing).size, 1);
  assert.notEqual(l({ cmd: 'mine', kind: 'db', code: '40P01', msg: 'deadlock' }).tmpl, l({ cmd: 'brief', kind: 'db', code: '40P01', msg: 'deadlock' }).tmpl);
  assert.match(a.tmpl, /^ft-[0-9a-f]{12}$/);
  assert.equal(tmplOf(a), a.tmpl);
  // argv: the subcommand of a fixed list only; a first value is never kept
  assert.deepEqual(argvShape(['lock', 'take', 'db'], {}).sub, 'take');
  assert.equal(argvShape(['show', '42'], {}).sub, null);
});

test('the vocabulary is current and holds no client or person name', () => {
  const file = readFileSync('kit/fault-words.json', 'utf8');
  assert.equal(file, wordsText(buildWords()), 'kit/fault-words.json is stale: run node kit/fault-line.mjs --words');
  // client, product and person names that must never be cb vocabulary, as sha256 prefixes: this repo is public, so the
  // list must not spell them. Add one with: node -e "console.log(require('crypto').createHash('sha256').update('<name>').digest('hex').slice(0, 16))"
  const hashes = new Set(['a2ba597eed6f656e', 'a9a6d86ec5b16639', '5ea83b530ba80969', '6862ed95c7c0bd3d', 'a8a34b63086e2165',
    '046b3f95f318bb19', '2b54971bb79ed11e', '9eeb1a7fdbdb4f72', '654b0ca8f8f44ffb']);
  for (const w of JSON.parse(file)) assert.ok(!hashes.has(createHash('sha256').update(w).digest('hex').slice(0, 16)), 'a denied name is in kit/fault-words.json');
  assert.deepEqual(literals("a('one two'); // it's a comment\nb(`x ${c('three')} four`)"), ['one two', 'x ', 'three', ' four']);
});

test('release: release.json, a checkout, a worktree .git file with packed refs, and neither', () => {
  const sha = 'a'.repeat(40), sha2 = 'b'.repeat(40);
  const rel = temp(); writeFileSync(join(rel, 'release.json'), JSON.stringify({ sha: 'c'.repeat(40) }));
  assert.equal(releaseOf(rel), 'cccccccccc');
  const co = temp(); mkdirSync(join(co, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(co, '.git', 'HEAD'), 'ref: refs/heads/main\n'); writeFileSync(join(co, '.git', 'refs', 'heads', 'main'), sha + '\n');
  assert.equal(releaseOf(co), 'aaaaaaaaaa');
  const wt = temp(), gd = join(co, '.git', 'worktrees', 'w');
  mkdirSync(gd, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${gd}\n`); writeFileSync(join(gd, 'HEAD'), 'ref: refs/heads/feat\n'); writeFileSync(join(gd, 'commondir'), '../..\n');
  writeFileSync(join(co, '.git', 'packed-refs'), `# pack-refs\n${sha2} refs/heads/feat\n`);
  assert.equal(releaseOf(wt), 'bbbbbbbbbb');
  assert.equal(releaseOf(temp()), null);
});

test('files: the cap stops the day, an old day file is deleted on a new day, parallel writers never tear a line', async () => {
  const dir = temp(), env = { CB_FAULTS_HOME: dir } as any;
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, `${day}.jsonl`), 'x'.repeat(CAP_BYTES) + '\n');
  assert.equal(writeFault({ src: 'cb', kind: 'usage', msg: 'a', exit: 1 }, env), false);
  assert.equal(writeFault({ src: 'cb', kind: 'usage', msg: 'a', exit: 1 }, env), false);
  assert.equal(readFileSync(join(dir, `${day}.jsonl`), 'utf8').split('"kind":"cap"').length, 2); // one cap line
  const dir2 = temp();
  const old = new Date(Date.now() - 15 * 86400_000).toISOString().slice(0, 10), kept = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
  writeFileSync(join(dir2, `${old}.jsonl`), '{}\n'); writeFileSync(join(dir2, `${kept}.jsonl`), '{}\n');
  assert.equal(writeFault({ src: 'cb', kind: 'usage', msg: 'a', exit: 1 }, { CB_FAULTS_HOME: dir2 } as any), true);
  assert.deepEqual(readdirSync(dir2).sort(), [`${kept}.jsonl`, `${day}.jsonl`].sort());
  // 20 processes x 50 lines
  const dir3 = temp();
  const script = `import { writeFault } from ${JSON.stringify(new URL('../kit/fault-line.mjs', import.meta.url).href)};
    for (let i = 0; i < 50; i++) writeFault({ src: 'cb', kind: 'refused', cmd: 'show', msg: 'task #N not found ' + 'pad '.repeat(80), exit: 1 });`;
  await Promise.all(Array.from({ length: 20 }, () => new Promise((res) => spawn(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, CB_FAULTS_HOME: dir3 }, stdio: 'ignore' }).on('exit', res))));
  const got = readFaults(Date.now() - 3600_000, { CB_FAULTS_HOME: dir3 } as any);
  assert.equal(got.length, 1000);
  // a torn line is skipped by readers
  writeFileSync(join(dir3, `${day}.jsonl`), '{"v":1,"at":"' + new Date().toISOString() + '","tmpl":"ft-000000000000"}\n{"v":1,"at":', { flag: 'a' });
  assert.equal(readFaults(Date.now() - 3600_000, { CB_FAULTS_HOME: dir3 } as any).length, 1001);
});

test('speed: 200 writes, each under 20 ms', () => {
  const dir = temp(), env = { CB_FAULTS_HOME: dir } as any;
  let worst = 0;
  // the first fault of a process also makes the folder and reads the vocabulary once
  const t0 = performance.now();
  writeFault({ src: 'cb', kind: 'refused', cmd: 'show', msg: mask('task #0 not found'), exit: 1 }, env);
  assert.ok(performance.now() - t0 < 200, `first write ${(performance.now() - t0).toFixed(1)} ms`);
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    writeFault({ src: 'cb', kind: 'refused', cmd: 'show', msg: mask(`task #${i} not found`), exit: 1 }, env);
    worst = Math.max(worst, performance.now() - t);
  }
  assert.ok(worst < 20, `slowest write ${worst.toFixed(1)} ms`);
});
