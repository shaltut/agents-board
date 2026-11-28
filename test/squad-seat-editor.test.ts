// #4763 slice 3: the settings page sets one seat differently from its role. These pin the squad document each edit
// makes, and that cb.squad_set takes it as made.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts';
import { checkSquad, diffSquads, patchSeat, seatBlank, type Squad } from '../web/src/lib/squad.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

const defaults = { lead: 'opus', builder: 'sonnet' };
// a made-up one-machine squad (the repo is public: no real names or paths)
const squad = (): Squad => ({
  machines: { pc: { herdr: null, repo: 'C:/src/demo', board: 'C:/board' } },
  roles: { lead: { count: 1, model: 'opus', machine: 'pc' }, builder: { count: 3, model: 'sonnet', effort: 'high', machine: 'pc' } },
  areas: [],
});
const seats = (sq: Squad) => sq.roles.builder!.seats;
const edit = (sq: Squad, key: string, patch: Parameters<typeof patchSeat>[3]) => patchSeat(sq, 'builder', key, patch, defaults);

test('a seat keeps only what differs from its role, and the draft it came from is untouched', () => {
  const sq = squad();
  const one = edit(sq, '2', { model: 'opus' });
  assert.deepEqual(seats(one), { '2': { model: 'opus' } });
  assert.equal(seats(sq), undefined);
  assert.deepEqual(seats(edit(one, '2', { effort: 'low' })), { '2': { model: 'opus', effort: 'low' } });
  // back to the role's: the key goes, then the empty seat and the empty map
  assert.deepEqual(seats(edit(edit(one, '2', { effort: 'low' }), '2', { model: '' })), { '2': { effort: 'low' } });
  const gone = edit(one, '2', { model: '' });
  assert.ok(!('seats' in gone.roles.builder!), 'nothing of its own left: squad_set refuses an empty seat');
  assert.ok(!('seats' in edit(edit(sq, '1', { effort: 'max' }), '1', { effort: undefined }).roles.builder!));
});

test('a seat on another agent names its own model; going back to the role\'s agent drops the agent, model and effort', () => {
  const codex = edit(edit(squad(), '3', { effort: 'max' }), '3', { agent: 'codex' });
  assert.deepEqual(seats(codex), { '3': { agent: 'codex', model: '' } }, 'the role\'s model and effort belong to the role\'s agent');
  assert.match(checkSquad(codex, 'demo', { agents: [{ agent: 'claude', main: true }, { agent: 'codex', main: true }] }).map((p) => p.text).join('\n'), /Codex needs its own model name/);
  // clearing the model of a seat on another agent leaves it empty (and flagged), never the role's
  const named = edit(edit(codex, '3', { model: 'gpt-6.1-sol' }), '3', { effort: 'ultra' });
  assert.deepEqual(seats(named), { '3': { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' } });
  assert.deepEqual(seats(edit(named, '3', { model: '' })), { '3': { agent: 'codex', model: '', effort: 'ultra' } });
  assert.ok(!('seats' in edit(named, '3', { agent: 'claude' }).roles.builder!));
});

test('a Claude seat in a role on another agent starts on a Claude name', () => {
  const sq = squad();
  sq.roles.builder = { count: 2, agent: 'codex', model: 'gpt-6.1-sol', machine: 'pc' };
  assert.deepEqual(seats(edit(sq, '1', { agent: 'claude' })), { '1': { agent: 'claude', model: 'sonnet' } });
});

test('a seat\'s own backups stay through its other edits', () => {
  const sq = squad(), fallback = [{ agent: 'codex', model: 'gpt-6.1-sol' }];
  sq.roles.builder!.seats = { '1': { model: 'opus', fallback } };
  assert.deepEqual(seats(edit(sq, '1', { model: '' })), { '1': { fallback } });
  assert.deepEqual(seats(edit(sq, '1', { agent: 'agy' })), { '1': { agent: 'agy', model: '', fallback } });
});

test('the first choice in a seat\'s lists says what it takes from the role', () => {
  const role = squad().roles.builder!;
  assert.deepEqual(seatBlank(role, {}), { model: 'Same as the role: Sonnet', effort: 'Same as the role: high effort' });
  assert.deepEqual(seatBlank({ ...role, effort: undefined }, { effort: 'low' }), { model: 'Same as the role: Sonnet', effort: 'Default effort' });
  // another agent takes nothing from the role: the page asks for a model and offers that agent's default effort
  assert.deepEqual(seatBlank(role, { agent: 'codex' }), { model: undefined, effort: 'Default effort' });
});

test('every document the seat editor makes saves as made', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  let sq = squad();
  for (const [key, patch] of [['1', { effort: 'low' }], ['2', { model: 'opus' }], ['3', { agent: 'codex' }], ['3', { model: 'gpt-6.1-sol' }],
    ['3', { effort: 'ultra' }], ['1', { effort: undefined }], ['2', { agent: 'agy' }], ['2', { model: 'gemini-4-neon' }], ['2', { agent: 'claude' }]] as const) {
    const next = edit(sq, key, patch);
    const waiting = Object.values(seats(next) ?? {}).some((s) => s.model === ''); // not saveable yet: the page holds it
    if (!waiting) {
      const [{ s }] = await sql`select cb.squad_set('demo', ${sql.json(next as any)}, 'ahmed') as s`;
      assert.deepEqual(s, next, `${key} ${JSON.stringify(patch)}`);
    }
    sq = next;
  }
  assert.deepEqual(seats(sq), { '3': { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' } });
  assert.match(diffSquads(squad(), sq).join('\n'), /single-seat settings changed/);
});
