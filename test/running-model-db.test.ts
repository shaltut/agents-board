// #4786: the board keeps the model a seat really runs beside the one it was started with.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts';

let sql: any;
after(() => sql?.end());

const M = 'pc', PANE = 'w9:p786', WHO = 'zed-R1@pc';
const iam = (model: string | null, agent: string) => sql`select cb.iam(${M}, ${PANE}, ${WHO}, 'zed', 'reviewer', null, ${model}, null, ${agent})`;
const beat = (sid: string | null) => sql`select cb.inbox(${M}, ${PANE}, 0, ${sid})`;
const seen = (model: string) => sql`select cb.seat_model(${M}, ${PANE}, ${model})`;
const usage = (sid: string, model: string, n: number) => sql`select cb.usage_report(${M}, ${PANE}, ${sid}, ${model}, ${n}::bigint, 1::bigint, 0::bigint, 0::bigint, null::numeric)`;
const row = async () => (await sql`select cb.sessions_overview('zed') as r`)[0].r.find((x: any) => x.actor === WHO);
const shown = async () => { const r = await row(); return [r.model, r.running_model, r.model_differs]; };
async function setup() {
  await sql?.end();
  sql = await freshDb();
  await sql`select cb.add_project('zed', 'Zed', 'zed-orch@pc')`;
}

test('a screen reading is kept beside the launch model and flagged only when it differs', async () => {
  await setup();
  await iam('claude-opus-5-5-high', 'agy');
  assert.deepEqual(await shown(), ['claude-opus-5-5-high', null, false]);
  await seen('claude-opus-5-5-high');
  assert.deepEqual(await shown(), ['claude-opus-5-5-high', 'claude-opus-5-5-high', false]);
  await seen('gemini-4-neon-high');
  assert.deepEqual(await shown(), ['claude-opus-5-5-high', 'gemini-4-neon-high', true]);
  const page = (await sql`select cb.squad_page('zed') as r`)[0].r.seats.find((s: any) => s.actor === WHO);
  assert.deepEqual([page.model, page.running_model, page.model_differs], ['claude-opus-5-5-high', 'gemini-4-neon-high', true]);
  // text that is no model id is not stored, and an unknown pane is nothing
  for (const bad of ['two words', 'x'.repeat(101), "a';drop", '']) await seen(bad);
  assert.equal((await row()).running_model, 'gemini-4-neon-high');
  await sql`select cb.seat_model(${M}, 'w9:none', 'gemini-4-neon-high')`;
  // a seat started without the effort in the id runs the same model with one
  await iam('claude-opus-5-5', 'agy');
  await seen('claude-opus-5-5-high');
  assert.equal((await row()).model_differs, false);
});

test('binding again, or another session taking the pane, drops what the last one ran', async () => {
  await setup();
  await iam('claude-opus-5-5-high', 'agy');
  await beat('sid-one');
  await seen('gemini-4-neon-high');
  await iam('claude-opus-5-5-high', 'agy');
  assert.equal((await row()).running_model, null);
  await beat('sid-one');
  await seen('gemini-4-neon-high');
  await beat('sid-two');
  assert.equal((await sql`select s.running_model from cb.sessions s where s.pane = ${PANE}`)[0].running_model, null);
});

test("a Claude seat's running model is the one its usage hook reports for its own session", async () => {
  await setup();
  await iam('sonnet', 'claude');
  await beat('sid-claude');
  await usage('sid-other', 'claude-opus-5-5', 5);
  assert.deepEqual(await shown(), ['sonnet', null, false]);
  await usage('sid-claude', 'claude-sonnet-5-5-20260101', 5);
  assert.deepEqual(await shown(), ['sonnet', 'claude-sonnet-5-5-20260101', false]);
  await usage('sid-claude', 'claude-opus-5-5', 9);
  assert.deepEqual(await shown(), ['sonnet', 'claude-opus-5-5', true]);
  // a context-size mark is not another model, and an unknown model is not a reading
  await iam('claude-opus-5-5[1m]', 'claude');
  await beat('sid-claude');
  assert.equal((await row()).model_differs, false);
  await usage('sid-claude', 'not a model id', 12);
  assert.deepEqual(await shown(), ['claude-opus-5-5[1m]', null, false]);
  // started with no model named: what runs is shown, and nothing is flagged
  await sql`update cb.sessions set model = null where pane = ${PANE}`;
  await usage('sid-claude', 'claude-opus-5-5', 15);
  assert.deepEqual(await shown(), [null, 'claude-opus-5-5', false]);
});
