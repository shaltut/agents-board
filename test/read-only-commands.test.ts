// #4515 review M1: every command form marked `reads` in cli/help.ts runs as a real cb process on a connection whose
// transactions are read-only (default_transaction_read_only=on, sent as a startup parameter in the URL). Any INSERT,
// UPDATE, DELETE, NOTIFY or sequence bump anywhere down its path fails with 25006, so a write added later under a
// `reads` mark fails here. A control write proves the setting bites.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';
import { COMMANDS } from '../cli/help.ts';
import { onlyReads } from '../cli/connect-retry.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
const faults = join(tmpdir(), `cb-faults-ro-${process.pid}`);
after(() => rmSync(faults, { recursive: true, force: true }));

const ro = new URL(TEST_URL); ro.searchParams.set('default_transaction_read_only', 'on');
function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['cli/cb.ts', ...args], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, CB_DATABASE_URL: ro.href, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', CB_MACHINE: 'testbox', CB_AGENT: '',
      // #4735: cb faults reads this log, not this machine's real one. Setting it also turns fault writes on under test
      // (they are off otherwise), so the control's failing write lands there too; after() removes the folder
      CB_FAULTS_HOME: faults,
      // cb key check must never find this machine's real key, nor send one anywhere
      CB_KEY_DIR: join(tmpdir(), `cb-keys-ro-${process.pid}`), CB_BOARD_URL: '',
      CLAUDE_CODE_MESSAGING_SOCKET: '', CB_GH_CACHE: join(tmpdir(), `cb-gh-ro-${process.pid}.json`), ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

// one form per mark: every command marked reads: true, and every subcommand of a list ('' bare, '#' a bare number)
const FORMS: string[][] = [['brief', 'demo'], ['brief', 'demo', '--json'], ['mine'], ['resume'], ['tick', 'demo'], ['goals', 'demo'],
  ['epics', 'demo'], ['pending', 'demo'], ['role', 'builder'], ['users'], ['huddles', 'demo'], ['jobs', 'demo'], ['jobs', 'demo', '--ended'], ['show', '2'],
  ['search', 'demo', 'card'], ['session', 'W1@test'], ['sessions', 'demo'], ['digest', 'demo'], ['start'], ['help'],
  ['mem', 'find', 'gotcha'], ['mem', 'list', 'demo'], ['mem', 'show', 'M1'], ['page', 'show', '2'], ['squad', 'show', 'demo'],
  ['huddle', 'show', '1'], ['lock', 'queue'], ['job', 'show', '1'], ['job', 'log', '1'], ['job', '1'], ['asks'], ['github'],
  ['usage', 'demo'], ['usage', '--all', '--since', '7d', '--json'], ['faults'], ['faults', '--since', '7d', '--json'], ['models'], ['key', 'check']];
// no job exists to read: these stop at "no job #1", after the select that would have written. There is no board key
// either: cb key check, which never uses the database, stops at saying what to set up
const MAY_FAIL = new Set(['job show 1', 'job log 1', 'job 1', 'key check']);

test('every form marked read-only runs on a read-only connection without writing', { timeout: 600_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.task_add(project => 'demo', title => 'seed card', actor => 'orch')`;
  await sql`select cb.iam('pc', 'w9:p1', 'orch', 'demo', 'lead')`;
  await sql`select cb.iam('testbox', 'p-ro', 'W1@test', 'demo', 'builder')`;
  await sql`select cb.task_add(project => 'demo', title => 'held card', status => 'in_progress', assignee => 'W1@test', actor => 'orch')`;
  await sql`select cb.ask(project => 'demo', body => 'Which one?', options => '[{"label":"A"},{"label":"B"}]'::jsonb, actor => 'W1@test')`;
  await sql`select cb.answer(id => '1', answer => 'A', actor => 'ahmed')`;
  await sql`select cb.mem_add(project => 'demo', title => 'a gotcha', kind => 'gotcha', body => '', actor => 'W1@test')`;
  await sql`select cb.huddle_open(topic => 'dates', members => '["orch"]'::jsonb, actor => 'W1@test')`;
  await sql`select cb.lock_take(name => 'db', actor => 'W1@test')`;
  await sql`select cb.usage_report('testbox', 'p-ro', 'sid-ro', 'claude-test-1', 10, 20, 30, 40, 0.5)`;
  await sql`select cb.page_set(body => '# p', task => '2', actor => 'W1@test')`;
  await sql`select cb.epic_create(project => 'demo', title => 'E', actor => 'orch')`;
  await sql`select cb.squad_set('demo', ${sql.json({ machines: { box: { herdr: null, repo: '/r', board: '/b' } }, roles: { lead: { count: 1, model: 'opus', machine: 'box' } } })}, 'ahmed')`;
  // a session records an ask from its terminal (the test's own connection counts as the dashboard, which may not)
  const asked = cb(['asks', 'add', 'status?'], { CB_DATABASE_URL: TEST_URL });
  assert.equal(asked.code, 0, asked.err);

  // the list covers every mark, so a newly marked command or subcommand must be added here
  for (const [name, c] of Object.entries(COMMANDS)) {
    if (!c.reads) continue;
    const firsts = c.reads === true ? [null] : c.reads;
    for (const first of firsts)
      assert.ok(FORMS.some(([cmd, ...a]) => cmd === name && (first === null || (/^\d+$/.test(a[0] ?? '') ? '#' : a[0] ?? '') === first)),
        `cb ${name}${first === null ? '' : ` ${first || '(bare)'}`} is marked reads but has no form in this test`);
  }

  const before = (await sql`select (select count(*) from cb.events) + (select count(*) from cb.tasks) + (select count(*) from cb.sessions) as n`)[0].n;
  for (const f of FORMS) {
    const [cmd, ...args] = f;
    assert.ok(onlyReads(cmd, args), `cb ${f.join(' ')} is not marked reads`);
    // as $CB_ACTOR, and as a bound pane (cb start takes its bound branch, every command reads the binding)
    for (const env of [{}, { HERDR_PANE_ID: 'p-ro', CB_ACTOR: '' }]) {
      const r = cb(f, env);
      const where = `cb ${f.join(' ')}${env.HERDR_PANE_ID ? ' (bound pane)' : ''}`;
      assert.doesNotMatch(r.err, /read-only transaction|25006/, `${where} wrote: ${r.err}`);
      if (!MAY_FAIL.has(f.join(' '))) assert.equal(r.code, 0, `${where}: ${r.err}`);
      if (cmd === 'key') assert.match(r.err, /CB_BOARD_URL/, where);
    }
  }
  assert.equal((await sql`select (select count(*) from cb.events) + (select count(*) from cb.tasks) + (select count(*) from cb.sessions) as n`)[0].n, before);

  // the control: a real write on the same connection settings must fail
  const w = cb(['add', 'demo', 'should fail']);
  assert.equal(w.code, 1, w.out);
  assert.match(w.err, /read-only transaction/);
});
