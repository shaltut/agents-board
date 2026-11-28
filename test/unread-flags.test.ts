// #4754: a flag a command does not read is refused before anything happens: --dry-run on next, done or broadcast ran
// the real action, and move --pr dropped the PR. flagsOf (cli/help.ts) is the one list: the usage lines plus `also`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freshDb, TEST_URL } from './helpers.ts';
import { COMMANDS, flagsOf } from '../cli/help.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

const src = readFileSync('cli/cb.ts', 'utf8').replace(/\r\n/g, '\n');
// the short options, as cb.ts declares them
const SHORTS = Object.fromEntries([...src.slice(src.indexOf('const OPTIONS = {'), src.indexOf('} as const;')).matchAll(/'?([\w-]+)'?: \{ type: '\w+', short: '(\w)'/g)]
  .map((m) => [m[2], m[1]]));

test('every flag a case in cb.ts reads is one its command takes', () => {
  const read = (text: string) => [...text.matchAll(/\bo(?:\.([A-Za-z_]\w*)|\['([\w-]+)'\])/g)].map((m) => m[1] ?? m[2]!);
  // the helpers that read flags for their caller. fromStdin only compares --context while reading the question
  const helpers = [...src.matchAll(/^(?:async )?function (\w+)\([\s\S]*?\n}\n/gm)]
    .filter((m) => !['run', 'main', 'fromStdin'].includes(m[1]!)).map((m) => [m[1]!, read(m[0])] as const).filter(([, flags]) => flags.length);
  const body = src.slice(src.indexOf('async function run()'), src.indexOf('// The schema\'s errors name the problem'));
  const marks = [...body.matchAll(/^    ((?:case (?:'[\w-]+'|undefined):\s*)+)/gm)];
  assert.ok(marks.length > 40, `found only ${marks.length} cases`);
  const missing: string[] = [];
  marks.forEach((m, i) => {
    const text = body.slice(m.index, marks[i + 1]?.index ?? body.length);
    const flags = [...read(text), ...helpers.filter(([name]) => new RegExp(`\\b${name}\\(`).test(text)).flatMap(([, f]) => f)];
    for (const [, cmd] of m[1]!.matchAll(/'([\w-]+)'/g)) {
      const takes = flagsOf(cmd!, SHORTS);
      for (const f of new Set(flags)) if (!takes.has(f)) missing.push(`cb ${cmd} reads --${f}`);
    }
  });
  assert.deepEqual(missing, [], 'add the flag to the usage line in cli/help.ts, or to the entry\'s `also`');
});

test('every example in the manual uses only flags its command takes', () => {
  for (const [cmd, c] of Object.entries(COMMANDS)) {
    if (cmd === 'run') continue; // a recipe's own parameters
    for (const [, flag] of (c.eg ?? '').matchAll(/(?<![\w-])--([a-z][a-z-]*)/g))
      assert.ok(flagsOf(cmd, SHORTS).has(flag!), `cb ${cmd}'s example uses --${flag}`);
  }
});

const cb = (args: string[], actor = 'B1@pc') => {
  const r = spawnSync(process.execPath, ['cli/cb.ts', ...args], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: actor, HERDR_PANE_ID: '', CB_MACHINE: 'testbox', CB_AGENT: '', CLAUDE_CODE_MESSAGING_SOCKET: '' } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

async function board() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('pc', 'p1', 'B1@pc', 'demo', 'builder')`;
  await sql`select cb.iam('pc', 'p2', 'L1@pc', 'demo', 'lead')`;
  for (const t of ['one', 'two']) await sql`select cb.task_add(project => 'demo', title => ${t}, status => 'next', actor => 'L1@pc')`;
  const state = async () => JSON.stringify([await sql`select id, status, assignee, title from cb.tasks order by id`,
    (await sql`select count(*)::int as n from cb.events`)[0].n]);
  return { sql, state };
}

test('a flag the command does not read is refused: nothing is done, and it names the help', async () => {
  const { state } = await board();
  const before = await state();
  const cases: [string[], string, string?][] = [
    [['next', 'demo', '--dry-run'], '--dry-run'],
    [['done', '2', 'x', '--dry-run'], '--dry-run', 'L1@pc'],
    [['broadcast', 'hello', '--all', '--dry-run'], '--dry-run', 'L1@pc'],
    [['move', '1', 'review', '--pr', 'https://github.com/o/r/pull/7'], '--pr'],
    [['log', '1', 'note', '--title', 'renamed'], '--title'],
    [['add', 'demo', 'three', '--force'], '--force'],
    [['--wait', 'next', 'demo'], '--wait'],
    [['squad', 'set', 'demo', '-f', 'nothing.json', '--dry-run'], '--dry-run', 'L1@pc'],
  ];
  for (const [args, flag, actor] of cases) {
    const r = cb(args, actor);
    const cmd = args.find((a) => /^[a-z]/.test(a))!;
    assert.equal(r.code, 1, `cb ${args.join(' ')}: ${r.out}`);
    assert.match(r.err, new RegExp(`cb ${cmd}[^\\n]* does not take ${flag}: nothing was changed\\..*cb help ${cmd}|cb ${cmd}[^\\n]* does not take ${flag}: nothing was changed\\..*cb move`), `cb ${args.join(' ')}`);
    assert.equal(await state(), before, `cb ${args.join(' ')} changed the board`);
  }
  assert.match(cb(['move', '1', 'review', '--pr', 'https://github.com/o/r/pull/7']).err, /cb move 1 review "PR <url>"/, 'says where a PR goes');
  assert.match(cb(['edit', '1', '--status', 'done'], 'L1@pc').err, /does not take --status: nothing was changed\. For a status run: cb move 1 done/);
});

test('the flags a command does take still work, those off its usage line too, before or after the command word', async () => {
  const { sql } = await board();
  for (const [args, actor] of [
    [['--json', 'mine'], 'B1@pc'], [['--as', 'L1@pc', 'brief', 'demo'], 'B1@pc'], [['next', 'demo', '--json'], 'B1@pc'],
    [['log', 'demo', 'a note', '-t', '1'], 'B1@pc'], [['search', 'one', '--project', 'demo'], 'B1@pc'],
    [['add', 'demo', 'with links', '--pr', 'https://github.com/o/r/pull/7', '--commit', 'abc1234', '--branch', 'x'], 'B1@pc'],
    [['done', '1', 'built', '--commit', 'abc1234'], 'L1@pc'], [['start', '--help'], 'B1@pc'], [['next', '--dry-run', '--help'], 'B1@pc'],
  ] as [string[], string][]) {
    const r = cb(args, actor);
    assert.equal(r.code, 0, `cb ${args.join(' ')}: ${r.err}`);
  }
  assert.equal((await sql`select status from cb.tasks where id = 1`)[0].status, 'done');
  // a recipe's own parameters are not cb's flags
  assert.doesNotMatch(cb(['run', 'test', '--sha', 'abc1234', '--app', 'x', '--files', 'a.test.ts']).err, /does not take/);
});
