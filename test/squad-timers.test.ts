import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

// demo has the pipeline on; B1 builds (live), card 1 is staged at build and held in progress by B1
async function setup(o: { type?: string } = {}) {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.project_pipeline('demo', true, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p2','B1@mac','demo','builder'), ('pc','p4','orch@pc','demo',null)`;
  await sql`select cb.task_add(project => 'demo', title => 'Fix the thing', type => ${o.type ?? 'bug'}, stage => ${o.type === 'research' ? null : 'build'}, why => 'small', actor => 'orch@pc')`;
  await sql`update cb.tasks set status = 'in_progress', assignee = 'B1@mac' where id = 1`;
  const age = (mins: number) => sql`update cb.tasks set updated_at = now() - ${mins + ' minutes'}::interval where id = 1`
    .then(() => sql`update cb.sessions set started_at = now() - ${mins + ' minutes'}::interval where actor = 'B1@mac'`)
    .then(() => sql`update cb.events set at = now() - ${mins + ' minutes'}::interval where (task_id = 1 or actor = 'B1@mac') and not (data ? 'nudge')`);
  const nudges = async () => (await sql`select data ->> 'to' as to_, summary from cb.events where data ? 'stall' and kind = 'message' order by id`) as any[];
  const due = async () => (await sql`select cb.stage_stalls_due() as n`)[0].n;
  return { sql, age, nudges, due };
}

test('a quiet card is nudged at 30 minutes and freed at 90 if nobody answers', async () => {
  const { sql, age, nudges, due } = await setup();
  await age(20);
  assert.equal(await due(), 0);
  await age(31);
  assert.equal(await due(), 1);
  let m = await nudges();
  assert.equal(m.length, 1);
  assert.equal(m[0].to_, 'B1@mac');
  assert.match(m[0].summary, /#1 "Fix the thing" has had no update for 0h 31m at Building\. Say where it stands \(cb log 1 "\.\.\."\) or it goes back to the queue in an hour\./);
  assert.equal(await due(), 0, 'one nudge only');
  await age(91);
  await sql`update cb.stage_nudges set nudged_at = now() - interval '60 minutes'`;
  assert.equal(await due(), 2, 'a note to the holder and the release');
  const [t] = await sql`select status, assignee, stage from cb.tasks where id = 1`;
  assert.deepEqual({ ...t }, { status: 'next', assignee: null, stage: 'build' });
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = 1 and summary like 'freed from B1@mac: %'`)[0].n, 1);
  assert.equal((await sql`select count(*)::int n from cb.events where task_id = 1 and kind = 'message' and summary like '#1 went back to the queue: %' and data ->> 'to' = 'B1@mac'`)[0].n, 1);
  assert.equal((await sql`select count(*)::int n from cb.stage_nudges`)[0].n, 0);
});

test('work elsewhere is not quiet', async () => {
  const { sql, age, due } = await setup();
  await age(31);
  assert.equal(await due(), 1);
  await sql`select cb.task_add(project => 'demo', title => 'other', actor => 'B1@mac')`; // holder acts on another card
  await age(91);
  await sql`update cb.events set at = now() - interval '50 minutes' where actor = 'B1@mac' and task_id = 2`;
  await sql`update cb.stage_nudges set nudged_at = now() - interval '45 minutes'`;
  assert.equal(await due(), 0);
  assert.equal((await sql`select assignee from cb.tasks where id = 1`)[0].assignee, 'B1@mac');
});

test('a session that is down keeps its cards (Q2324)', async () => {
  const { sql, age, nudges, due } = await setup();
  await sql`update cb.sessions set last_seen = now() - interval '3 hours' where actor = 'B1@mac'`;
  await age(180);
  assert.equal(await due(), 0);
  assert.equal((await nudges()).length, 0);
  await sql`update cb.tasks set status = 'next' where id = 1`; // a hold
  await age(180);
  assert.equal(await due(), 0);
  assert.equal((await sql`select assignee from cb.tasks where id = 1`)[0].assignee, 'B1@mac');
});

test('a hold whose live holder is quiet for 90 minutes is released', async () => {
  const { sql, age, due } = await setup();
  await sql`update cb.tasks set status = 'next' where id = 1`;
  await age(89);
  assert.equal(await due(), 0);
  await age(91);
  assert.equal(await due(), 2, 'the release and its message');
  const [t] = await sql`select status, assignee from cb.tasks where id = 1`;
  assert.deepEqual({ ...t }, { status: 'next', assignee: null });
});

test('a released card goes to the head of Next', async () => {
  const { sql, age, due } = await setup();
  await sql`select cb.task_add(project => 'demo', title => 'queued', status => 'next', actor => 'orch@pc')`;
  const [{ r }] = await sql`select rank as r from cb.tasks where id = 2`;
  await age(91);
  await sql`insert into cb.stage_nudges (task_id, nudged_at) values (1, now() - interval '60 minutes')`;
  await due();
  assert.ok(Number((await sql`select rank from cb.tasks where id = 1`)[0].rank) < Number(r));
});

test('approval, investigation and non-pipeline cards are never touched', async () => {
  const { sql, age, nudges, due } = await setup({ type: 'research' });
  await age(180);
  assert.equal(await due(), 0);
  assert.equal((await nudges()).length, 0);
  assert.equal((await sql`select assignee from cb.tasks where id = 1`)[0].assignee, 'B1@mac');
  // a card waiting at approval, held by its designer
  await sql`select cb.task_add(project => 'demo', title => 'wait', type => 'bug', stage => 'build', why => 'small', actor => 'orch@pc')`;
  await sql`select cb._stage_move(2, 'approval', 'B1@mac', 'design done')`;
  await sql`update cb.tasks set updated_at = now() - interval '5 hours' where id = 2`;
  // a card in a project without the pipeline
  await sql`select cb.ensure_project('old')`;
  await sql`select cb.task_add(project => 'old', title => 'plain', status => 'in_progress', assignee => 'B1@mac', actor => 'B1@mac')`;
  await sql`update cb.tasks set updated_at = now() - interval '5 hours' where id = 3`;
  await sql`update cb.events set at = now() - interval '5 hours'`;
  assert.equal(await due(), 0);
});

test('nudge rows of cards that left the pipeline are cleaned up', async () => {
  const { sql, due } = await setup();
  await sql`insert into cb.stage_nudges (task_id, nudged_at) values (1, now())`;
  await sql`update cb.tasks set stage = null where id = 1`;
  await due();
  assert.equal((await sql`select count(*)::int n from cb.stage_nudges`)[0].n, 0);
});

test('a restored session keeps its cards: nudged once, never freed a minute later', async () => {
  const { sql, age, due } = await setup();
  await sql`update cb.sessions set last_seen = now() - interval '3 hours' where actor = 'B1@mac'`;
  await age(180);
  assert.equal(await due(), 0);
  await sql`update cb.sessions set last_seen = now(), started_at = now() where actor = 'B1@mac'`; // Ahmed restores it
  assert.equal(await due(), 0, 'a fresh session is not quiet');
  assert.equal(await due(), 0);
  assert.equal((await sql`select assignee from cb.tasks where id = 1`)[0].assignee, 'B1@mac');
  // a nudge sent under 60 minutes ago is not followed by a release, however quiet the card was
  await age(180);
  await sql`update cb.sessions set started_at = now() - interval '3 hours'`;
  assert.equal(await due(), 1);
  assert.equal(await due(), 0);
  assert.equal((await sql`select assignee from cb.tasks where id = 1`)[0].assignee, 'B1@mac');
});

// ---- the lead's digest (Task 9) ----
async function digestSetup() {
  const { sql } = await setup();
  const add = async (title: string, o: any = {}) => Number((await sql`select cb.task_add(project => 'demo', title => ${title}, type => ${o.type ?? null}, actor => ${o.actor ?? 'orch@pc'}) as id`)[0].id);
  await sql`update cb.sessions set model = 'opus' where actor = 'B1@mac'`;
  const merge = await add('to merge'); await sql`update cb.tasks set stage = 'merge', status = 'next' where id = ${merge}`;
  const appr = await add('to approve'); await sql`update cb.tasks set stage = 'approval', status = 'review', stage_since = now() - interval '3 hours' where id = ${appr}`;
  const plain = await add('unstaged', { actor: 'github' });
  const freed = await add('freed one'); await sql`update cb.tasks set stage = 'build', status = 'next' where id = ${freed}`;
  await sql`insert into cb.events (actor, project, task_id, kind, summary, data) values ('board','demo',${freed},'note','freed from B1@mac: held for 1h 40m with no activity','{"stall":true}')`;
  await sql`insert into cb.events (actor, project, task_id, kind, summary, data) values ('orch@pc','demo',1,'note','small work, skipped design: tiny','{"small":true}')`;
  const design = await add('held at design'); await sql`update cb.tasks set status = 'next', assignee = 'B1@mac' where id = ${design}`;
  const research = await add('look into it', { type: 'research' }); await sql`update cb.tasks set status = 'next' where id in (${research}, ${plain})`;
  const tagged = await add('needs an owner'); await sql`update cb.tasks set labels = array['billing'] where id = ${tagged}`;
  const rebound = await add('re-bound'); await sql`update cb.tasks set stage = 'build', status = 'next', assignee = 'W1@mac' where id = ${rebound}`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p9','W9@mac','demo','builder')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, last_seen) values ('mac','p7','B2@mac','demo','builder', now() - interval '3 hours')`;
  const gone = await add('on a down session'); await sql`update cb.tasks set stage = 'build', status = 'in_progress', assignee = 'B2@mac' where id = ${gone}`;
  return { sql, merge, appr, plain, freed, design, research, rebound, gone, tagged };
}

test('the digest names what needs the lead, each with its command', async () => {
  const { sql, merge, appr, plain, freed, design, research, rebound, gone, tagged } = await digestSetup();
  await sql`select cb.ask(project => 'demo', body => 'Which one?', actor => 'orch@pc')`;
  await sql`select cb.answer('1', 'this one')`;
  const lines: string[] = (await sql`select cb.digest('demo') as d`)[0].d;
  assert.ok(lines.length <= 20);
  assert.match(lines[0], /^Stages: design 2 · waiting for Ahmed 1 · build \d · review 0 · merge 1 · QA on dev 0$/);
  const has = (re: RegExp) => assert.ok(lines.some((l) => re.test(l)), `${re}\n${lines.join('\n')}`);
  has(new RegExp(`^#${freed} freed from B1@mac \\(held for 1h 40m with no activity\\): cb session B1@mac$`));
  has(/^1 designs wait for Ahmed's approval, oldest 3h \(#\d+\)/);
  has(new RegExp(`^#${merge} reviewed: merge it, then cb pass ${merge} --commit <sha>$`));
  has(/^Q1 answered for orch@pc \(.*\): cb pending$/);
  has(new RegExp(`^#${tagged} has no area owner \\(tags: billing\\): an architect takes it after 15 min, or cb tag ${tagged} <area>`));
  has(/small work, skipped design: tiny: cb show 1$/);
  has(new RegExp(`^#${plain} is not staged: cb edit ${plain} --assignee <session>$`));
  has(new RegExp(`^W1@mac is down and holds #${rebound}: restore it, or cb edit ${rebound} --assignee <session>$`));
  has(new RegExp(`^B2@mac is down and holds #${gone}: `));
  has(/^B1@mac is a builder on opus; the role runs sonnet: restart it with --model sonnet$/);
  has(new RegExp(`^nobody can take: #${design} \\(held by B1@mac, a builder, at design\\), #${research} \\(research, no investigator\\), #${tagged} \\(design, no live session can take it\\)$`));
  assert.equal((await sql`select count(*)::int n from cb.tasks where id = ${appr} and assignee is not null`)[0].n, 0, 'the digest frees nothing');
  assert.equal((await sql`select count(*)::int n from cb.events where task_id is not null and (data ->> 'digest') = 'true'`)[0].n, 0, 'and writes nothing on cards');
});

test('P0 cards come first, behind the stage line', async () => {
  const { sql, plain } = await digestSetup();
  await sql`update cb.tasks set priority = 'P0' where id = ${plain}`;
  const lines: string[] = (await sql`select cb.digest('demo') as d`)[0].d;
  assert.match(lines[1], new RegExp(`^#${plain} is P0: "unstaged": cb show ${plain}$`));
  assert.match(lines[2], new RegExp(`^#${plain} is not staged`));
});

test('digests go every 15 minutes, at once on a P0, and never empty', async () => {
  const { sql } = await digestSetup();
  const due = async () => (await sql`select cb.digests_due() as n`)[0].n;
  const sent = async () => (await sql`select data ->> 'to' as to_, summary from cb.events where data ? 'digest' and kind = 'message' and actor = 'board' order by id`) as any[];
  assert.equal(await due(), 1);
  const m = await sent();
  assert.equal(m.length, 1);
  assert.equal(m[0].to_, 'orch@pc');
  assert.match(m[0].summary, /^Digest for demo:\nStages: design 2/);
  assert.equal(await due(), 0, 'again at once: nothing');
  await sql`select cb.task_add(project => 'demo', title => 'on fire', priority => 'P0', actor => 'github')`;
  assert.equal(await due(), 1, 'a new P0 goes out at once');
  // quiet: clear every reason to speak, age the last digest 16 minutes
  await sql`update cb.tasks set status = 'cancelled'`;
  await sql`delete from cb.sessions where actor in ('W9@mac', 'B2@mac')`;
  await sql`update cb.sessions set model = 'sonnet'`;
  await sql`update cb.questions set status = 'delivered'`;
  await sql`delete from cb.events where data ? 'small' or data ? 'stall'`;
  await sql`update cb.settings set value = jsonb_build_object('at', now() - interval '16 minutes') where key = 'digest:demo'`;
  const before = (await sent()).length;
  assert.equal(await due(), 0);
  assert.equal((await sent()).length, before, 'only the stage line: nothing to say');
  const [{ at }] = await sql`select (value ->> 'at')::timestamptz > now() - interval '1 minute' as at from cb.settings where key = 'digest:demo'`;
  assert.equal(at, true, 'and the time is still recorded');
});

test('pipeline projects stop sending the lead per-event copies', async () => {
  const { sql, age } = await setup();
  await sql`select cb.ensure_project('old')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('pc','p5','orch@pc2','old',null), ('mac','p6','W2@mac','old',null)`;
  const q = async (proj: string, who: string) => Number((await sql`select cb.ask(project => ${proj}, body => 'ok?', actor => ${who}) as id`)[0].id);
  const dq = await q('demo', 'B1@mac'), oq = await q('old', 'W2@mac');
  await sql`select cb.answer(${String(dq)}, 'yes')`; await sql`select cb.answer(${String(oq)}, 'yes')`;
  const box = async (m: string, p: string) => (await sql`select cb.inbox(${m}, ${p}, 0) as i`)[0].i;
  assert.equal((await box('pc', 'p4')).answer_copies.length, 0, 'pipeline: no copy');
  assert.equal((await box('pc', 'p5')).answer_copies.length, 1, 'plain project: still a copy');
  // a pinged staged card asks its holder only
  await age(120);
  await sql`select cb.task_ping_set('1', true, 'ahmed')`;
  assert.equal((await sql`select cb.pings_due() as n`)[0].n, 1);
  assert.deepEqual((await sql`select data ->> 'to' as t from cb.events where kind = 'message' and data ? 'nudge' and summary like 'Card #1 %'`).map((r: any) => r.t), ['B1@mac']);
  // a freed blocked card is not copied to the lead either
  await sql`select cb.task_add(project => 'demo', title => 'blocker', actor => 'orch@pc')`;
  await sql`select cb.task_add(project => 'demo', title => 'waits', status => 'backlog', actor => 'orch@pc')`;
  await sql`select cb.task_block('3', '2', 'orch@pc')`;
  await sql`select cb.task_move('2', 'cancelled', null, 'orch@pc')`;
  assert.equal((await sql`select count(*)::int n from cb.events where kind = 'message' and summary like 'unblocked: #3%'`)[0].n, 0);
});

test('a new P0 in a quiet project is sent at once, and named', async () => {
  const { sql } = await setup();
  const due = async () => (await sql`select cb.digests_due() as n`)[0].n;
  await sql`delete from cb.events where data ? 'small'`;
  assert.equal(await due(), 0, 'quiet: only the stage line');
  await sql`select cb.task_add(project => 'demo', title => 'on fire', priority => 'P0', actor => 'github')`;
  assert.equal(await due(), 1);
  const [m] = await sql`select summary from cb.events where data ? 'digest' and kind = 'message' order by id desc limit 1`;
  assert.match(m.summary, /#2 is P0: "on fire": cb show 2/);
});

test('each group is capped at 5 lines and never buries a later group', async () => {
  const { sql } = await setup();
  for (let i = 0; i < 8; i++) await sql`select cb.task_add(project => 'demo', title => ${'plain ' + i}, status => 'next', actor => 'github')`;
  await sql`update cb.sessions set model = 'opus' where actor = 'B1@mac'`;
  const lines: string[] = (await sql`select cb.digest('demo') as d`)[0].d;
  assert.equal(lines.filter((l) => /is not staged/.test(l)).length, 5);
  assert.equal(lines.filter((l) => /\+3 more/.test(l)).length, 1);
  assert.ok(lines.some((l) => /B1@mac is a builder on opus/.test(l)), lines.join('\n'));
  // many P0 lines: total cap with a closing line
  for (let i = 0; i < 5; i++) await sql`select cb.task_add(project => 'demo', title => 'x', priority => 'P0', status => 'next', actor => 'github')`;
  for (let i = 0; i < 5; i++) await sql`select cb.task_add(project => 'demo', title => 'm', actor => 'orch@pc')`;
  await sql`update cb.tasks set stage = 'merge', status = 'next' where title = 'm'`;
  for (let i = 0; i < 5; i++) await sql`select cb.task_add(project => 'demo', title => 'd', actor => 'orch@pc')`;
  await sql`update cb.tasks set labels = array['billing'] where title = 'd'`;
  const all: string[] = (await sql`select cb.digest('demo') as d`)[0].d;
  assert.ok(all.length <= 20);
  assert.match(all.at(-1)!, /^\+\d+ more: cb digest demo --all$/);
});

test('an identical digest is not repeated, a changed one is', async () => {
  const { sql } = await digestSetup();
  const due = async () => (await sql`select cb.digests_due() as n`)[0].n;
  const age = () => sql`update cb.settings set value = value || jsonb_build_object('at', now() - interval '16 minutes') where key = 'digest:demo'`;
  assert.equal(await due(), 1);
  await age();
  assert.equal(await due(), 0, 'same body 16 minutes later: nothing');
  await age();
  await sql`select cb.task_add(project => 'demo', title => 'another', status => 'next', actor => 'github')`;
  assert.equal(await due(), 1, 'a changed body goes out');
});

test('an unheld review card whose only live reviewer built it is named; a down holder of a blocked card too', async () => {
  const { sql } = await setup();
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p8','R1@mac','demo','reviewer')`;
  await sql`select cb.task_add(project => 'demo', title => 'to review', actor => 'orch@pc')`;
  await sql`update cb.tasks set stage = 'review', status = 'next', crew = '{"build":"R1@mac"}' where id = 2`;
  await sql`select cb.task_add(project => 'demo', title => 'blocked one', actor => 'orch@pc')`;
  await sql`update cb.tasks set stage = 'build', status = 'blocked', assignee = 'W7@mac' where id = 3`;
  const lines: string[] = (await sql`select cb.digest('demo') as d`)[0].d;
  assert.ok(lines.some((l) => /^nobody can take: #2 \(review, no live session can take it\)/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^W7@mac is down and holds #3:/.test(l)), lines.join('\n'));
});

test('cb digest --all shows what the digest caps', async () => {
  const { sql } = await setup();
  for (let i = 0; i < 8; i++) await sql`select cb.task_add(project => 'demo', title => ${'plain ' + i}, status => 'next', actor => 'github')`;
  for (let i = 0; i < 7; i++) await sql`select cb.task_add(project => 'demo', title => 'm', actor => 'orch@pc')`;
  await sql`update cb.tasks set stage = 'merge', status = 'next' where title = 'm'`;
  for (let i = 0; i < 5; i++) await sql`select cb.task_add(project => 'demo', title => 'd', actor => 'orch@pc')`;
  await sql`update cb.tasks set labels = array['billing'] where title = 'd'`;
  for (let i = 0; i < 5; i++) await sql`select cb.task_add(project => 'demo', title => 'x', priority => 'P0', actor => 'github')`;
  const capped: string[] = (await sql`select cb.digest('demo') as d`)[0].d;
  assert.ok(capped.some((l) => /\+2 more \(cb digest demo --all\)/.test(l)));
  assert.match(capped.at(-1)!, /^\+\d+ more: cb digest demo --all$/);
  const all: string[] = (await sql`select cb.digest('demo', cap => false) as d`)[0].d;
  assert.equal(all.filter((l) => /is not staged/.test(l)).length, 8);
  assert.ok(all.length > capped.length && all.length > 20);
  assert.ok(!all.some((l) => /more/.test(l)));
  // the closing count includes the items hidden behind a cut group's own "+K more"
  const n = Number(capped.at(-1)!.match(/^\+(\d+) more/)![1]);
  const unstagedShown = capped.map((l, i) => [l, i] as const).filter(([l]) => /is not staged/.test(l));
  assert.ok(unstagedShown.length < 5, 'the total cap cut the not-staged group before its own +3 more line (which is its 5th row, past position 18)');
  const inLines = capped.reduce((t, l) => t + Number(l.match(/ \+(\d+) more \(/)?.[1] ?? 0), 0);
  assert.equal(capped.length - 1 + inLines + n, all.length, 'shown + hidden in lines + hidden in the closing count = everything');
  const r = spawnSync('node', ['cli/cb.ts', 'digest', 'demo', '--all'], { encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'orch@pc', HERDR_PANE_ID: '', CB_MACHINE: 'pc', CLAUDE_CODE_MESSAGING_SOCKET: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Stages: /);
});

test('cb digest with no project and no bound session says which project', () => {
  const r = spawnSync('node', ['cli/cb.ts', 'digest'], { encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: '', HERDR_PANE_ID: '', CB_MACHINE: 'pc', CLAUDE_CODE_MESSAGING_SOCKET: '' } });
  assert.notEqual(r.status, 0);
  assert.ok((r.stderr + r.stdout).includes("no project: say which (cb digest ihop)"));
});
