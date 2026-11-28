// The PC job runner daemon (#3600): `node cli/runner.ts`, started by `cb runner`. One per machine (the log server's
// port is the guard). It publishes this PC's recipe names to the board, claims queued jobs into its slots, runs them
// (cli/runner-job.ts), finishes them on the board and serves their logs to the peers in runner.json.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, machine } from '../server/db.ts';
import { freeLane, loadConfig, type RunnerConfig } from './recipes.ts';
import { boardHello, boardStackGap, type Board } from './runner-board.ts';
import { apiBoard, call } from './board.ts';
import { chooseTransport, type Transport } from './transport.ts';
import { logTail } from './summary.ts';
import { finish, reap, runJob, stackGate } from './runner-job.ts';
import { isNetworkError, survive } from './survive.ts';

const say = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
// #3902: once up, a dropped board connection is logged and outlived, not an exit (anything else still exits); before
// ready() (runner_hello, listen) it still exits, so the supervisor restarts the runner
const survival = survive(say);
const CONFIG = process.env.CB_RUNNER_CONFIG || join(homedir(), '.claude-board', 'runner.json');
const HOME = process.env.CB_RUNNER_HOME || join(homedir(), '.claude-board', 'runner');
const LOGS = join(HOME, 'logs');
const KEEP_MS = 7 * 86_400_000;

let cfg: RunnerConfig, configText = '';
try { configText = readFileSync(CONFIG, 'utf8'); cfg = loadConfig(configText); } catch (e: any) {
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
  .update([import.meta.filename, ...['runner-job.ts', 'recipes.ts', 'summary.ts', 'runner-board.ts', 'board.ts', 'transport.ts'].map((f) => join(import.meta.dirname, f))].map((f) => readFileSync(f, 'utf8')).join('\0'))
  .digest('hex').slice(0, 7);
// #3222 S4: a board address with this machine's runner key (cli/transport.ts) puts the runner on the worker API, and
// then it opens no database connection; else it connects to the database as before. The job env never gets either.
let via: Transport;
try { via = chooseTransport('runner'); } catch (e: any) {
  console.error(e?.message ?? e);
  process.exit(1);
}
const sql = via.mode === 'db' ? connect(undefined, { app: `cb-runner/${VERSION}`, max: 4 }) : null;
const api = via.mode === 'api' ? apiBoard({ url: via.url, keyFile: via.keyFile, code: VERSION }) : null;
const board: Board = (fn, args) => call(fn, args, api ?? sql); // every read and write
if (api) {
  // the board holds every call to the key's runner: say so now, not as a refusal of every claim
  const who = await api.hello();
  if (who.kind !== 'runner' || who.runner !== NAME) {
    console.error(`this machine's runner key is ${who.kind === 'runner' ? `runner ${who.runner}'s` : `a ${who.kind} key`}, and this runner is ${NAME}: install the key the owner issued for it (cb key install runner)`);
    process.exit(1);
  }
}
// #4527: Ahmed's slot setting on the board wins over runner.json's, read once here: a higher one takes this restart (a new
// slot's first job clones it fresh); a lower one cb.job_claim applies at once. The counts run go back in runner_hello
// (cli/runner-board.ts: a setting runner.json cannot take, or a board older than this runner, keeps runner.json's).
const hello = await boardHello(board, NAME, `http://${cfg.log.host}:${cfg.log.port}`, configText, cfg, say);
cfg = hello.cfg;
const fromBoard = hello.fromBoard;
if (hello.ended) say(`${hello.ended} job(s) left running by the last run ended as runner restarted`);
// #4710: this runner's DB test stacks start at least this many seconds apart (the board's stack_gap_set, else 30)
const stackGap = await boardStackGap(board, NAME, say);
const stackTurn = stackGate(stackGap * 1000);

const prune = () => {
  try {
    for (const f of readdirSync(LOGS)) {
      try { const p = join(LOGS, f); if (statSync(p).mtimeMs < Date.now() - KEEP_MS) rmSync(p); } catch {}
    }
  } catch (e: any) { say(`log cleanup failed: ${e?.message ?? e}`); }
};
prune();
setInterval(prune, 86_400_000);

// slot number → the job in it; a DB job also holds a lane (its own test stack and ports), dbLanes of them at once
const slots = new Map<number, { id: number; lane?: number; stop: AbortController }>();

function start(slot: number, j: any, lane: number | undefined) {
  const stop = new AbortController();
  slots.set(slot, { id: Number(j.id), lane, stop });
  say(`job #${j.id} started in slot ${slot}${lane === undefined ? '' : `, DB lane ${lane}`}`);
  runJob(j, { cfg, home: HOME, slot, lane, stop: stop.signal, stackTurn })
    .then(async (r) => {
      if (!r) return say(`job #${j.id} cancelled`);
      const done = await finish(board, NAME, Number(j.id), r, say);
      if (done === 'gave-up') lostClaim = true; // its end did not reach the board: the next claim loop ends it (I1)
      say(`job #${j.id} ${r.state}${r.exit_code === null ? '' : ` (exit ${r.exit_code})`}${done === 'gone' ? '; the job had already ended on the board' : done === 'gave-up' ? '; the board did not take its end, the next start ends it' : ''}`);
    })
    .catch((e) => say(`job #${j.id}: ${e?.message ?? e}`))
    .finally(() => { slots.delete(slot); claim(); });
}

// One claim loop at a time: a notice, the beat and a job's end can all ask at once.
let claiming = false, again = false, lostClaim = false;
async function claim() {
  if (claiming) { again = true; return; }
  claiming = true;
  try {
    // a claim that failed on the network may have committed: end what no slot holds (review I1), before claiming more
    if (lostClaim) {
      const n = await board('runner_reconcile_held', { runner: NAME, held: [...slots.values()].map((s) => s.id) });
      lostClaim = false;
      if (n) say(`${n} job(s) claimed while the board connection dropped ended: no slot was running them`);
    }
    do {
      again = false;
      for (;;) {
        const free = Array.from({ length: cfg.slots }, (_, i) => i + 1).find((s) => !slots.has(s));
        if (free === undefined) break;
        const lane = freeLane([...slots.values()].flatMap((s) => s.lane === undefined ? [] : [s.lane]), cfg.dbLanes);
        const j = await board('job_claim', { runner: NAME, allow_db: lane !== undefined });
        if (!j) break;
        start(free, j, j.db === true ? lane : undefined);
      }
    } while (again);
  } catch (e: any) {
    say(`claim failed: ${e?.message ?? e}`); // the next notice or beat retries
    if (isNetworkError(e)) lostClaim = true;
  } finally {
    claiming = false;
  }
}

async function cancels() {
  const ids = [...slots.values()].map((s) => s.id);
  if (!ids.length) return;
  try {
    for (const { id } of await board('jobs_cancelled', { ids })) {
      for (const s of slots.values()) if (s.id === Number(id)) s.stop.abort();
    }
  } catch (e: any) {
    say(`cancel check failed: ${e?.message ?? e}`);
  }
}

const tick = () => { cancels(); claim(); };
// Both tick on every notice, and again each time they (re)connect, when notices may have been missed. A stream the
// board refuses (the key revoked) is tried again: the key file is read for every request, so a new key needs no restart.
const follow = (listening: () => void) => {
  api!.events(['cb_jobs'], () => { listening(); tick(); }, { refused: (e) => {
    say(`the board refused the notice stream (${e.message}): trying again in 30 s`);
  } });
};
if (sql) await sql.listen('cb_jobs', tick, tick);
else await new Promise<void>(follow);
setInterval(() => {
  board('runner_beat', { runner: NAME }).catch((e: any) => say(`beat failed: ${e?.message ?? e}`));
  tick();
}, 30_000);
say(`runner ${NAME} up (cb-runner/${VERSION}${api ? ', on the worker API' : ''}), ${cfg.slots} slots and ${cfg.dbLanes} DB lane(s)${fromBoard ? ' (the board\'s setting)' : ''}, test stacks ${stackGap} s apart, logs on http://${cfg.log.host}:${cfg.log.port}`);
survival.ready();
