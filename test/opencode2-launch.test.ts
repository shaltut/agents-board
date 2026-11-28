// How a 2.x seat is started (#4817 slice 2): only the server and the TUI get the password, and the TUI starts only after
// the guard proved itself from inside the server. Pure: no database, no OpenCode (the processes and the HTTP are fakes).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { clearOpencodeEndpoint, readOpencodeEndpoint } from '../cli/agents/opencode.ts';
import { launchOpencode2 } from '../cli/agents/opencode2-launch.ts';

const MACHINE = 'testbox', PANE = `w${process.pid}:p1`, PORT = 41234;
const URL_OK = `http://127.0.0.1:${PORT}`;

type World = {
  version?: string;
  line?: string | null; // what the server prints first; null: it exits without printing
  status?: number; // of POST /api/session
  proves?: boolean; // the plugin writes its marker
};

function world(w: World = {}) {
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; kind: string }[] = [];
  const requests: { url: string; auth: string; body: unknown }[] = [];
  const said: string[] = [];
  const server = { stdinEnded: false, killed: false };
  let atTui: ReturnType<typeof readOpencodeEndpoint> = null;
  const baseEnv: NodeJS.ProcessEnv = { CB_ROLE: 'reviewer', CB_AGENT: 'opencode2', OPENCODE_SERVER_PASSWORD: 'left-over-in-the-pane', OPENCODE_PASSWORD: 'another-left-over' };
  const deps = {
    waitMs: 300,
    version: () => w.version ?? 'opencode v2.2.0\n',
    say: (s: string) => { said.push(s); },
    spawn(kind: 'server' | 'tui', args: string[], env: NodeJS.ProcessEnv) {
      spawned.push({ kind, args, env });
      if (kind === 'tui') {
        atTui = readOpencodeEndpoint(MACHINE, PANE);
        return { stdout: null, endStdin() {}, kill() {}, exited: Promise.resolve(0) };
      }
      const stdout = new PassThrough();
      let end = (_code: number) => {};
      const exited = new Promise<number>((r) => { end = r; });
      setImmediate(() => { if (w.line === null) end(1); else stdout.write(`${w.line ?? JSON.stringify({ url: URL_OK })}\n`); });
      return { stdout, exited, endStdin() { server.stdinEnded = true; end(0); }, kill() { server.killed = true; end(1); } };
    },
    async fetch(url: string, init?: RequestInit) {
      requests.push({ url, auth: new Headers(init?.headers).get('authorization') ?? '', body: JSON.parse(String(init?.body ?? 'null')) });
      const env = spawned[0]!.env;
      if (w.proves !== false) writeFileSync(env.CB_GUARD_MARKER!, JSON.stringify({ nonce: env.CB_GUARD_NONCE, at: Date.now() }));
      return new Response(JSON.stringify({ data: { id: 'ses_synthetic1' } }), { status: w.status ?? 200 });
    },
  };
  const run = () => launchOpencode2({ machine: MACHINE, pane: PANE, port: PORT, model: 'anthropic/some-model', cwd: '/work/seat', env: baseEnv }, deps);
  return { run, spawned, requests, said, server, baseEnv, atTui: () => atTui };
}

test('the password reaches the server and the TUI only, and the endpoint file lasts as long as the TUI', async (t) => {
  t.after(() => clearOpencodeEndpoint(MACHINE, PANE));
  const w = world(), before = { ...w.baseEnv };
  assert.equal(await w.run(), 0, w.said.join('\n'));

  const [server, tui] = w.spawned as [(typeof w.spawned)[0], (typeof w.spawned)[0]];
  assert.deepEqual(server.args, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', String(PORT)]);
  const password = server.env.OPENCODE_PASSWORD!;
  assert.ok(password.length >= 32 && password !== 'another-left-over');
  assert.equal(server.env.OPENCODE_SERVER_PASSWORD, undefined, 'a name left in the pane is dropped');
  assert.ok(server.env.CB_GUARD_MARKER && server.env.CB_GUARD_NONCE);
  assert.equal(server.env.CB_ROLE, 'reviewer', 'the guard\'s seat rules reach the server');

  assert.deepEqual(w.requests, [{ url: `${URL_OK}/api/session`, auth: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    body: { location: { directory: '/work/seat' }, model: { providerID: 'anthropic', id: 'some-model' } } }]);

  assert.deepEqual(tui.args, ['--server', URL_OK, '--session', 'ses_synthetic1', '--auto']);
  assert.equal(tui.env.OPENCODE_PASSWORD, password);
  assert.equal(tui.env.OPENCODE_SERVER_PASSWORD, undefined);
  assert.equal(tui.env.CB_GUARD_NONCE, undefined);

  assert.deepEqual(w.baseEnv, before, 'the launcher\'s own env is not changed');
  const ep = w.atTui();
  assert.deepEqual([ep?.port, ep?.password, ep?.session], [PORT, password, 'ses_synthetic1']);
  assert.equal(readOpencodeEndpoint(MACHINE, PANE), null, 'cleared when the TUI ends');
  assert.ok(w.server.stdinEnded, 'the server is told to stop');
  assert.ok(![...w.said, ...server.args, ...tui.args].join(' ').includes(password), 'never printed or on argv');
});

for (const [name, setup, why, serverStarts] of [
  ['a version that is not accepted', { version: 'opencode v2.9.0\n' }, /not accepted/, false],
  ['a server on another address', { line: JSON.stringify({ url: 'http://127.0.0.1:9' }) }, /did not say it listens on/, true],
  ['a first line that is not the address', { line: 'server listening' }, /did not say it listens on/, true],
  ['a server that ends at once', { line: null }, /ended before/, true],
  ['a refused session', { status: 401 }, /session.*401/, true],
  ['no proof from the guard', { proves: false }, /guard did not prove/, true],
] as const) {
  test(`no TUI and no endpoint file after ${name}`, async (t) => {
    t.after(() => clearOpencodeEndpoint(MACHINE, PANE));
    const w = world(setup);
    assert.equal(await w.run(), 1);
    assert.match(w.said.join('\n'), why);
    assert.deepEqual(w.spawned.map((s) => s.kind), serverStarts ? ['server'] : []);
    assert.equal(readOpencodeEndpoint(MACHINE, PANE), null);
    if (serverStarts) assert.ok(w.server.stdinEnded, 'the server is stopped');
    const password = w.spawned[0]?.env.OPENCODE_PASSWORD;
    if (password) assert.ok(!w.said.join('\n').includes(password));
  });
}
