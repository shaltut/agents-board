import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { ensurePg } from '../db/pg.ts';

// the private cluster is Windows-only (initdb.exe, pg_ctl.exe; db/pg.ts): elsewhere Postgres is started by hand (#4401)
test('ensurePg creates the cluster when .pgdata is missing', { timeout: 120_000, skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cb-pg-')), '.pgdata');
  const pgCtl = join(process.env.CB_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin', 'pg_ctl.exe');
  try {
    ensurePg(dir, 5439);
    const sql = postgres('postgres://cb@127.0.0.1:5439/postgres', { onnotice: () => {} });
    const [r] = await sql`select current_user as u`;
    await sql.end();
    assert.equal(r.u, 'cb');
  } finally {
    spawnSync(pgCtl, ['-D', dir, 'stop', '-m', 'immediate', '-w'], { stdio: 'ignore' });
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

// #4401: with no Postgres where CB_PG_BIN says, the error said "undefined" (spawnSync failed to start, so no output)
test('ensurePg says why it could not create the cluster and what to set', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cb-pg-')), '.pgdata');
  const r = spawnSync(process.execPath, ['-e', `import('./db/pg.ts').then((m) => m.ensurePg(${JSON.stringify(dir)}, 5441)).catch((e) => { console.log(e.message); })`],
    { encoding: 'utf8', env: { ...process.env, CB_PG_BIN: join(dir, '..', 'no-such-bin') } });
  rmSync(join(dir, '..'), { recursive: true, force: true });
  assert.match(r.stdout, /could not create Postgres cluster in .*: .*ENOENT.*CB_PG_BIN/s);
  assert.doesNotMatch(r.stdout, /undefined/);
});
