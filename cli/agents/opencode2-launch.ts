// How a 2.x seat starts (#4817 slice 2): the board's own server on the seat's port, then the TUI attached to it. This
// process makes the server password and hands it to those two only, each in its own env: nothing is exported in the pane.
// `serve --stdio` drops the password names from the server's env once it has read them (its other mode keeps them), so
// the agent's tool shells should not see them; only a live check shows that. The TUI starts only after the guard plugin,
// inside that server, left this launch's proof. Every failure stops the server and starts no TUI.
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatKey } from '../bridge.ts';
import { guardProven, opencode2VersionRefusal } from './opencode2.ts';
import { clearOpencodeEndpoint, writeOpencodeEndpoint } from './opencode.ts';

export type Child = { stdout: NodeJS.ReadableStream | null; endStdin(): void; kill(): void; exited: Promise<number> };
export type LaunchDeps = {
  /** What `opencode2 --version` prints. */
  version(): string;
  /** `opencode2 <args>`: the server with piped stdin and stdout, the TUI on the pane's terminal. */
  spawn(kind: 'server' | 'tui', args: string[], env: NodeJS.ProcessEnv): Child;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  say(line: string): void;
  waitMs?: number;
};
export type LaunchOptions = { machine: string; pane: string; port: number; model: string; cwd: string; env: NodeJS.ProcessEnv };

// never taken from the pane: this launch's own values only (Windows reads env names in any case)
const OWN_NAMES = new Set(['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'CB_GUARD_MARKER', 'CB_GUARD_NONCE']);
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The first line the server prints, or null when it ends or says nothing in time. Reading goes on after it: a full pipe
 *  would stall the server. */
function firstLine(child: Child, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    let text = '', over = false;
    const finish = (line: string | null) => { over = true; clearTimeout(timer); resolve(line); };
    const timer = setTimeout(() => finish(null), ms);
    child.exited.then(() => finish(null));
    child.stdout?.on('data', (chunk) => {
      if (over) return;
      text += String(chunk);
      const end = text.indexOf('\n');
      if (end >= 0) finish(text.slice(0, end));
      else if (text.length > 4096) finish(null);
    });
  });
}

/** Runs the seat until its TUI ends, and returns that exit code; 1 when the seat did not start (say() has why). */
export async function launchOpencode2(o: LaunchOptions, deps: LaunchDeps): Promise<number> {
  const waitMs = deps.waitMs ?? 30_000;
  const refuse = (why: string) => { deps.say(`cb: this OpenCode 2.x seat did not start: ${why}`); return 1; };
  const version = opencode2VersionRefusal(deps.version());
  if (version) return refuse(version);

  const env = Object.fromEntries(Object.entries(o.env).filter(([k]) => !OWN_NAMES.has(k.toUpperCase())));
  const password = randomBytes(24).toString('base64url'), nonce = randomBytes(16).toString('base64url');
  const marker = join(tmpdir(), `cb-seat-${seatKey(o.machine, o.pane)}.opencode2-proof.json`);
  const url = `http://127.0.0.1:${o.port}`;
  rmSync(marker, { force: true });
  clearOpencodeEndpoint(o.machine, o.pane);
  const server = deps.spawn('server', ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', String(o.port)],
    { ...env, OPENCODE_PASSWORD: password, CB_GUARD_MARKER: marker, CB_GUARD_NONCE: nonce });
  try {
    const line = await firstLine(server, waitMs);
    if (line === null) return refuse(`the server ended before saying where it listens, or said nothing within ${Math.ceil(waitMs / 1000)} s`);
    let listens: unknown;
    try { listens = JSON.parse(line)?.url; } catch {}
    // the line itself is never shown: the server's other mode prints a password
    if (listens !== url && listens !== `${url}/`) return refuse(`the server did not say it listens on ${url}`);

    // a session for the TUI to show and the relay to send to; asking for one also makes the server load its plugins
    const slash = o.model.indexOf('/');
    const answer = await deps.fetch(`${url}/api/session`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(waitMs),
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ location: { directory: o.cwd }, model: { providerID: o.model.slice(0, slash), id: o.model.slice(slash + 1) } }),
    });
    if (!answer.ok) return refuse(`creating the session answered ${answer.status}`);
    const body = await answer.json() as { id?: unknown; data?: { id?: unknown } } | null;
    const session = body?.data?.id ?? body?.id;
    if (typeof session !== 'string' || !SESSION_ID.test(session)) return refuse('creating the session returned no session id');

    for (const until = Date.now() + waitMs; !guardProven(marker, nonce);) {
      if (Date.now() >= until) return refuse('the guard did not prove itself from inside the server (no marker with this launch\'s nonce): run node kit/guard/install.mjs --check --agents opencode');
      await new Promise((r) => setTimeout(r, 100));
    }
    writeOpencodeEndpoint(o.machine, o.pane, { port: o.port, password, session });
    return await deps.spawn('tui', ['--server', url, '--session', session, '--auto'], { ...env, OPENCODE_PASSWORD: password }).exited;
  } catch (e) {
    return refuse((e as Error).message);
  } finally {
    clearOpencodeEndpoint(o.machine, o.pane);
    rmSync(marker, { force: true });
    server.endStdin();
    server.kill();
  }
}
