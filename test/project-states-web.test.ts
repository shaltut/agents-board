// Project states, slice 2 (#4559): the Projects page and the header. Its words (pure, from web/src/lib/projects.ts),
// which lists offer only enabled projects, and the "All projects" reads that leave a disabled or archived project out.
// Made-up project names; real test database for the reads, in the style of test/project-states.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads
import { STATE_LABEL, actions, bannerText, confirmText, countsLine, groups, stateLine, type Preview } from '../web/src/lib/projects.ts';
import { liveOnly, NO_ACTOR } from '../web/src/lib/api.ts';
import { PAGES } from '../web/src/lib/route.ts';

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');
const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));

const root = join(import.meta.dirname, '..');
const src = (...p: string[]) => readFileSync(join(root, 'web', 'src', ...p), 'utf8');
const AT = '2026-11-27T14:05:00Z';
const RAW = /_|\bundefined\b|\bnull\b|\bNaN\b|\[object/; // a key, or a value that never got its words
const row = (o: Partial<any> = {}) => ({ slug: 'cedar', name: 'Cedar', state: 'enabled', state_by: null, state_at: null,
  open_count: 9, in_progress_count: 2, seats_live: 3, question_count: 1, ...o }) as any;
const pv = (o: Partial<Preview> = {}): Preview => ({ name: 'Cedar', seats_live: 4, open: 9, in_progress: 2, held: 2,
  jobs_waiting: 3, jobs_running: 1, questions: 1, github_watches: 1, ...o });

test('each state reads in Ahmed\'s words: who and when on a disabled row, the day on an archived one', () => {
  assert.deepEqual(STATE_LABEL, { enabled: 'Enabled', disabled: 'Disabled', archived: 'Archived' });
  assert.equal(stateLine(row()), 'Enabled');
  assert.match(stateLine(row({ state: 'disabled', state_by: 'ahmed', state_at: AT })), /^Disabled by Ahmed on \d{1,2} Nov \d{2}:\d{2}$/);
  assert.match(stateLine(row({ state: 'archived', state_by: 'board', state_at: AT })), /^Archived on \d{1,2} Nov$/, 'the one-time mapping names nobody');
  assert.equal(stateLine(row({ state: 'disabled' })), 'Disabled', 'no time stored: no "on"');
  assert.equal(countsLine(row()), '9 open · 2 in progress · 3 seats live · 1 question for you');
  assert.equal(countsLine(row({ question_count: 0, seats_live: 1 })), '9 open · 2 in progress · 1 seat live');
  assert.equal(countsLine(row({ state: 'disabled', question_count: 0 })), '9 open · 2 in progress, held and waiting · 3 seats still live');
  assert.equal(countsLine(row({ state: 'archived', open_count: 41 })), '41 open cards kept, readable');
});

test('the buttons: Disable asks first; Enable and Archive on a disabled one; an archived one only unarchives, back to disabled', () => {
  assert.deepEqual(actions('enabled'), [{ to: 'disabled', label: 'Disable…', confirm: true }]);
  assert.deepEqual(actions('disabled'), [{ to: 'enabled', label: 'Enable', confirm: false }, { to: 'archived', label: 'Archive…', confirm: true }]);
  assert.deepEqual(actions('archived'), [{ to: 'disabled', label: 'Unarchive', confirm: false }]);
});

test('the confirm dialog says what disabling touches, from the preview, and promises nothing a later slice adds', () => {
  const d = confirmText('disabled', pv());
  assert.equal(d.title, 'Disable Cedar?');
  assert.equal(d.button, 'Disable Cedar');
  assert.equal(d.lead, 'No new work starts there. Nothing is deleted, and Enable brings it all back.');
  assert.deepEqual(d.lines, [
    '4 seats live: each gets a notice, stops at a safe point and writes where it stands.',
    '2 cards in progress keep their holders.',
    '3 test runs waiting stay waiting. 1 running finishes.',
    '1 question for you leaves Today and Telegram until you enable it.',
    '1 GitHub repo watch stops until you enable it.',
  ]);
  const one = confirmText('disabled', pv({ seats_live: 1, in_progress: 1, jobs_waiting: 1, jobs_running: 0, questions: 2, github_watches: 2 }));
  assert.deepEqual(one.lines, ['1 seat live: each gets a notice, stops at a safe point and writes where it stands.', '1 card in progress keeps its holder.',
    '1 test run waiting stays waiting.', '2 questions for you leave Today and Telegram until you enable it.', '2 GitHub repo watches stop until you enable it.']);
  const none = confirmText('disabled', pv({ seats_live: 0, in_progress: 0, jobs_waiting: 0, jobs_running: 0, questions: 0, github_watches: 0 }));
  assert.deepEqual(none.lines, ['Nothing is running there now.']);
  const a = confirmText('archived', pv({ open: 41 }));
  assert.equal(a.title, 'Archive Cedar?');
  assert.equal(a.button, 'Archive Cedar');
  assert.match(a.lines.join(' '), /41 open cards stay readable/);
  assert.match(a.lines.join(' '), /Unarchive brings it back as disabled/);
  for (const t of [d, one, none, a].flatMap((x) => [x.title, x.lead, x.button, ...x.lines])) {
    assert.doesNotMatch(t, /supervisor|closes? (them|it)/i, 'slice 3 (the supervisor closing idle seats) is not shipped yet');
    assert.doesNotMatch(t, /cancel/i, 'slice 4 (archive cancels waiting jobs) is not shipped yet');
    assert.doesNotMatch(t, RAW, `no stored value in "${t}"`);
  }
});

test('the banner on a chosen project that gets no work; nothing while it is enabled', () => {
  assert.equal(bannerText(row()), null);
  assert.match(bannerText(row({ state: 'disabled', state_by: 'ahmed', state_at: AT }))!,
    /^Cedar has been disabled by Ahmed since \d{1,2} Nov \d{2}:\d{2}: no new work is handed out\. Cards and history are kept\.$/);
  assert.equal(bannerText(row({ state: 'archived' })), 'Cedar is archived: nothing new goes there. Cards and history are kept.');
  const app = src('App.tsx');
  assert.match(app, /\(route\.view === 'board' \|\| route\.view === 'backlog' \|\| route\.view === 'sessions'\) && <StateBanner project=\{route\.project\} owner=\{owner\} \/>/);
});

test('the list: enabled first, then disabled, by name; archived ones apart, folded', () => {
  const ps = [row({ name: 'Old Pilot', state: 'archived' }), row({ name: 'Cedar', state: 'disabled' }), row({ name: 'Beacon' }), row({ name: 'Atlas' })];
  const g = groups(ps);
  assert.deepEqual(g.shown.map((p) => p.name), ['Atlas', 'Beacon', 'Cedar']);
  assert.deepEqual(g.archived.map((p) => p.name), ['Old Pilot']);
  assert.deepEqual(liveOnly(ps).map((p) => p.name), ['Beacon', 'Atlas']);
});

test('the header and every picker list enabled projects only; the Settings menu entry is Projects; the page is the list', () => {
  assert.equal(PAGES.find((p) => p.view === 'settings')?.label, 'Projects');
  const sw = src('components', 'ProjectSwitcher.tsx');
  assert.match(sw, /const projects = liveOnly\(all\)/);
  assert.match(sw, /const current = all\.find/, 'the open project is found in every state, so its name and pill show');
  assert.match(sw, /current\.state !== 'enabled' && <StatePill/);
  for (const f of [['components', 'CommandMenu.tsx'], ['components', 'NewTask.tsx'], ['views', 'Backlog.tsx'], ['views', 'Epics.tsx'],
    ['views', 'Goals.tsx'], ['views', 'Huddles.tsx'], ['views', 'Memory.tsx']]) {
    const text = src(...f);
    assert.match(text, /const projects = useLiveProjects\(\)/, f.join('/'));
    assert.doesNotMatch(text, /useProjects\(\)/, `${f.join('/')}: no full list`);
  }
  assert.match(src('components', 'settings', 'GitHub.tsx'), /others=\{liveOnly\(projects\)/);
  assert.match(src('views', 'Settings.tsx'), /if \(!route\.project\) return <ProjectsList \/>/);
  assert.ok(NO_ACTOR.has('project_state_preview') && !NO_ACTOR.has('project_state'), 'the change carries Ahmed as actor; the read takes none');
  const page = src('components', 'projects', 'ProjectsList.tsx');
  assert.match(page, /rpc\('project_state', \{ project: p\.slug, state: to \}\)/);
  assert.match(page, /rpc<Preview>\('project_state_preview', \{ project: p\.slug \}\)/);
  assert.doesNotMatch(page, />\s*\{(p\.state|state|a\.to|asking\.to)\}/, 'the stored state is never printed as text');
});

test('All projects reads (Board, Backlog, Today, Sessions) leave a disabled or archived project out; chosen, it shows', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('cedar'), cb.ensure_project('atlas'), cb.ensure_project('oldpilot')`;
  await sql`insert into cb.sessions (machine, pane, actor, project) values ('pc','p1','W1@pc','cedar'), ('pc','p2','A1@pc','atlas'), ('pc','p3','O1@pc','oldpilot')`;
  await sql`select cb.task_add(project => 'cedar', title => 'cedar card', status => 'in_progress', assignee => 'W1@pc', actor => 'W1@pc')`;
  await sql`select cb.task_add(project => 'atlas', title => 'atlas card', status => 'in_progress', assignee => 'A1@pc', actor => 'A1@pc')`;
  await sql`select cb.task_add(project => 'oldpilot', title => 'old card', status => 'blocked', assignee => 'O1@pc', actor => 'O1@pc')`;
  const get = async (path: string) => (await app.request(path)).json();
  const projects = await get('/api/projects');
  const cedar = projects.find((p: any) => p.slug === 'cedar');
  assert.deepEqual([cedar.in_progress_count, cedar.seats_live], [1, 1], 'the row counts');

  await sql`select cb.project_state('cedar', 'disabled', 'ahmed'), cb.project_state('oldpilot', 'disabled', 'ahmed'), cb.project_state('oldpilot', 'archived', 'ahmed')`;
  assert.deepEqual((await get('/api/tasks')).map((t: any) => t.project), ['atlas'], 'Board and Backlog, all projects');
  assert.deepEqual((await get('/api/tasks?project=cedar')).map((t: any) => t.title), ['cedar card'], 'chosen, it shows');
  const today = await get('/api/today');
  assert.deepEqual([today.counts.active, today.counts.blocked], [1, 0], 'Today\'s counts: atlas only');
  assert.ok(today.events.length > 0 && today.events.every((e: any) => e.project === null || e.project === 'atlas'), 'Today\'s events: atlas only');
  assert.equal((await get('/api/today?project=cedar')).counts.active, 1);
  assert.deepEqual((await get('/api/sessions')).map((s: any) => s.actor), ['A1@pc'], 'Sessions, all projects');
  assert.deepEqual((await get('/api/sessions?project=cedar')).map((s: any) => s.actor), ['W1@pc']);
  assert.deepEqual((await get('/api/projects')).map((p: any) => [p.slug, p.state]),
    [['atlas', 'enabled'], ['cedar', 'disabled'], ['oldpilot', 'archived']], 'the Projects page still gets every project');
});
