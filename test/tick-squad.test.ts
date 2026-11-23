import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';

// cb tick and cb start in a pipeline project (#3598): the lead is never steered around a stage
const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
const dir = mkdtempSync(join(tmpdir(), 'cb-tick-squad-'));
let n = 0;
function fakeGh(prs: Record<string, any>) {
  const f = join(dir, `gh${++n}.mjs`);
  writeFileSync(f, `const prs = ${JSON.stringify(prs)};
    const q = process.argv.find((a) => a.startsWith('query='));
    const repo = {}; for (const [, n] of q.matchAll(/p(\\d+): *pullRequest/g)) repo['p' + n] = prs[n] ?? null;
    process.stdout.write(JSON.stringify({ data: { repository: repo } }));`);
  return { CB_GH: f, CB_GH_CACHE: join(dir, `cache${n}.json`) };
}
function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'orch@pc', HERDR_PANE_ID: '', ...fakeGh({}), ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const URL = 'https://github.com/acme/app/pull/';
const MERGED = (oid?: string) => ({ state: 'MERGED', headRefOid: '1'.repeat(40), mergeable: 'UNKNOWN', ...(oid ? { mergeCommit: { oid } } : {}) });

async function setup() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, last_seen) values
    ('mac','p2','B1@mac','demo','builder', now()), ('pc','p4','orch@pc','demo',null, now())`;
  return sql;
}
const card = async (sql: any, stage: string, pr: number) => {
  const [{ id }] = await sql`select cb.task_add(project => 'demo', title => 'c', type => 'feature', status => 'next', links => ${sql.json({ pr: URL + pr })}, actor => 'orch@pc') as id`;
  await sql`select cb._stage_move(${id}, ${stage}, null, 'x')`;
  return Number(id);
};

test('tick: a merged PR on a staged card passes the merge stage, and says nothing at other stages', async () => {
  const sql = await setup();
  const merge = await card(sql, 'merge', 11), build = await card(sql, 'build', 12), approval = await card(sql, 'approval', 13);
  const sha = 'a'.repeat(40);
  const r = cb(['tick', 'demo'], fakeGh({ 11: MERGED(sha), 12: MERGED(sha), 13: MERGED(sha) }));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`#${merge} \\w+ but PR #11 merged → cb pass ${merge} 'PR #11 merged' --commit ${sha}`));
  assert.doesNotMatch(r.out, new RegExp(`#(${build}|${approval}) .*merged`));
  assert.doesNotMatch(r.out, /cb done/);
  // no merge commit known: the stage's own finish line, never a command that fails
  const r2 = cb(['tick', 'demo'], fakeGh({ 11: MERGED(), 12: MERGED(), 13: MERGED() }));
  assert.match(r2.out, new RegExp(`#${merge} \\w+ but PR #11 merged → merge it, then cb pass ${merge} "<what merged>" --commit <sha>`));
});

test('tick: an unstaged card with a merged PR still says cb done; pipeline off too', async () => {
  const sql = await setup();
  await sql`select cb.task_add(project => 'demo', title => 'plain', status => 'in_progress', assignee => 'W7@m', links => ${sql.json({ pr: URL + '21' })}, actor => 'github')`;
  assert.match(cb(['tick', 'demo'], fakeGh({ 21: MERGED() })).out, /#1 in_progress but PR #21 merged → cb done 1 'PR #21 merged'/);
});

test('tick: approval cards are not unreviewed, and an idle session is only offered cards its role can take', async () => {
  const sql = await setup();
  const design = await card(sql, 'design', 33); // first in Next, but a builder cannot take it
  await sql`update cb.tasks set links = '{}' where id = ${design}`;
  const approval = await card(sql, 'approval', 31);
  await sql`update cb.tasks set links = '{}' where id = ${approval}`;
  const build = await card(sql, 'build', 32); // a builder can take it
  await sql`update cb.tasks set links = '{}' where id = ${build}`;
  const r = cb(['tick', 'demo', '--as', 'orch@pc']);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /no reviewer task/);
  assert.match(r.out, new RegExp(`B1@mac idle → cb tell B1@mac 'take #${build} `));
  assert.doesNotMatch(r.out, new RegExp(`take #${design} `));
});

test('start: a staged card in progress prints the stage finish line, not cb done', async () => {
  const sql = await setup();
  const id = await card(sql, 'build', 41);
  await sql`update cb.tasks set status = 'in_progress', assignee = 'B1@mac' where id = ${id}`;
  const r = cb(['start', '--as', 'B1@mac']);
  assert.match(r.out, new RegExp(`continue #${id} .*cb pass ${id} "<summary>" --pr <url>`));
  assert.doesNotMatch(r.out, /cb done/);
  await sql`select cb.project_pipeline('demo', false, 'ahmed')`;
  assert.match(cb(['start', '--as', 'B1@mac']).out, new RegExp(`cb done ${id} "<summary>" --commit <sha> when finished`));
});
