import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { splitRunArgs } from '../cli/jobs.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

const RECIPES = [
  { project: 'demo', recipe: 'test', params: { files: { min: 1, max: 20 } }, db: false },
  { project: 'demo', recipe: 'check', params: { ws: { min: 1, max: 6 } }, db: false },
];
const runnerConn = () => { const c = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: 'cb-runner/test' } }); clients.push(c); return c; };

async function setup(logUrl = 'http://127.0.0.1:1/') {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('mac','p2','B1@mac','demo','builder')`;
  const runner = runnerConn();
  await runner`select cb.runner_hello('pc', ${logUrl}, ${runner.json(RECIPES as any)})`;
  return { sql, runner };
}
// async twin: an in-process HTTP server (the stand-in runner) must keep serving while cb runs
const cba = (args: string[], extra: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; err: string }>((ok) => {
  const c = spawn('node', ['cli/cb.ts', ...args], { env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'B1@mac', HERDR_PANE_ID: '', CB_MACHINE: 'mac', CLAUDE_CODE_MESSAGING_SOCKET: '', CB_LOG_URL_ALLOW_LOOPBACK: '1', ...extra } });
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => ok({ code, out: out.trim(), err: err.trim() }));
});
const cb = (args: string[], extra: Record<string, string> = {}) => {
  const r = spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'B1@mac', HERDR_PANE_ID: '', CB_MACHINE: 'mac', CLAUDE_CODE_MESSAGING_SOCKET: '', CB_LOG_URL_ALLOW_LOOPBACK: '1', ...extra } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

test('splitRunArgs: unknown --flags are parameters, their values run to the next --flag', () => {
  const r = splitRunArgs(['test', '--sha', 'abc1234', '--files', 'a', 'b', '--wait', '--app', 'claims-api'], new Set(['sha', 'wait']));
  assert.deepEqual(r.rest, ['test', '--sha', 'abc1234', '--wait']);
  assert.deepEqual(r.params, { files: ['a', 'b'], app: ['claims-api'] });
  assert.deepEqual(splitRunArgs(['t', '--files', '-r', '--ws=x'], new Set()).params, { files: ['-r'], ws: ['x'] });
});

test('cb run queues and prints the job', async () => {
  await setup();
  const r = cb(['run', 'test', '--sha', 'abc1234', '--files', 'tests/a.test.ts', '--project', 'demo']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'job #1 queued (0 ahead)');
});

test('cb run refuses flag- and path-shaped values by name', async () => {
  await setup();
  for (const bad of ['-r', '../x']) {
    const r = cb(['run', 'test', '--sha', 'abc1234', '--project', 'demo', '--files', bad]);
    assert.equal(r.code, 1);
    assert.match(r.err, /files/);
  }
});

test('cb run lists the recipes when the recipe is unknown or missing', async () => {
  await setup();
  const r = cb(['run', 'ghost', '--sha', 'abc1234', '--project', 'demo']);
  assert.equal(r.code, 1);
  assert.match(r.err, /test \(files\)/);
  assert.match(cb(['run', '--sha', 'abc1234', '--project', 'demo']).err, /check \(ws\)/);
});

test('cb run --wait prints the result and exits by it', async () => {
  const { runner } = await setup();
  // async spawn: spawnSync would block the timer that plays the runner
  const child = spawn('node', ['cli/cb.ts', 'run', 'test', '--sha', 'abc1234', '--files', 'a.test.ts', '--project', 'demo', '--wait'],
    { env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'B1@mac', HERDR_PANE_ID: '', CB_MACHINE: 'mac', CLAUDE_CODE_MESSAGING_SOCKET: '' } });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const code = new Promise<number | null>((ok) => child.on('close', ok));
  for (let i = 0; i < 50 && !(await clients[0]`select 1 from cb.jobs`).length; i++) await new Promise((r) => setTimeout(r, 100));
  await runner`select cb.job_claim('pc', false)`;
  await runner`select cb.job_finish(1, 'pc', 'passed', 0, '3 passed')`;
  assert.equal(await code, 0, err);
  assert.match(out, /queued/);
  assert.match(out, /passed \(exit 0\)\. 3 passed/);
});

test('cb run --wait exits 1 when the job did not pass, and queued line is skipped under --json', async () => {
  const { runner } = await setup();
  const done = cba(['run', 'test', '--sha', 'abc1234', '--files', 'a.test.ts', '--project', 'demo', '--wait', '--json']);
  for (let i = 0; i < 50 && !(await clients[0]`select 1 from cb.jobs`).length; i++) await new Promise((r) => setTimeout(r, 100));
  await runner`select cb.job_claim('pc', false)`;
  await runner`select cb.job_finish(1, 'pc', 'failed', 1, '1 failed')`;
  const r = await done;
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).state, 'failed');
  assert.match(cb(['run', 'test', '--sha', 'abc1234', '--files', 'a.test.ts', '--project', 'demo', '--card', 'x']).err, /--card needs a card number/);
});

test('cb job log fetches only plain http://<tailscale ip>/ addresses', async () => {
  const { sql, runner } = await setup();
  cb(['run', 'test', '--sha', 'abc1234', '--files', 'a.test.ts', '--project', 'demo']);
  await runner`select cb.job_claim('pc', false)`;
  for (const bad of ['http://127.0.0.1:1/', 'http://100.64.0.1:1/?x', 'https://100.64.0.1/', 'http://user:pw@100.64.0.1/', 'data:,x', 'http://100.64.0.1:1/a/', 'http://8.8.8.8/']) {
    await sql`update cb.runners set log_url = ${bad}`;
    const r = await cba(['job', 'log', '1'], { CB_LOG_URL_ALLOW_LOOPBACK: '' });
    assert.match(r.err, /not a Tailscale address: not fetching/, bad);
  }
});

test('cb job log cuts a huge log to the last 1 MB, and does not follow redirects', async () => {
  let mode = 'big';
  const srv = createServer((req, res) => {
    if (mode === 'redirect') { res.statusCode = 302; res.setHeader('location', '/elsewhere'); return res.end(); }
    res.end('x'.repeat(2 * 1024 * 1024) + '\nend\n');
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const { runner } = await setup(`http://127.0.0.1:${(srv.address() as any).port}/`);
  try {
    cb(['run', 'test', '--sha', 'abc1234', '--files', 'a.test.ts', '--project', 'demo']);
    await runner`select cb.job_claim('pc', false)`;
    const r = await cba(['job', 'log', '1']);
    assert.match(r.out, /^… \(log cut: showing the last 1 MB; use --tail\)\n/);
    assert.ok(r.out.length < 1024 * 1024 + 200);
    assert.ok(r.out.endsWith('end'));
    mode = 'redirect';
    assert.match((await cba(['job', 'log', '1'])).err, /not answering/);
  } finally { srv.close(); }
});

test('cb job cancel and cb jobs', async () => {
  await setup();
  cb(['run', 'test', '--sha', 'abc1234', '--files', 'a.test.ts', '--project', 'demo']);
  const l = cb(['jobs', 'demo']);
  assert.match(l.out, /#1 /);
  assert.match(l.out, /recipes: check \(ws\), test \(files\)/);
  const c = cb(['job', 'cancel', '1']);
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /cancelled/);
  assert.match(cb(['job', 'show', '1']).out, /cancelled/);
});

test('cb job log reads from the runner, 403 and a dead runner say why', async () => {
  let status = 200; let seen = '';
  const srv = createServer((req, res) => { seen = req.url ?? ''; res.statusCode = status; res.end(status === 200 ? 'line one\nline two\n' : 'no'); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const { runner } = await setup(`http://127.0.0.1:${(srv.address() as any).port}/`);
  try {
    cb(['run', 'test', '--sha', 'abc1234', '--files', 'a.test.ts', '--project', 'demo']);
    assert.match(cb(['job', 'log', '1']).err, /not started/);
    await runner`select cb.job_claim('pc', false)`;
    const r = await cba(['job', 'log', '1', '--tail', '50']);
    assert.equal(r.out, 'line one\nline two');
    assert.equal(seen, '/jobs/1/log?tail=50');
    status = 403;
    assert.match((await cba(['job', 'log', '1'])).err, /may not read job logs/);
  } finally { srv.close(); }
  await runner`select cb.runner_hello('pc', 'http://127.0.0.1:1/', ${runner.json(RECIPES as any)})`;
  assert.match(cb(['job', 'log', '1']).err, /runner on pc is not answering/);
});
