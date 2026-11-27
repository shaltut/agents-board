// Claude Code Stop hook (#4349): the session's token ledger. At each Stop it sums the usage of every assistant turn in
// the session's transcript (and its subagents' transcripts) and sends the CUMULATIVE numbers to the board
// (cb.usage_report), which keeps one row per session. Numbers, a model id and the session id only: no transcript text,
// path or secret ever leaves this machine.
// It runs at every Stop of every live session, so it must never cost the session anything: it prints nothing, starts
// no child (a child would hold the hook's stdout pipe, #4482), always exits 0, and gives up after DEADLINE_MS. It reads
// each transcript incrementally (an offset per file in a small state file in the OS temp folder) and at most
// BYTES_PER_RUN bytes or PARSE_MS of parsing per Stop: a long transcript (tens of MB) is caught up over a few Stops.
// Not wired anywhere by default: docs/ops/maintain.md, "Usage ledger", says how to switch it on.
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BYTES_PER_RUN = 32 * 1024 * 1024;
export const PARSE_MS = 900;
export const DEADLINE_MS = 1900;
const CHUNK = 1024 * 1024;
// an assistant message is written as one line per content block, all with the same id and usage, up to ~10 lines apart
const RECENT = 32;
// a finished file (fully read, untouched this long) keeps only its offset
const SETTLED_MS = 10 * 60_000;
// the status line's cost counts as this Stop's when it was written this recently
const COST_FRESH_MS = 10 * 60_000;
// after a send that did not succeed, the next one waits this long
export const RETRY_MS = 5 * 60_000;
// state files of sessions untouched this long are deleted; at most this many are looked at per run
const STATE_KEEP_MS = 7 * 24 * 3600_000;
const CLEAN_MAX = 500;
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MODEL_ID = /^[A-Za-z0-9._:@/\[\]-]{1,100}$/; // the same pattern cb.usage_report checks
const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const zero = () => [0, 0, 0, 0];

/** The transcripts of one session: the main one, then its subagents' (<transcript dir>/<session>/subagents/*.jsonl). */
export function sessionFiles(transcript) {
  const sub = join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents');
  let names = [];
  try { names = readdirSync(sub).filter((n) => n.endsWith('.jsonl')).sort(); } catch {}
  return [{ key: 'main', path: transcript }, ...names.map((n) => ({ key: n, path: join(sub, n) }))];
}

/** Reads one file from f.offset, at most `budget.bytes` bytes and until `budget.until` (ms clock), adding each new
 *  assistant message's usage to `totals` once. Returns the model of the last message read, if any. Only whole lines
 *  count: a line still being written is read at the next Stop. sub: a subagent's transcript, where a turn with no
 *  parent is one copied from the parent session (a fork's transcript opens with the parent's last message, which the
 *  main transcript already counted). */
export function scanFile(path, f, totals, budget, sub = false) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return null; }
  let model = null;
  try {
    const size = statSync(path).size;
    const recent = new Map(f.recent ?? []);
    let pos = f.offset, carry = null;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < size && budget.bytes > 0 && Date.now() < budget.until) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos, budget.bytes), pos);
      if (n <= 0) break;
      pos += n; budget.bytes -= n;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const nl = data.lastIndexOf(0x0a);
      if (nl < 0) { carry = Buffer.from(data); continue; }
      // a newline byte never occurs inside a UTF-8 sequence, so the text up to it decodes whole
      for (const line of data.toString('utf8', 0, nl).split('\n')) {
        const m = turn(line);
        if (!m || (sub && m.copied)) continue;
        model = m.model ?? model;
        const prev = m.id ? recent.get(m.id) : undefined;
        for (let i = 0; i < 4; i++) totals[i] += Math.max(0, m.counts[i] - (prev?.[i] ?? 0));
        if (m.id) {
          recent.delete(m.id);
          recent.set(m.id, prev ? m.counts.map((c, i) => Math.max(c, prev[i])) : m.counts);
          if (recent.size > RECENT) recent.delete(recent.keys().next().value);
        }
      }
      f.offset = pos - (data.length - nl - 1);
      carry = data.length - nl - 1 ? Buffer.from(data.subarray(nl + 1)) : null;
    }
    // one line longer than a whole run's bytes would stop the file forever: step over it (its tail fails to parse)
    if (carry && carry.length >= BYTES_PER_RUN) f.offset = pos;
    f.recent = [...recent];
  } catch {} finally { closeSync(fd); }
  return model;
}

/** One transcript line → { id, model, counts } for an assistant turn with usage, else null. */
export function turn(line) {
  if (!line.includes('"assistant"')) return null; // most lines are not turns: skip the parse
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  const m = j?.type === 'assistant' ? j.message : null;
  const u = m?.usage;
  if (!u || typeof u !== 'object' || m.model === '<synthetic>') return null;
  return { id: typeof m.id === 'string' ? m.id : null, model: typeof m.model === 'string' ? m.model : null, copied: j.parentUuid === null,
    counts: FIELDS.map((k) => count(u[k])) };
}

/** Adds what the session's files gained since `state` to it (offsets, totals, model). Mutates and returns state. */
export function scanSession(transcript, state, { bytes = BYTES_PER_RUN, until = Date.now() + PARSE_MS, now = Date.now() } = {}) {
  if (state.transcript !== transcript) Object.assign(state, { transcript, files: {}, totals: zero(), model: null });
  const budget = { bytes, until };
  for (const { key, path } of sessionFiles(transcript)) {
    const f = state.files[key] ??= { offset: 0 };
    let st;
    try { st = statSync(path); } catch { continue; }
    // a file that shrank was rewritten: start the session over (the board keeps the larger numbers meanwhile)
    if (st.size < f.offset) { Object.assign(state, { files: {}, totals: zero(), model: null }); return scanSession(transcript, state, { bytes, until, now }); }
    if (st.size > f.offset && budget.bytes > 0 && Date.now() < budget.until) {
      const model = scanFile(path, f, state.totals, budget, key !== 'main');
      if (key === 'main' && model) state.model = model;
    }
    if (f.offset >= st.size && now - st.mtimeMs > SETTLED_MS) delete f.recent;
  }
  return state;
}

/** The session's cost as the status line last wrote it, when that was within COST_FRESH_MS; else null. Today the only
 *  writer is the claude-hud status line, with its daily or weekly cost display on (plugins/claude-hud/daily-cost.json:
 *  { sessions: { <id>: { total, ts } } }, total = Claude Code's cost.total_cost_usd). Nothing is ever priced here. */
export function statuslineCost(sessionId, now = Date.now(), configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  try {
    const s = JSON.parse(readFileSync(join(configDir, 'plugins', 'claude-hud', 'daily-cost.json'), 'utf8'))?.sessions?.[sessionId];
    const total = s?.total, ts = s?.ts;
    return typeof total === 'number' && Number.isFinite(total) && total >= 0 && typeof ts === 'number' && now - ts <= COST_FRESH_MS ? total : null;
  } catch { return null; }
}

// state files live in their own folder, so the cleanup below lists only them, never the whole temp folder
export const stateDir = (dir) => join(dir, 'cb-usage');
const stateFile = (dir, sid) => join(stateDir(dir), `${sid}.json`);
export function loadState(dir, sid) {
  try {
    const s = JSON.parse(readFileSync(stateFile(dir, sid), 'utf8'));
    if (s && typeof s === 'object' && s.files && Array.isArray(s.totals) && s.totals.length === 4) return s;
  } catch {}
  return { transcript: null, files: {}, totals: zero(), model: null, sent: null };
}
export function saveState(dir, sid, state) {
  const f = stateFile(dir, sid), tmp = `${f}.${process.pid}.tmp`;
  try { mkdirSync(stateDir(dir), { recursive: true }); writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, f); } catch {}
}
/** Deletes state files untouched for STATE_KEEP_MS (sessions long gone), looking at most at CLEAN_MAX files a run. */
export function cleanStates(dir, now = Date.now()) {
  let names = [];
  try { names = readdirSync(stateDir(dir)).slice(0, CLEAN_MAX); } catch { return; }
  for (const n of names) {
    const f = join(stateDir(dir), n);
    try { if (now - statSync(f).mtimeMs > STATE_KEEP_MS) unlinkSync(f); } catch {}
  }
}
/** A model id as the board accepts it, else 'unknown': a broken transcript's text never leaves the machine. */
export const modelId = (m) => (m == null ? null : MODEL_ID.test(m) ? m : 'unknown');

/** What goes to the board: numbers, the model id and the session's place, nothing else. */
export function report(state, cost) {
  const [input, output, cacheRead, cacheWrite] = state.totals;
  return { model: modelId(state.model), input, output, cacheRead, cacheWrite, cost };
}

async function readStdin(ms) {
  return await new Promise((resolve) => {
    const parts = []; let n = 0;
    const done = () => resolve(Buffer.concat(parts).toString('utf8'));
    setTimeout(done, ms).unref();
    process.stdin.on('data', (d) => { if ((n += d.length) <= 1024 * 1024) parts.push(d); });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function main() {
  const t0 = Date.now();
  const pane = process.env.HERDR_PANE_ID;
  // board sessions always run in a herdr pane; anything else, or the switch off, costs nothing
  if (!pane || process.env.CB_USAGE_OFF === '1') return;
  let input;
  try { input = JSON.parse(await readStdin(300)); } catch { return; }
  const sid = input?.session_id, transcript = input?.transcript_path;
  if (typeof sid !== 'string' || !SESSION_ID.test(sid) || typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return;
  const dir = process.env.CB_USAGE_STATE_DIR || tmpdir();
  cleanStates(dir);
  const state = scanSession(transcript, loadState(dir, sid), { until: t0 + PARSE_MS });
  const r = report(state, statuslineCost(sid));
  const unchanged = state.sent && JSON.stringify(state.sent) === JSON.stringify(r);
  // an attempt that did not succeed (a board down or not answering cost it the whole deadline): no new one for
  // RETRY_MS, so every Stop meanwhile stays fast. The totals are cumulative: the next send carries everything.
  const backingOff = typeof state.tried_at === 'number' && Date.now() - state.tried_at < RETRY_MS;
  const send = !unchanged && !backingOff && r.input + r.output + r.cacheRead + r.cacheWrite > 0;
  if (send) state.tried_at = Date.now(); // before connecting: a run the deadline ends counts as a failed attempt
  saveState(dir, sid, state);
  if (!send) return;

  const { connect, databaseUrl, machine } = await import('../server/db.ts');
  const { openBridge, seatKey } = await import('../cli/bridge.ts');
  const m = machine(), url = databaseUrl();
  let direct;
  const openDirect = () => (direct ??= connect(url, { app: 'cb-usage', max: 1 }));
  // the seat's relay already holds a board connection: ride on it, and connect only when there is none
  const db = (await openBridge(seatKey(m, pane), url, openDirect).catch(() => null)) ?? openDirect();
  await db`select cb.usage_report(machine => ${m}, pane => ${pane}, session_id => ${sid}, model => ${r.model},
    input_tokens => ${r.input}::bigint, output_tokens => ${r.output}::bigint, cache_read_tokens => ${r.cacheRead}::bigint,
    cache_write_tokens => ${r.cacheWrite}::bigint, cost_usd => ${r.cost}::numeric) as result`;
  state.sent = r;
  delete state.tried_at;
  saveState(dir, sid, state);
}

let isMain = false;
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch {}
if (isMain) {
  // a hook must never fail or hold up its session: every way out is a silent exit 0
  const quit = () => process.exit(0);
  setTimeout(quit, DEADLINE_MS);
  process.on('uncaughtException', quit);
  process.on('unhandledRejection', quit);
  main().then(quit, quit);
}
