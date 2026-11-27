// #4535: cb faults reads this machine's fault log and never the board.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLine } from '../kit/fault-line.mjs';
import { groupFaults, sinceMs } from '../cli/faults.ts';

const temps: string[] = [];
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'cb-faults-cli-')); temps.push(d); return d; };

function cb(args: string[], home: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['cli/cb.ts', ...args], {
    encoding: 'utf8', timeout: 30_000,
    // the board URL points nowhere: cb faults must not need it
    env: { ...process.env, CB_DATABASE_URL: 'postgres://cb@cb-fault-test.invalid:5432/claude_board_test_none', CB_ACTOR: 'W9@test',
      HERDR_PANE_ID: '', CB_MACHINE: 'testbox', CLAUDE_CODE_MESSAGING_SOCKET: '', CB_FAULTS_HOME: home, HOME: home, USERPROFILE: home, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const ago = (ms: number) => new Date(Date.now() - ms);
const line = (o: any) => buildLine({ machine: 'testbox', src: 'cb', exit: 1, release: 'abcdef1234', ...o });

function seed(home: string) {
  const day = new Date().toISOString().slice(0, 10);
  const ls = [
    line({ at: ago(60_000), cmd: 'show', kind: 'not_run', code: 'CONNECT_TIMEOUT', msg: 'board unreachable', pane: 'p1' }),
    line({ at: ago(50_000), cmd: 'mine', kind: 'not_run', code: 'CONNECT_TIMEOUT', msg: 'board unreachable', pane: 'p2' }),
    line({ at: ago(40_000), cmd: 'relay', kind: 'not_run', code: 'CONNECT_TIMEOUT', msg: 'board unreachable', n: 5 }),
    line({ at: ago(30_000), cmd: 'inbox', kind: 'usage', msg: 'unknown command "‹v›"', pane: 'p1' }),
    line({ at: ago(3 * 86400_000), cmd: 'show', kind: 'db', code: '40P01', msg: 'deadlock detected' }), // outside 24h
  ];
  const old = ago(3 * 86400_000).toISOString().slice(0, 10);
  writeFileSync(join(home, `${old}.jsonl`), JSON.stringify(ls[4]) + '\n');
  writeFileSync(join(home, `${day}.jsonl`), ls.slice(0, 4).map((l) => JSON.stringify(l)).join('\n') + '\n{"v":1,"at":"2026-');
  return ls;
}

test('cb faults groups by template, sums n, counts seats, skips a torn line, and works with the board nowhere', () => {
  const home = temp();
  const ls = seed(home);
  const r = cb(['faults', '--json'], home);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.lines.length, 4);
  assert.equal(j.groups.length, 2);
  const outage = j.groups.find((g: any) => g.kind === 'not_run');
  assert.equal(outage.count, 7); // 1 + 1 + 5
  assert.equal(outage.seats, 3); // p1, p2, and no pane
  assert.deepEqual(outage.cmds, ['mine', 'relay', 'show']);
  assert.equal(outage.tmpl, ls[0]!.tmpl);
  const week = JSON.parse(cb(['faults', '--since', '7d', '--json'], home).out);
  assert.equal(week.groups.length, 3);
  const text = cb(['faults'], home);
  assert.match(text.out, /^faults on testbox in the last 24h: 4 lines in 2 groups/);
  assert.match(text.out, /\n +7 {2}not_run +mine,relay,\+1 /);
});

test('cb faults: the triage column reads triage.json; a bad --since is refused; an empty log says so', () => {
  const home = temp();
  const ls = seed(home);
  writeFileSync(join(home, 'triage.json'), JSON.stringify({ groups: { [ls[3]!.tmpl]: { verdict: 'bug', card: 4602, at: new Date().toISOString(), count: 1, by: 'agent' },
    [ls[0]!.tmpl]: { verdict: 'infra', card: null, at: new Date().toISOString(), count: 7, by: 'rule' } } }));
  const out = cb(['faults'], home).out;
  assert.match(out, /usage .*filed #4602/);
  assert.match(out, /not_run .*infra \(not filed\)/);
  const bad = cb(['faults', '--since', 'yesterday'], home);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--since takes a number and m, h, d or w/);
  assert.match(cb(['faults'], temp()).out, /^no faults on testbox in the last 24h/);
  assert.equal(sinceMs('30m'), 1800_000);
  assert.equal(groupFaults([{ kind: 'cap' }]).length, 0);
});
