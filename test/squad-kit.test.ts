import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';
import { loadRoleTexts } from '../db/roles.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('role texts load from prompts/roles and survive freshDb', async () => {
  const sql = await db();
  const [{ n }] = await sql`select count(*)::int as n from cb.role_texts`;
  assert.equal(n, 8);
  const common = readFileSync('prompts/roles/_common.md', 'utf8').trim();
  const [{ t }] = await sql`select cb.role_text('builder') as t`;
  assert.equal(t, common + '\n\n' + readFileSync('prompts/roles/builder.md', 'utf8').trim());
});

test('loadRoleTexts updates and deletes', async () => {
  const sql = await db();
  const dir = mkdtempSync(join(tmpdir(), 'roles-'));
  try {
    writeFileSync(join(dir, '_common.md'), 'common\n');
    writeFileSync(join(dir, 'builder.md'), 'one\n');
    await loadRoleTexts(sql, dir);
    assert.equal((await sql`select cb.role_text('builder') as t`)[0].t, 'common\n\none');
    writeFileSync(join(dir, 'builder.md'), 'two\n');
    await loadRoleTexts(sql, dir);
    assert.equal((await sql`select cb.role_text('builder') as t`)[0].t, 'common\n\ntwo');
    unlinkSync(join(dir, 'builder.md'));
    await loadRoleTexts(sql, dir);
    assert.equal((await sql`select count(*)::int as n from cb.role_texts where role = 'builder'`)[0].n, 0);
    assert.equal((await sql`select count(*)::int as n from cb.role_texts`)[0].n, 1);
  } finally {
    rmSync(dir, { recursive: true });
    await loadRoleTexts(sql, 'prompts/roles'); // put the real texts back for later tests
  }
});

test('cb.role_text refuses an unknown role', async () => {
  const sql = await db();
  await assert.rejects(sql`select cb.role_text('ghost')`, /unknown role ghost: one of lead, architect, owner, builder, reviewer, qa, investigator/);
});

test('every command a role file names exists', async () => {
  const help = readFileSync('cli/help.ts', 'utf8');
  const known = new Set([...help.matchAll(/^    ([a-z-]+): \{/gm)].map((m) => m[1]));
  for (const f of readdirSync('prompts/roles')) {
    const text = readFileSync(join('prompts/roles', f), 'utf8');
    assert.ok(text.split('\n').length <= 60, `${f} is over 60 lines`);
    for (const m of text.matchAll(/\bcb ([a-z]+)(?: ([a-z]+))?/g)) {
      assert.ok(known.has(m[1]), `${f}: cb ${m[1]} is not a command`);
      // commands whose help lists subcommands: the second word must be one of them
      const subs = ({ page: ['show', 'set'], huddle: ['open', 'say', 'add', 'show', 'close'], lock: ['take', 'release', 'queue'] } as Record<string, string[]>)[m[1]];
      if (subs && m[2]) assert.ok(subs.includes(m[2]), `${f}: cb ${m[1]} ${m[2]} is not a subcommand`);
    }
  }
});

test('cb role prints the text; cb iam ends with the role line', async () => {
  const sql = await db();
  const r = cb(['role', 'reviewer']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, (await sql`select cb.role_text('reviewer') as t`)[0].t);
  const j = cb(['role', 'reviewer', '--json']);
  const p = JSON.parse(j.out);
  assert.equal(p.role, 'reviewer');
  assert.equal(p.text, r.out);
  await sql`select cb.ensure_project('demo')`;
  const i = cb(['iam', 'R9@mac', 'demo', '--role', 'reviewer'], { HERDR_PANE_ID: 'p9' });
  assert.equal(i.code, 0, i.err);
  assert.equal(i.out.split('\n').at(-1), 'Your role: cb role reviewer');
});

test('cb resume ends with the role line in a pipeline project', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`update cb.projects set pipeline = true where name = 'demo'`;
  await sql`select cb.iam('mac', 'p8', 'B8@mac', 'demo', 'builder')`;
  const r = cb(['resume'], { CB_ACTOR: 'B8@mac' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n').at(-1), 'Your role: cb role builder');
});
