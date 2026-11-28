// #4918 review: the runner on the worker API when /w/v1/events never opens (a proxy that fails or buffers it) while
// every call works. Apart from test/runner.test.ts: it starts one runner and ends it by the child's own handle.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freshDb } from './helpers.ts';
import { apiBoardFor } from './api-board.ts';

const NAME = 'pc-nostream';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });

const tmp = mkdtempSync(join(tmpdir(), 'cb-runner-stream-'));
const sql = await freshDb();
await sql`select cb.ensure_project('demo')`;
const worker = await apiBoardFor();
let runner: ChildProcess | undefined, gone: Promise<unknown> | undefined, out = '';
after(async () => {
  runner?.kill();
  await gone;
  await worker.close();
  await sql.end();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

async function until<T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms: number): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v;
    assert.ok(Date.now() - t < ms && runner!.exitCode === null, `timed out waiting for ${what}; runner said:\n${out}`);
    await sleep(200);
  }
}

test('a notice stream that never opens: the runner says so, beats and runs the queue all the same', { timeout: 150_000 }, async () => {
  const [row] = await sql`select cb.key_issue('box-a', 'runner', ${NAME}) as key`;
  const config = join(tmp, 'runner.json');
  // an origin that is not there: a claimed job ends at its fetch, with nothing left running
  writeFileSync(config, JSON.stringify({
    name: NAME, slots: 1, log: { host: '127.0.0.1', port: await freePort(), peers: [] },
    projects: { demo: { git: join(tmp, 'missing.git'), base: join(tmp, 'r'), lockfile: 'lock.txt', install: ['node', '-v'], installTimeout: 60, recipes: { ok: { steps: [['node', '-v']], timeout: 60 } } } },
  }));
  worker.failStreams();
  // by its full path: the update tests of another run read this machine's process list
  runner = spawn(process.execPath, [resolve(import.meta.dirname, '..', 'cli', 'runner.ts')], {
    env: { ...process.env, CB_RUNNER_CONFIG: config, CB_RUNNER_HOME: join(tmp, 'home'), ...worker.env(row!.key, join(tmp, 'keys')) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  gone = new Promise((ok) => runner!.once('exit', ok));
  runner.stdout!.on('data', (b) => { out += b; });
  runner.stderr!.on('data', (b) => { out += b; });

  await until('its hello', async () => (await sql`select 1 from cb.runners where name = ${NAME}`).length || undefined, 30_000);
  const [{ r }] = await sql`select cb.job_add('demo', 'ok', 'abcdef1234', ${sql.json({})}, null, 'ahmed') as r`;
  await until('it to say the stream is not open', () => (/notice stream has not opened.*\/w\/v1\/events/.test(out) ? true : undefined), 25_000);
  const job = await until('the job to be claimed and ended', async () => {
    const [{ j }] = await sql`select cb.job_get(${r.id}) as j`;
    return ['queued', 'running'].includes(j.state) ? undefined : j;
  }, 60_000);
  assert.deepEqual([job.runner, job.state], [NAME, 'error']);
  await until('a beat', async () => (await sql`select 1 from cb.runners where name = ${NAME} and last_seen > started_at`).length || undefined, 40_000);

  worker.restoreStreams();
  await until('the stream to open once it works', () => (worker.liveStreams() === 1 ? true : undefined), 40_000);
});
