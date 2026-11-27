// #3771: the dashboard finds a project's lead by role (cb._is_lead, #3746), never by the orch@ name: sessions_overview
// says which row leads its project, and the ask box and the new-huddle dialog preselect that session.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts';
import { callFn } from '../server/rpc.ts';
import { defaultRecipient } from '../web/src/lib/asks.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

test('sessions_overview: lead is true for the lead-role session whatever its name, false for an orch@ name in another role', async () => {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('zed'), cb.ensure_project('q')`;
  await sql`select cb.iam('pc', 'p1', 'QO@pc', 'zed', 'lead')`;
  await sql`select cb.iam('pc', 'p2', 'orch@pc', 'zed', 'builder')`;
  await sql`select cb.iam('pc', 'p3', 'W1@pc', 'zed', 'builder')`;
  await sql`select cb.iam('pc', 'p4', 'orch@mac', 'q')`; // no role: the old orch@ default still leads its project
  const rows = await callFn('sessions_overview', { project: null }, sql) as any[];
  const lead = Object.fromEntries(rows.map((r) => [r.actor, r.lead]));
  assert.deepEqual(lead, { 'QO@pc': true, 'orch@pc': false, 'W1@pc': false, 'orch@mac': true });
});

const row = (actor: string, project: string | null, live: boolean, lead: boolean) => ({ actor, project, live, lead });

test('defaultRecipient: the project\'s lead by role, a live one first; none: nobody', () => {
  const s = [row('orch@pc', 'zed', true, false), row('QO@old', 'zed', false, true), row('QO@pc', 'zed', true, true), row('L@pc', 'q', true, true)];
  assert.equal(defaultRecipient(s, 'zed'), 'QO@pc');
  assert.equal(defaultRecipient(s.slice(0, 2), 'zed'), 'QO@old', 'a quiet lead beats a live orch@ name in another role');
  assert.equal(defaultRecipient([row('orch@pc', 'zed', true, false)], 'zed'), '', 'no lead: Ahmed picks');
  assert.equal(defaultRecipient(s, undefined), '');
});
