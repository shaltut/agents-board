// #4817: OpenCode 1.x loads every file in its plugins folder, so the 2.x plugin sits there too. This starts a real 1.x
// server with both installed and checks that its guard still stops a call. No database. Everything is in a temp folder:
// home, XDG and app-data folders, so no real config or sign-in is read, and the model is a stand-in on 127.0.0.1.
// Skipped where no OpenCode 1.x is on PATH (a skip is not a pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGuard, wireAgents } from '../kit/guard/install.mjs';

const SRC = fileURLToPath(new URL('../kit/guard/', import.meta.url));
const found = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
const version = /(?:^|\s|v)(\d+\.\d+\.\d+)/.exec(String(found.stdout ?? ''))?.[1] ?? null;
const skip = version?.startsWith('1.') ? false : `no OpenCode 1.x on PATH (${version ?? 'not found'})`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// asks for the given harmless shell commands, one after the other, then says done
function standIn(commands: string[], results: string[]) {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let j: any = {};
      try { j = JSON.parse(body); } catch {}
      const got = (j.messages ?? []).filter((m: any) => m.role === 'tool');
      if (got.length > results.length) results.splice(0, results.length, ...got.map((m: any) => JSON.stringify(m.content)));
      const asks = (j.tools ?? []).some((x: any) => x.function?.name === 'bash') && got.length < commands.length;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk(asks ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${got.length}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: commands[got.length], description: 'step' }) } }] } : { role: 'assistant', content: 'done' });
      chunk({}, asks ? 'tool_calls' : 'stop');
      res.end('data: [DONE]\n\n');
    });
  });
}

// A real 1.x server with this checkout's guard installed, a synthetic password and the stand-in model, which asks for
// the given commands. files are written into the work folder first. Returns when the model has every result
async function session(t: { after: (f: () => Promise<void>) => void }, commands: string[], files: (password: string) => Record<string, string> = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), 'cb-oc1-'));
  const dir = (...p: string[]) => { const d = join(root, ...p); mkdirSync(d, { recursive: true }); return d; };
  const home = dir('home'), work = dir('work'), config = dir('config'), target = join(root, 'guard');
  dir('work', '.claude');
  const results: string[] = [], model = standIn(commands, results);
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));

  const password = randomBytes(18).toString('hex');
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: dir('appdata'), LOCALAPPDATA: dir('localappdata'),
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: dir('data'), XDG_STATE_HOME: dir('state'), XDG_CACHE_HOME: dir('cache') };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|CLAUDE|OPENCODE|CB_)/i.test(k)) delete env[k];
  Object.assign(env, { OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_SERVER_PASSWORD: password, CB_ROLE: 'builder', CB_AGENT: 'opencode' });

  assert.ok(installGuard(SRC, target, { agents: ['opencode'] }).ok);
  assert.ok(wireAgents(target, { agents: ['opencode'], env: env as NodeJS.ProcessEnv, home }).ok);
  assert.deepEqual(readdirSync(join(config, 'opencode', 'plugins')).sort(), ['cb-guard-v2.js', 'cb-guard.js']);
  writeFileSync(join(config, 'opencode', 'opencode.json'), JSON.stringify({ provider: { stub: { name: 'Stub', npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, apiKey: 'none' }, models: { m: { name: 'm', tool_call: true } } } } }));

  for (const [name, text] of Object.entries(files(password))) writeFileSync(join(work, name), text);

  const port = 45_000 + Math.floor(Math.random() * 2000);
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: work, env: env as NodeJS.ProcessEnv, windowsHide: true, detached: process.platform !== 'win32' });
  let log = '';
  for (const s of [child.stdout, child.stderr]) s?.on('data', (d) => { log += d; });
  t.after(async () => {
    // only the server this test started, by its own process id
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    model.close();
    await sleep(2000);
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' };
  const q = `?directory=${encodeURIComponent(work)}`;
  const api = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(150_000) });
  const tail = () => log.replaceAll(password, '<password>').slice(-1500);

  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(1000); up = await api('/global/health').then((r) => r.ok, () => false); }
  assert.ok(up, `no answer from opencode ${version}: ${tail()}`);
  const made = await api(`/session${q}`, {});
  assert.equal(made.status, 200, tail());
  const { id } = await made.json() as { id: string };
  const sent = await api(`/session/${id}/message${q}`, { model: { providerID: 'stub', modelID: 'm' }, parts: [{ type: 'text', text: 'run the two commands' }] });
  assert.equal(sent.status, 200, `${await sent.text()} ${tail()}`);
  for (let i = 0; i < 60 && results.length < commands.length; i++) await sleep(1000);

  assert.equal(results.length, commands.length, `the model got ${results.length} tool results: ${tail()}`);
  // the status of a request that carries no password
  const bare = () => fetch(`http://127.0.0.1:${port}/session${q}`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.status);
  return { work, results, bare };
}

test('#4817: with both plugins installed, OpenCode 1.x still stops a blocked call and runs an allowed one', { skip, timeout: 240_000 }, async (t) => {
  // the first writes a file the guard keeps seats out of (here only a temp copy of that path)
  const { work, results } = await session(t, ['echo x > .claude/settings.json', 'echo x > second.txt']);
  assert.match(results[0]!, /Blocked/, 'the model was told why the first call stopped');
  assert.equal(existsSync(join(work, '.claude', 'settings.json')), false, 'the blocked command did not run');
  assert.ok(existsSync(join(work, 'second.txt')), 'the allowed command ran');
});

// #4892: a seat that reads its own server password can drive its own server. The probe runs as the model's shell command
// and writes yes or no only: whether any of its variables is named like a server password, and whether any value is the
// password (compared by hash, so the probe file never holds it)
const probe = (password: string) => `import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const sha = (v) => createHash('sha256').update(v).digest('hex');
writeFileSync('probe.json', JSON.stringify({
  named: Object.keys(process.env).filter((k) => /^OPENCODE_(SERVER_)?PASSWORD$/i.test(k)),
  value: Object.values(process.env).some((v) => sha(String(v)) === '${createHash('sha256').update(password).digest('hex')}'),
}));
`;

test('#4892: a shell command of an OpenCode 1.x seat sees neither the server password nor its name, and the server still asks for it', { skip, timeout: 240_000 }, async (t) => {
  const { work, bare } = await session(t, ['node probe.mjs'], (password) => ({ 'probe.mjs': probe(password) }));
  const seen = JSON.parse(readFileSync(join(work, 'probe.json'), 'utf8')) as { named: string[]; value: boolean };
  console.log(`#4892 probe: password-named variables in the shell: ${seen.named.length ? seen.named.join(', ') : 'none'}; the value under any name: ${seen.value ? 'yes' : 'no'}`);
  assert.equal(await bare(), 401, 'a request without the password is refused');
  assert.deepEqual(seen, { named: [], value: false });
});
