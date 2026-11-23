// The PC job runner daemon (#3600): `node cli/runner.ts`, started by `cb runner`. One per machine (the log server's
// port is the guard). It publishes this PC's recipe names to the board, claims queued jobs into its slots, runs them
// (cli/runner-job.ts), finishes them on the board and serves their logs to the peers in runner.json.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, machine } from '../server/db.ts';
import { loadConfig, published, type RunnerConfig } from './recipes.ts';
import { logTail } from './summary.ts';
import { finish, reap, runJob } from './runner-job.ts';

const say = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const CONFIG = process.env.CB_RUNNER_CONFIG || join(homedir(), '.claude-board', 'runner.json');
const HOME = process.env.CB_RUNNER_HOME || join(homedir(), '.claude-board', 'runner');
const LOGS = join(HOME, 'logs');
const KEEP_MS = 7 * 86_400_000;

let cfg: RunnerConfig;
try { cfg = loadConfig(readFileSync(CONFIG, 'utf8')); } catch (e: any) {
  console.error(`runner config ${CONFIG}: ${e?.message ?? e}`);
  process.exit(1);
}
const NAME = cfg.name ?? machine();
// Windows: a program started by name is never taken from the cwd (a slot clone's committed git.exe) before PATH
process.env.NoDefaultCurrentDirectoryInExePath = '1';
mkdirSync(LOGS, { recursive: true });
mkdirSync(join(HOME, 'state'), { recursive: true }); // slot install state and pid records

// Log server: GET /jobs/<id>/log[?tail=n], for the peers in runner.json only. Nothing else.
const server = http.createServer((req, res) => {
  const send = (code: number, body: string) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(body); };
  try { serve(req, res, send); } catch { // a malformed target, or a log pruned mid-read: never the daemon's end
    if (res.headersSent) res.destroy(); else send(404, 'not found\n');
  }
});
function serve(req: http.IncomingMessage, res: http.ServerResponse, send: (code: number, body: string) => void) {
  const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!cfg.log.peers.includes(peer)) return send(403, 'this machine may not read job logs\n');
  const url = URL.parse(req.url ?? '/', 'http://runner');
  const id = url && /^\/jobs\/(\d+)\/log$/.exec(url.pathname)?.[1];
  const file = url && id ? join(LOGS, `${id}.log`) : '';
  if (req.method !== 'GET' || !file || !existsSync(file)) return send(404, 'not found\n');
  const tail = url!.searchParams.get('tail');
  if (tail !== null) {
    const n = Number(tail);
    if (!Number.isInteger(n) || n < 0) return send(400, 'tail must be a whole number\n');
    // ponytail: tail reads the log's last 1 MB, so a tail longer than that comes back short
    const lines = logTail(file).replace(/\r?\n$/, '').split(/\r?\n/);
    return send(200, n ? lines.slice(-n).join('\n') + '\n' : '');
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}
await new Promise<void>((ok) => {
  server.once('error', (e: any) => {
    console.error(e?.code === 'EADDRINUSE' ? 'a runner is already running on this machine' : `log server: ${e?.message ?? e}`);
    process.exit(1);
  });
  server.listen(cfg.log.port, cfg.log.host, ok);
});

// Before any job: kill what a runner that died left running in the slots (git, installs, steps), so nothing races the
// next job in the same slot. Stopped by a signal, this runner does the same for its own jobs on the way out.
const STATE = join(HOME, 'state');
const reaped = reap(STATE, say);
if (reaped) say(`killed ${reaped} process(es) the last run left behind`);
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { reap(STATE, say); process.exit(0); });

// the version covers all of the runner's own code
const VERSION = createHash('sha1')
  .update([import.meta.filename, ...['runner-job.ts', 'recipes.ts', 'summary.ts'].map((f) => join(import.meta.dirname, f))].map((f) => readFileSync(f, 'utf8')).join('\0'))
  .digest('hex').slice(0, 7);
const sql = connect(undefined, { app: `cb-runner/${VERSION}`, max: 4 });
const [hello] = await sql`select cb.runner_hello(${NAME}, ${`http://${cfg.log.host}:${cfg.log.port}`}, ${sql.json(published(cfg) as any)}) as n`;
if (hello!.n) say(`${hello!.n} job(s) left running by the last run ended as runner restarted`);

const prune = () => {
  try {
    for (const f of readdirSync(LOGS)) {
      try { const p = join(LOGS, f); if (statSync(p).mtimeMs < Date.now() - KEEP_MS) rmSync(p); } catch {}
    }
  } catch (e: any) { say(`log cleanup failed: ${e?.message ?? e}`); }
};
prune();
setInterval(prune, 86_400_000);

// slot number → the job in it
const slots = new Map<number, { id: number; db: boolean; stop: AbortController }>();

function start(slot: number, j: any) {
  const stop = new AbortController();
  slots.set(slot, { id: Number(j.id), db: j.db === true, stop });
  say(`job #${j.id} started in slot ${slot}`);
  runJob(j, { cfg, home: HOME, slot, stop: stop.signal })
    .then(async (r) => {
      if (!r) return say(`job #${j.id} cancelled`);
      const done = await finish(sql, NAME, Number(j.id), r, say);
      say(`job #${j.id} ${r.state}${r.exit_code === null ? '' : ` (exit ${r.exit_code})`}${done === 'gone' ? '; the job had already ended on the board' : done === 'gave-up' ? '; the board did not take its end, the next start ends it' : ''}`);
    })
    .catch((e) => say(`job #${j.id}: ${e?.message ?? e}`))
    .finally(() => { slots.delete(slot); claim(); });
}

// One claim loop at a time: a notice, the beat and a job's end can all ask at once.
let claiming = false, again = false;
async function claim() {
  if (claiming) { again = true; return; }
  claiming = true;
  try {
    do {
      again = false;
      for (;;) {
        const free = Array.from({ length: cfg.slots }, (_, i) => i + 1).find((s) => !slots.has(s));
        if (free === undefined) break;
        const allowDb = ![...slots.values()].some((s) => s.db);
        const j = (await sql`select cb.job_claim(${NAME}, ${allowDb}) as j`)[0]!.j;
        if (!j) break;
        start(free, j);
      }
    } while (again);
  } catch (e: any) {
    say(`claim failed: ${e?.message ?? e}`); // the next notice or beat retries
  } finally {
    claiming = false;
  }
}

async function cancels() {
  const ids = [...slots.values()].map((s) => s.id);
  if (!ids.length) return;
  try {
    for (const { id } of await sql`select id from cb.jobs where id = any(${ids}::bigint[]) and state = 'cancelled'`) {
      for (const s of slots.values()) if (s.id === Number(id)) s.stop.abort();
    }
  } catch (e: any) {
    say(`cancel check failed: ${e?.message ?? e}`);
  }
}

const tick = () => { cancels(); claim(); };
await sql.listen('cb_jobs', tick, tick); // onlisten: also on every reconnect, when notices may have been missed
setInterval(() => {
  sql`select cb.runner_beat(${NAME})`.catch((e: any) => say(`beat failed: ${e?.message ?? e}`));
  tick();
}, 30_000);
say(`runner ${NAME} up (cb-runner/${VERSION}), logs on http://${cfg.log.host}:${cfg.log.port}`);
