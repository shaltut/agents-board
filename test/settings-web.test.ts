// The project settings page (#4332): its pure parts, and how they line up with db/schema.sql and the page list. No
// database: pure functions and file reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_MODELS, OWNER_ONLY_MESSAGE, ROLES, ROLE_TEXT_CAP, RX, STALE_PREFIX, agentLabel, checkSquad, diffSquads, historyLines,
  modelLabel, pathOk, roleLabel, roleTextLabel, roleTextState, saveError, seatNote, setCount, setRoleOn, summarizeSquad, toDocument,
  type Seat, type Squad, type SquadPage,
} from '../web/src/lib/squad.ts';
import { PAGES, visiblePages } from '../web/src/lib/route.ts';
import { NO_ACTOR } from '../web/src/lib/api.ts';

const root = join(import.meta.dirname, '..');
const schema = readFileSync(join(root, 'db', 'schema.sql'), 'utf8');
const opts = { agents: [{ agent: 'claude', main: true }, { agent: 'codex', main: false }, { agent: 'opencode', main: false }, { agent: 'agy', main: false }] };
const defaults = { lead: 'opus', architect: 'opus', owner: 'sonnet', builder: 'sonnet', reviewer: 'opus', qa: 'sonnet', investigator: 'opus' };

// a made-up two-machine, two-repo squad (the repo is public: no real names or paths)
const squad = (): Squad => ({
  machines: { pc: { herdr: null, board: 'C:/board' }, mac: { herdr: 'macbook', board: '/Users/x/board' } },
  repos: { api: { home: true, paths: { pc: 'C:/src/api', mac: '/Users/x/api' } }, web: { home: false, paths: { mac: '/Users/x/web' } } },
  roles: {
    lead: { count: 1, model: 'opus', machine: 'pc' },
    builder: { count: { api: 2, web: 1 }, model: 'sonnet', machine: 'mac', fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }], seats: { 'api:2': { model: 'opus' } } },
    reviewer: { count: { api: 1, web: 1 }, model: 'opus', machine: 'mac' },
    qa: { count: 1, model: 'sonnet', machine: 'pc' },
  },
  areas: [], supervise: true,
});

test('rpc() adds no actor to the settings reads: each takes none in db/schema.sql (Postgres would find no function)', () => {
  for (const fn of ['squad_page', 'squad_options', 'role_text_page', 'github_watches']) {
    const m = schema.match(new RegExp(`create function cb\\.${fn}\\(([^)]*)\\)`));
    assert.ok(m, `cb.${fn} is in the schema`);
    assert.ok(!/\bactor\b/.test(m![1]!), `cb.${fn} takes no actor`);
    assert.ok(NO_ACTOR.has(fn), `${fn} is in NO_ACTOR`);
  }
  for (const fn of ['squad_set', 'role_text_set', 'github_watch_add', 'github_watch_remove', 'github_mute', 'project_pipeline', 'task_ping_bulk']) {
    assert.ok(!NO_ACTOR.has(fn), `${fn} takes an actor`);
  }
});

test('Project settings is owner-only: registered as a screen, hidden from another admin, shown to the owner', () => {
  const page = PAGES.find((p) => p.view === 'settings');
  assert.equal(page?.owner, true);
  const built = (v: string) => v === 'settings';
  assert.deepEqual(visiblePages(false, built).map((p) => p.view), [], 'another admin: not in menus, command menu or g keys');
  assert.deepEqual(visiblePages(true, built).map((p) => p.view), ['settings']);
  const app = readFileSync(join(root, 'web', 'src', 'App.tsx'), 'utf8');
  const screens = app.match(/const SCREENS[^=]*= \{([^}]*)\}/)?.[1] ?? '';
  assert.match(screens, /\bsettings: Settings\b/, 'App.tsx SCREENS has the settings screen');
});

test('a stale save shows the server\'s own first sentence and offers a reload; the owner-only refusal shows as is; nothing else does', () => {
  assert.ok(schema.includes(`'${STALE_PREFIX} (it is now version %, your copy is version %).`), 'the prefix the page matches is squad_set\'s');
  assert.ok(schema.includes(`'${OWNER_ONLY_MESSAGE}'`) || readFileSync(join(root, 'server', 'main.ts'), 'utf8').includes(`'${OWNER_ONLY_MESSAGE}'`));
  const server = `${STALE_PREFIX} (it is now version 7, your copy is version 5). Load it again (reopen the page, or cb squad show demo --json), make your change there and save.`;
  const s = saveError(new Error(server), 'plain');
  assert.equal(s.kind, 'stale');
  assert.equal(s.text, `${STALE_PREFIX} (it is now version 7, your copy is version 5).`);
  assert.ok(!s.text.includes('cb squad'), 'no command line on the page');
  assert.deepEqual(saveError(new Error(OWNER_ONLY_MESSAGE), 'plain'), { kind: 'owner', text: OWNER_ONLY_MESSAGE });
  const raw = saveError(new Error('builder count for web must be a whole number from 1 to 8'), 'The squad was not saved.');
  assert.deepEqual(raw, { kind: 'other', text: 'The squad was not saved.' });
  assert.equal(saveError('boom', 'Plain.').text, 'Plain.');
  // the one refusal the form can't foresee (open cards on a removed repo): reworded, card numbers kept
  assert.ok(schema.includes("'repo % still has open work (%): finish or move those cards first'"), 'squad_set still words it so');
  assert.deepEqual(saveError(new Error('repo web still has open work (#12, #40): finish or move those cards first'), 'plain'),
    { kind: 'other', text: 'Repo web still has open cards (#12, #40). Finish or move them before removing it.' });
});

test('the role text counter counts what role_text_set stores, against its 8000 cap', () => {
  assert.equal(ROLE_TEXT_CAP, 8000);
  assert.match(schema, /if length\(b\) > 8000 then/, 'the server cap is 8000');
  const at = roleTextState('x'.repeat(8000), 'old');
  assert.equal(at.count, 8000); assert.equal(at.over, false); assert.equal(at.canSave, true);
  const over = roleTextState('x'.repeat(8001), 'old');
  assert.equal(over.over, true); assert.equal(over.canSave, false);
  assert.equal(roleTextState(`\n\t  ${'x'.repeat(8000)}  \r\n`, 'old').over, false, 'spaces and line breaks at either end are trimmed, as the server does');
  assert.equal(roleTextState('😀'.repeat(3), 'old').count, 3, 'characters, not UTF-16 units');
  assert.equal(roleTextState('  same  ', 'same').canSave, false, 'unchanged after trimming');
  assert.equal(roleTextState('   ', 'old').empty, true);
});

test('no stored codes on screen: role, agent and model names, the squad summary, history and seat notes', () => {
  // stored values that are not English words (lead, owner and the rest are, in lower case: "the lead", "Area owner")
  const codes = /\b(qa|claude|codex|opencode|agy|opus|sonnet|haiku|fable|_common|null|undefined|true|false|NaN)\b|[{}"]|\b[a-z]+:\d/;
  for (const r of ROLES) { assert.doesNotMatch(roleLabel(r), codes, r); assert.match(roleLabel(r), /^[A-Z]/, r); assert.notEqual(roleLabel(r), r); }
  for (const r of ['_common', ...ROLES]) assert.doesNotMatch(roleTextLabel(r), codes, r);
  for (const a of opts.agents) assert.doesNotMatch(agentLabel(a.agent), codes, a.agent);
  for (const m of CLAUDE_MODELS) assert.doesNotMatch(modelLabel(m), codes, m);
  const a = squad(), b = setCount(setRoleOn(a, 'investigator', true, defaults), 'builder', 3, 'api');
  b.roles.qa = { ...b.roles.qa!, model: 'haiku' };
  const lines = [...summarizeSquad(a), ...diffSquads(a, b), ...diffSquads(b, a)];
  for (const l of lines) assert.doesNotMatch(l.replace(/gpt-6\.1-sol/g, ''), codes, l);
  assert.ok(diffSquads(a, b).includes('Builders in api: 2 → 3.'));
  assert.ok(diffSquads(a, b).some((l) => l.startsWith('Investigators turned on')));
  const seat: Seat = { actor: 'demo-B3@mac', machine: 'macbook', role: 'builder', area: null, repo: 'api', agent: 'claude', model: 'opus', in_squad: true,
    want_agent: 'claude', want_model: 'sonnet', same: false, holds: 0, last_seen: '' };
  const note = seatNote(seat, a, true)!;
  assert.equal(note, 'Builder 3 on MacBook runs Claude Code, Opus; the squad says Claude Code, Sonnet. It will restart on the new setting when idle.');
  assert.doesNotMatch(note, codes);
  assert.match(seatNote(seat, a, false)!, /changes at its next start/, 'not supervised: nothing restarts it');
  assert.match(seatNote({ ...seat, actor: 'orch@pc', role: 'lead' }, a, true)!, /The lead on This PC .* next start/, 'the lead is never restarted');
  assert.match(seatNote({ ...seat, in_squad: false }, a, true)!, /no longer in this squad: it closes once it is idle/);
  assert.equal(seatNote({ ...seat, same: null }, a, true), null, 'a seat bound without a model is not judged');
  const history: SquadPage['history'] = [
    { id: 3, at: '', actor: 'ahmed', version: 3, via: 'page', squad: b },
    { id: 2, at: '', actor: 'ahmed', version: 2, via: 'cli', squad: a },
  ];
  assert.deepEqual(historyLines(history, 1), ['Saved. Earlier saves are not listed here.'], 'the oldest listed save is not called the first');
  assert.deepEqual(historyLines([{ ...history[1]!, version: 1 }], 0), ['First setup.']);
});

test('the form catches what squad_set refuses before it is sent', () => {
  assert.deepEqual(checkSquad(squad(), 'demo', opts), [], 'a valid squad passes');
  const texts = (s: Squad) => checkSquad(s, 'demo', opts).map((p) => p.text).join(' | ');
  const codexMain = squad(); codexMain.roles.qa = { ...codexMain.roles.qa!, agent: 'codex', model: 'gpt-6.1-sol' };
  assert.match(texts(codexMain), /Codex is not ready to run a seat yet/);
  const claudeName = squad(); claudeName.roles.builder!.fallback = [{ agent: 'codex', model: 'opus' }];
  assert.match(texts(claudeName), /Codex needs its own model name/);
  const mac = setCount(setCount(squad(), 'builder', 5, 'api'), 'reviewer', 3, 'api'); // 6 + 4 on the MacBook
  assert.match(texts(mac), /puts 10 seats on the MacBook; it takes 8/);
  const noReview = setCount(squad(), 'reviewer', 0, 'web');
  assert.match(texts(noReview), /Repo web has builders but no reviewers/);
  const noPath = squad(); noPath.roles.qa!.machine = 'mac'; noPath.repos!.api!.paths = { pc: 'C:/src/api' };
  assert.match(texts(noPath), /repo api has no folder on MacBook/);
  const owners = setRoleOn(squad(), 'owner', true, defaults);
  assert.match(texts(owners), /Area owners need at least one area/);
  const longName = squad(); longName.areas = [{ name: 'a-very-long-area-name-indeed', repo: 'api' }]; longName.roles.owner = { model: 'sonnet', machine: 'mac' };
  assert.match(texts(longName), /longer than herdr allows/);
  const spaced = squad(); spaced.machines.pc!.board = 'C:/my board';
  assert.match(texts(spaced), /board folder must be a full path/);
});

test('the JS patterns match squad_set\'s POSIX ones on paths, slugs and model names', () => {
  for (const p of ['/srv/board', 'C:/w/board', 'D:\\src\\api']) assert.equal(pathOk(p), true, p);
  for (const p of ['relative/path', '~/board', '/srv/my board', '/srv/a;b', '/srv/$HOME', '/srv/a|b', "/srv/it's", '/srv/(x)', '/srv/a*']) assert.equal(pathOk(p), false, p);
  assert.ok(RX.slug.test('mac-2') && !RX.slug.test('Mac') && !RX.slug.test('2mac') && !RX.slug.test('a'.repeat(33)));
  assert.ok(RX.opencode.test('anthropic/claude-opus-5-5') && !RX.opencode.test('claude-opus'));
  assert.ok(RX.codex.test('gpt-6.1-sol') && !RX.codex.test('GPT'));
  assert.ok(RX.repo.test('acme/widgets') && !RX.repo.test('acme'));
});

test('the saved document: lowering a count drops seats that no longer exist; version and changed never go back', () => {
  const s = setCount(squad(), 'builder', 1, 'api');
  assert.equal(s.roles.builder!.seats, undefined, 'seat api:2 went with the count');
  const back = toDocument({ ...squad(), version: 4, changed: true } as Squad);
  assert.ok(!('version' in back) && !('changed' in back));
  assert.deepEqual(Object.keys(back).sort(), ['areas', 'machines', 'repos', 'roles', 'supervise'], 'every other key is carried');
});
