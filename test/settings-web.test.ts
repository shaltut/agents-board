// The project settings page (#4332): its pure parts, and how they line up with db/schema.sql and the page list. No
// database: pure functions and file reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADDITION_CAP, SESSION_NAME, additionState, askFirstLabel, askFirstOf, askFirstOk, askFirstUnknown, askFirstValue, handEdited, seedChanges,
  CLAUDE_MODELS, OWNER_ONLY_MESSAGE, ROLES, ROLE_TEXT_CAP, RX, STALE_PREFIX, agentLabel, checkSquad, diffSquads, historyLines,
  modelLabel, pathOk, roleLabel, roleTextLabel, roleTextState, saveError, seatNote, setCount, setRoleOn, summarizeSquad, toDocument,
  charCount, restoredHerdr, seatName, setSupervise,
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

/** Each cb.<fn>'s parameter names per definition, from the schema text: parentheses balanced (a default like now() has
 *  its own), commas split at the top level only, nothing inside a quoted default counted. */
function schemaParams(sqlText: string): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  for (const m of sqlText.matchAll(/create (?:or replace )?function cb\.([a-z_0-9]+)\(/g)) {
    const parts: string[] = [];
    let depth = 1, quoted = false, cur = '';
    for (let i = m.index! + m[0].length; i < sqlText.length; i++) {
      const c = sqlText[i]!;
      if (c === "'") quoted = !quoted;
      else if (!quoted && c === '(') depth++;
      else if (!quoted && c === ')' && --depth === 0) break;
      if (!quoted && depth === 1 && c === ',') { parts.push(cur); cur = ''; } else cur += c;
    }
    if (cur.trim()) parts.push(cur);
    const names = parts.map((p) => p.trim().replace(/^(in|out|inout|variadic)\s+/i, '').split(/\s+/)[0]!.toLowerCase());
    out.set(m[1]!, [...(out.get(m[1]!) ?? []), names]);
  }
  return out;
}
/** Every cb function the web calls: rpc('name', ...) anywhere, and in a file that calls rpc(fn, ...) with a name it
 *  passes along, each quoted name the server allows (server/rpc.ts RPC_FUNCTIONS). */
function webCalls(): { direct: Set<string>; called: Set<string> } {
  const allowed = new Set([...readFileSync(join(root, 'server', 'rpc.ts'), 'utf8').match(/RPC_FUNCTIONS = \[([\s\S]*?)\];/)![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : /\.tsx?$/.test(f.name) && files.push(join(d, f.name)); };
  walk(join(root, 'web', 'src'));
  const direct = new Set<string>(), called = new Set<string>();
  for (const f of files) {
    const text = readFileSync(f, 'utf8').replace(/export const NO_ACTOR = new Set\(\[[^\]]*\]\)/, '');
    for (const m of text.matchAll(/\brpc(?:<[^(]*?>)?\(\s*['"]([a-z_]+)['"]/g)) { direct.add(m[1]!); called.add(m[1]!); }
    if (/\brpc(?:<[^(]*?>)?\(\s*[A-Za-z_]/.test(text)) for (const m of text.matchAll(/['"]([a-z_]+)['"]/g)) if (allowed.has(m[1]!)) called.add(m[1]!);
  }
  return { direct, called: new Set([...called].filter((f) => allowed.has(f) || direct.has(f))) };
}

test('NO_ACTOR is exactly the functions the web calls that take no actor in db/schema.sql (review M-1: derived, not a hand list)', () => {
  // the parser reads a default with its own parentheses (digest's now()) and a signature over two lines
  assert.deepEqual(schemaParams("create function cb.f(at timestamptz default now(), note text default 'a, (b)',\n  actor text default null) returns int"),
    new Map([['f', [['at', 'note', 'actor']]]]));
  const params = schemaParams(schema);
  const { direct, called } = webCalls();
  assert.ok(called.size >= 40, `found ${called.size} functions the web calls`);
  const allowed = readFileSync(join(root, 'server', 'rpc.ts'), 'utf8');
  for (const fn of direct) assert.ok(allowed.includes(`'${fn}'`), `${fn} is in RPC_FUNCTIONS (else the server answers unknown function)`);
  for (const fn of called) assert.ok(params.has(fn), `cb.${fn} is in the schema`);
  // as the server decides (server/main.ts takesActor): any definition with a parameter named actor
  const actorless = [...called].filter((fn) => !params.get(fn)!.some((names) => names.includes('actor'))).sort();
  assert.deepEqual([...NO_ACTOR].sort(), actorless, 'rpc() would add an actor where Postgres has none, or leave out one it needs');
  for (const fn of ['squad_page', 'squad_options', 'role_text_page', 'github_watches', 'project_role_page', 'digest', 'seen']) assert.ok(called.has(fn) && NO_ACTOR.has(fn), fn);
  for (const fn of ['squad_set', 'role_text_set', 'github_watch_add', 'project_pipeline', 'task_ping_bulk', 'project_role_set', 'role_text_import']) assert.ok(called.has(fn) && !NO_ACTOR.has(fn), fn);
});

// #4525: the project's addition and who its seats ask first, as the page checks them before cb.project_role_set does
test('the project addition counts what project_role_set stores, against its 1000 cap; empty removes it', () => {
  assert.equal(ADDITION_CAP, 1000);
  assert.match(schema, /if length\(ad\) > 1000 then/, 'the server cap is 1000');
  assert.deepEqual(additionState('  \n', 'old'), { count: 0, over: false, changed: true, canSave: true });
  assert.equal(additionState('x'.repeat(1000), '').canSave, true);
  assert.deepEqual(additionState('x'.repeat(1001), ''), { count: 1001, over: true, changed: true, canSave: false });
  assert.equal(additionState(' same \n', 'same').canSave, false);
});

test('who stuck seats ask first: the lead, Ahmed, or a session name the server takes; shown in plain words', () => {
  assert.ok(schema.includes(`who !~ '^[A-Za-z0-9@._-]{1,64}$'`), 'the server pattern is the page one');
  assert.equal(SESSION_NAME.source, '^[A-Za-z0-9@._-]{1,64}$');
  assert.deepEqual(askFirstOf('lead'), { kind: 'lead', name: '' });
  assert.deepEqual(askFirstOf('KB1@pc'), { kind: 'session', name: 'KB1@pc' });
  assert.equal(askFirstValue({ kind: 'session', name: ' KB1@pc ' }), 'KB1@pc');
  assert.equal(askFirstValue({ kind: 'ahmed', name: 'x' }), 'ahmed');
  assert.equal(askFirstOk({ kind: 'session', name: 'KB1@pc' }), true);
  for (const bad of ['', 'two words', 'x'.repeat(65), 'Lead']) assert.equal(askFirstOk({ kind: 'session', name: bad }), false, bad);
  assert.deepEqual(['lead', 'ahmed', 'KB1@pc'].map(askFirstLabel), ['the lead', 'Ahmed', 'KB1@pc']);
  // review M2: a name the project has not seen lately is warned about on the page, not refused
  assert.equal(askFirstUnknown({ kind: 'session', name: 'ghost@pc' }, ['KB1@pc']), true);
  assert.equal(askFirstUnknown({ kind: 'session', name: ' kb1@PC ' }, ['KB1@pc']), false);
  assert.equal(askFirstUnknown({ kind: 'lead', name: '' }, []), false);
  assert.equal(askFirstUnknown({ kind: 'session', name: 'two words' }, []), false, 'a bad name gets the refusal line, not this one');
  assert.match(readFileSync(join(root, 'web', 'src', 'components', 'settings', 'ProjectRoleText.tsx'), 'utf8'), /askFirstUnknown\(who, data\.sessions\) && \(/);
});

test('Load the new texts lists the roles whose saved text differs from the release, shared rules first, in role order', () => {
  const roles = [{ role: '_common', body: 'a' }, { role: 'lead', body: 'b' }, { role: 'builder', body: 'c' }, { role: 'qa', body: 'd' }]
    .map((r) => ({ ...r, updated_at: '', updated_by: null }))
  assert.deepEqual(seedChanges({ qa: 'D', builder: 'c', lead: 'B', _common: 'A', reviewer: 'new' }, roles), ['_common', 'lead', 'reviewer', 'qa']);
  assert.deepEqual(seedChanges({ _common: 'a', lead: 'b' }, roles), []);
  // review M1: "changed on this page since" is the server's edited flag (a hand edit after the last load), not updated_by
  const flagged = roles.map((r) => ({ ...r, updated_by: 'ahmed', edited: r.role === 'lead' }))
  assert.deepEqual(handEdited(['_common', 'lead', 'qa'], flagged), ['lead'])
  assert.deepEqual(handEdited(['_common', 'lead'], roles), [], 'seeded rows carry no flag')
  assert.match(readFileSync(join(root, 'web', 'src', 'components', 'settings', 'RoleTexts.tsx'), 'utf8'), /const edited = handEdited\(changes, roles\)/);
  const page = readFileSync(join(root, 'web', 'src', 'components', 'settings', 'RoleTexts.tsx'), 'utf8');
  assert.match(page, /rpc<\{ changed: string\[\] \}>\('role_text_import', \{ texts: seeds\.data \}\)/, 'one call: every text or none');
  assert.match(page, /get<Record<string, string>>\('\/api\/role-text-seeds'\)/);
  const settings = readFileSync(join(root, 'web', 'src', 'views', 'Settings.tsx'), 'utf8');
  assert.match(settings, /<ProjectRoleText project=\{project\} name=\{name\} \/>\s*<RoleTexts \/>/, 'the project part sits in the Role text section, first');
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

// the PR 71 review's minors
test('the Supervisor ticked on then off leaves nothing to save on a squad that has no supervise key', () => {
  const saved = squad(); delete saved.supervise;
  const back = setSupervise(setSupervise(saved, true, saved), false, saved);
  assert.equal(JSON.stringify(toDocument(back)), JSON.stringify(saved), 'the page compares the documents as text: not dirty');
  assert.equal(setSupervise(saved, true, saved).supervise, true);
  assert.equal(setSupervise(squad(), false, squad()).supervise, false, 'a saved key is kept, as false');
  const page = readFileSync(join(root, 'web', 'src', 'views', 'Settings.tsx'), 'utf8');
  assert.match(page, /edit\(\(s\) => setSupervise\(s, on, page\.squad\)\)/);
  assert.match(page, /!!squad\.supervise !== page\.supervise && ' Changed here/, 'no key and false read the same: no "changed here"');
});

test('a machine switched to This PC and back gets its herdr name back, not the MacBook', () => {
  const used = [{ key: 'far', herdr: 'box-2', board: '/b' }, { key: 'pc', herdr: null, board: 'C:/b' }];
  assert.equal(restoredHerdr('mac', { mac: 'box-7' }, used), 'box-7', 'the name it had before the switch');
  assert.equal(restoredHerdr('far', {}, used), 'box-2', 'else the name another squad gives that key');
  assert.equal(restoredHerdr('pc', {}, used), 'macbook', 'else the MacBook, as before');
  assert.match(readFileSync(join(root, 'web', 'src', 'components', 'settings', 'Machines.tsx'), 'utf8'), /restoredHerdr\(k, herdrBefore, options\.machines_used\)/);
});

test('a live seat whose machine key is not in the squad: the squad machine by its herdr name, never the raw name', () => {
  const seat: Seat = { actor: 'demo-B1@gone', machine: 'macbook', role: 'builder', area: null, repo: 'api', agent: 'claude', model: 'sonnet', in_squad: true,
    want_agent: 'claude', want_model: 'sonnet', same: true, holds: 0, last_seen: '' };
  assert.equal(seatName(seat, squad()), 'Builder 1 on MacBook');
  const other = squad(); other.machines.far = { herdr: 'box-2', board: '/b' };
  assert.equal(seatName({ ...seat, machine: 'box-2' }, other), 'Builder 1 on box-2', 'a squad machine with that herdr name');
  assert.equal(seatName({ ...seat, machine: 'host-123' }, squad()), 'Builder 1 on another machine');
  assert.equal(seatName({ ...seat, machine: null }, squad()), 'Builder 1 on another machine');
});

test('Last edits count characters as the counter does (code points, not UTF-16 units)', () => {
  assert.equal(charCount('😀😀a'), 3);
  const page = readFileSync(join(root, 'web', 'src', 'components', 'settings', 'RoleTexts.tsx'), 'utf8');
  assert.match(page, /charCount\(e\.before \?\? ''\)\.toLocaleString\(\)\} → \{charCount\(e\.after\)/);
  assert.doesNotMatch(page, /e\.after\.length/);
});

test('the watch help says what re-adding a watched repo does: later pull requests only (github_watch_add patches project)', () => {
  const page = readFileSync(join(root, 'web', 'src', 'components', 'settings', 'GitHub.tsx'), 'utf8');
  assert.doesNotMatch(page, /moves its cards/);
  assert.match(page, /its next pull requests come to this project, and the cards it already made stay where they are/);
});

test('the design\'s ways in: a gear beside the project switcher and the Board\'s pipeline line, both to Project settings, owner only', () => {
  const sw = readFileSync(join(root, 'web', 'src', 'components', 'ProjectSwitcher.tsx'), 'utf8');
  assert.match(sw, /href\(\{ view: 'settings', project \}\)/);
  assert.match(sw, /\{settings && \(/, 'the gear only for a viewer who gets the page');
  assert.match(readFileSync(join(root, 'web', 'src', 'components', 'TopBar.tsx'), 'utf8'), /<ProjectSwitcher project=\{route\.project\} settings=\{pages\.some\(\(p\) => p\.view === 'settings'\)\} \/>/);
  const board = readFileSync(join(root, 'web', 'src', 'views', 'Board.tsx'), 'utf8');
  assert.match(board, /if \(!isOwner\(who\)\) return null/);
  assert.match(board, /Squad pipeline: \{on \? 'on' : 'off'\}/);
  assert.match(board, /href=\{href\(\{ view: 'settings', project \}\)\}/);
  assert.doesNotMatch(board, /type="checkbox"/, 'a link, not the old switch');
  assert.match(schema, /perform cb\.dashboard_only\('Project settings'\);\s+a := cb\.set_actor\(coalesce\(actor, 'ahmed'\)\);\s+update cb\.projects pr set pipeline/,
    'project_pipeline\'s refusal names the page the switch is on');
});

test('the saved document: lowering a count drops seats that no longer exist; version and changed never go back', () => {
  const s = setCount(squad(), 'builder', 1, 'api');
  assert.equal(s.roles.builder!.seats, undefined, 'seat api:2 went with the count');
  const back = toDocument({ ...squad(), version: 4, changed: true } as Squad);
  assert.ok(!('version' in back) && !('changed' in back));
  assert.deepEqual(Object.keys(back).sort(), ['areas', 'machines', 'repos', 'roles', 'supervise'], 'every other key is carried');
});
