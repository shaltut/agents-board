// The local fault log (#4535): one JSONL line per cb run that ended in an error, a refusal, a retry, a timeout or an
// unexpected exit, in ~/.claude-board/faults/<UTC day>.jsonl (CB_FAULTS_HOME overrides; CB_FAULTS_OFF=1 turns it off).
// A run that succeeds touches no file. cb triage (cli/triage.ts) reads it and files the real faults on the board.
//
// Redaction is an allow-list by construction: every field but msg is an enum, a pattern-checked name or a number, and
// msg is rebuilt token by token so only words of cb's own source (kit/fault-words.json), N for a digit run and ASCII
// punctuation survive; quoted spans and every argument value become ‹v› first. Never logged: argument values, card or
// question text, stdin, tokens, URLs, the database URL, environment values, paths, hosts, stack traces.
//
// Writing must never fail or slow the command: everything here is synchronous, starts no child, opens no connection,
// and is wrapped in try/catch by its callers' single entry point (writeFault). Node built-ins only, so the hooks and the
// guard can load it later.
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = 1;
export const KINDS = ['usage', 'refused', 'not_run', 'lost', 'db', 'crash', 'retried', 'slow', 'local_start', 'bridge', 'daemon', 'cap'];
export const CAP_BYTES = 5 * 1024 * 1024;
export const KEEP_DAYS = 14;
export const V = '‹v›';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The folder of this machine's fault log. */
export function faultsHome(env = process.env) {
  return env.CB_FAULTS_HOME || join(homedir(), '.claude-board', 'faults');
}

/** Off by CB_FAULTS_OFF=1, and under node:test (NODE_TEST_CONTEXT reaches every child it spawns) unless the test names
 *  its own CB_FAULTS_HOME: the suite expects errors by the hundred, and triage must never file test noise. */
export function faultsOn(env = process.env) {
  if (env.CB_FAULTS_OFF === '1') return false;
  if (env.CB_FAULTS_HOME) return true;
  // a test file run without --test has no NODE_TEST_CONTEXT, but its board is a test database
  return !env.NODE_TEST_CONTEXT && !/\/claude_board_test\w*(?:\?|$)/.test(env.CB_DATABASE_URL ?? '');
}

let WORDS = null;
function words() {
  if (!WORDS) WORDS = new Set(JSON.parse(readFileSync(join(ROOT, 'kit', 'fault-words.json'), 'utf8')));
  return WORDS;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The message with nothing but cb's own words left. values: strings known to be values (argument values, the board's
 *  host, user and database, this machine's names), masked wherever they appear, before anything else: cb also echoes
 *  some values unquoted ("<project> has no squad yet"), and a value made of dictionary words would pass the word test. */
export function mask(s, values = []) {
  const M = '\u0001';
  // idempotent: an earlier pass's ‹v› stays one, and its N stays N (buildLine masks again whatever a writer sent)
  let t = String(s ?? '').slice(0, 4000).replaceAll(V, M);
  const vs = [...new Set(values.filter((v) => typeof v === 'string' && v.trim().length >= 3).map((v) => v.trim()))]
    .sort((a, b) => b.length - a.length);
  for (const v of vs) t = t.replace(new RegExp(esc(v), 'gi'), M);
  // shapes that are values whatever their words: URLs, emails and session names (NAME@machine), paths, dotted hosts
  t = t.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]*/gi, M)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g, M)
    .replace(/\b[A-Za-z]:[\\/][^\s"'`]*|\\\\[^\s"'`]+|~[\\/][^\s"'`]*|(?<![\w.\/])\/[\w.-]+(?:\/[\w.-]*)+/g, M)
    .replace(/\b[\w-]+(?:\.[\w-]+){2,}\b/g, M);
  // lists cb echoes unquoted: "known: <projects>", "is not one of Q12's options: <labels>"
  t = t.replace(/\b(known|options)(\s*:\s*)[^.)\n]*/gi, `$1$2${M}`);
  // quoted values whole (card titles are ordinary words), straight or curly; an opening quote never closed, to the end
  t = t.replace(/"[^"\n]*"|(?<![A-Za-z0-9])'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’|«[^»\n]*»/g, '\u0002')
    .replace(/(?:["`“«]|(?<![A-Za-z0-9])['‘])[^\n]*/g, '\u0003');
  const W = words();
  t = t.replace(/[\u0001-\u0003]|[A-Za-z]+|\d+|[^\sA-Za-z\d]/g, (k) =>
    k === M ? V : k === '\u0002' ? `"${V}"` : k === '\u0003' ? `"${V}`
    : /^\d/.test(k) ? 'N'
    : /^[A-Za-z]/.test(k) ? (W.has(k.toLowerCase()) || k === 'a' || k === 'A' || k === 'I' || k === 'N' ? k : V)
    : /^[\x21-\x7e]$/.test(k) ? k : V); // ASCII punctuation kept; any other character (a name in another script) masked
  return t.replace(/‹v›(?:[^\sA-Za-z\d‹"]{0,3}\s?‹v›)+/g, V).replace(/\s+/g, ' ').trim().slice(0, 300);
}

// The command is part of the group only where the command is the fault's place (a wrong use, a refusal, a db error, a
// crash, a slow command): one outage hit by show, mine and next is one group, not one per command.
const BY_CMD = new Set(['usage', 'refused', 'db', 'crash', 'slow']);
/** The group key: machine-, release- and value-independent, versioned so a new normaliser starts new groups on purpose.
 *  It is also the key two machines dedupe on (the fault:ft-… marker in a filed card's body). */
export function tmplOf(l) {
  // a database error raised while connecting (no database, auth, the server shutting down or full) is not the command's
  const c = BY_CMD.has(l.kind) && !(l.kind === 'db' && /^(?:08|28|3D|53|57)/.test(l.code ?? ''));
  // ...and then neither is the "Run: cb help <command>" hint cb adds to it
  const msg = c ? l.msg : String(l.msg ?? '').replace(/\bcb help [a-z-]+/g, 'cb help');
  const key = ['f1', l.src, c ? l.cmd : '*', c ? l.sub : '*', l.kind, l.code, msg].map((x) => x ?? '').join('\0');
  return 'ft-' + createHash('sha1').update(key).digest('hex').slice(0, 12);
}

const readText = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };

/** The release this copy runs, without starting a child (a hook must start none, #4482): release.json's sha (an
 *  installed release), else the checkout's HEAD (a worktree's .git file followed; loose ref, then packed-refs). */
export function releaseOf(root = ROOT) {
  try {
    const sha = JSON.parse(readText(join(root, 'release.json')) ?? 'null')?.sha;
    if (typeof sha === 'string' && /^[0-9a-f]{10,40}$/.test(sha)) return sha.slice(0, 10);
  } catch {}
  let git = join(root, '.git');
  const file = readText(git);
  if (file?.startsWith('gitdir:')) { const d = file.slice(7).trim(); git = isAbsolute(d) ? d : resolve(root, d); }
  const head = readText(join(git, 'HEAD'));
  if (!head) return null;
  if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 10);
  const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1];
  if (!ref) return null;
  const common = readText(join(git, 'commondir'));
  const dirs = [git, ...(common ? [isAbsolute(common) ? common : resolve(git, common)] : [])];
  for (const d of dirs) {
    const loose = readText(join(d, ref));
    if (loose && /^[0-9a-f]{40}$/.test(loose)) return loose.slice(0, 10);
    const packed = readText(join(d, 'packed-refs'));
    const m = packed && new RegExp(`^([0-9a-f]{40}) ${esc(ref)}$`, 'm').exec(packed);
    if (m) return m[1].slice(0, 10);
  }
  return null;
}

const day = (d) => d.toISOString().slice(0, 10);
const keepDays = (env) => { const n = Number(env.CB_FAULTS_KEEP_DAYS); return Number.isInteger(n) && n > 0 ? n : KEEP_DAYS; };

/** The first write of a new day deletes day files older than the kept days. */
function rotate(dir, now, env) {
  const cut = day(new Date(now.getTime() - keepDays(env) * 86400_000));
  for (const n of readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) < cut) try { unlinkSync(join(dir, n)); } catch {}
}

/** Over the cap: nothing more that day but one cap line, the first time (it is the file's last line from then on). */
function capped(file, size) {
  const fd = openSync(file, 'r');
  try {
    const n = Math.min(size, 200), buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8').includes('"kind":"cap"');
  } finally { closeSync(fd); }
}

const NAME = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const pick = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);

/** One line, every field checked against its pattern: anything else becomes null (or ‹other›). The message is masked
 *  here (mask is idempotent), so every writer is, and f.values (never stored) names the values it knows of. Also the
 *  re-check of a line read back from a file (readFaults). */
export function buildLine(f) {
  const l = {
    v: VERSION, at: (f.at ?? new Date()).toISOString(), machine: pick(f.machine, NAME) ?? '‹other›', release: pick(f.release, /^[0-9a-f]{10}$/),
    src: ['cb', 'hook:session-start', 'hook:usage-stop', 'guard', 'relay', 'supervisor'].includes(f.src) ? f.src : 'cb',
    cmd: f.cmd == null ? null : pick(f.cmd, /^[a-z][a-z-]{0,19}$/) ?? '‹other›', sub: pick(f.sub, /^[a-z]{2,12}$/),
    flags: (f.flags ?? []).filter((x) => /^[a-z][a-z0-9-]{0,30}$/.test(x)).slice(0, 20),
    argc: int(f.argc), exit: Number.isInteger(f.exit) ? f.exit : null, kind: KINDS.includes(f.kind) ? f.kind : 'crash',
    code: pick(f.code, /^[A-Z0-9_]{2,32}$/), msg: f.msg ? mask(f.msg, f.values ?? []) : '', tmpl: null,
    ms: int(f.ms), tries: int(f.tries), n: int(f.n) || 1,
    board: f.board === 'local' || f.board === 'remote' ? f.board : null,
    pane: pick(f.pane, /^[\w:.-]{1,40}$/), actor: pick(f.actor, /^[A-Za-z0-9_-]{1,40}@[a-z0-9.-]{1,40}$/),
    agent: pick(f.agent, /^[a-z]{2,12}$/) ?? 'claude', node: pick(f.node, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/) ?? process.versions.node,
  };
  l.tmpl = tmplOf(l);
  return l;
}

/** Appends one line. Never throws, never sets the exit code, never awaits. */
export function writeFault(fields, env = process.env) {
  try {
    if (!faultsOn(env)) return false;
    const line = buildLine(fields);
    const dir = faultsHome(env), now = new Date(line.at), file = join(dir, `${day(now)}.jsonl`);
    let size = -1;
    try { size = statSync(file).size; } catch {}
    if (size >= CAP_BYTES) {
      if (capped(file, size)) return false;
      appendFileSync(file, JSON.stringify({ v: VERSION, at: line.at, machine: line.machine, kind: 'cap', msg: 'the day file is full: no more lines today' }) + '\n', { mode: 0o600 });
      return false;
    }
    if (size < 0) {
      try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
      try { rotate(dir, now, env); } catch {}
    }
    appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** Every line since `sinceMs` (epoch ms), oldest day first, each re-checked by buildLine (a hand-edited or older line
 *  cannot carry a value on to triage); a line that does not parse (torn by a crash) is skipped. */
export function readFaults(sinceMs, env = process.env) {
  const dir = faultsHome(env), from = day(new Date(sinceMs));
  let names = [];
  try { names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= from).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    for (const s of (readText(join(dir, n)) ?? '').split('\n')) {
      if (!s) continue;
      try {
        const l = JSON.parse(s);
        if (!l || typeof l !== 'object' || !(Date.parse(l.at) >= sinceMs)) continue;
        out.push(l.kind === 'cap' ? { v: VERSION, at: new Date(l.at).toISOString(), machine: pick(l.machine, NAME) ?? '‹other›', kind: 'cap' }
          : buildLine({ ...l, at: new Date(l.at), values: [] }));
      } catch {}
    }
  }
  return out;
}

// ---- the vocabulary: every word of 2+ letters in a string literal of cb's source (node kit/fault-line.mjs --words)

export const WORD_SOURCES = ['cli', 'hooks', 'kit', 'db/schema.sql'];

/** The text of every string literal in a JS/TS (or, with sql, SQL) source: comments skipped, template parts kept. */
export function literals(src, sql = false) {
  const out = [];
  let i = 0, depth = [];
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (sql ? c === '-' && d === '-' : c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (!sql && c === '}' && depth.length && depth[depth.length - 1] === 0) { depth.pop(); i++; i = tpl(i); continue; }
    if (!sql && depth.length && (c === '{' || c === '}')) { depth[depth.length - 1] += c === '{' ? 1 : -1; i++; continue; }
    if (c === "'" || (!sql && c === '"')) {
      let j = i + 1, s = '';
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; s += src[j] ?? ''; j++; }
      out.push(s); i = j + 1; continue;
    }
    if (!sql && c === '`') { i = tpl(i + 1); continue; }
    i++;
  }
  return out;
  function tpl(j) { // inside a template literal: up to its end, or into a ${ … } part
    let s = '';
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { s += src[j + 1] ?? ''; j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') { out.push(s); depth.push(0); return j + 2; }
      s += src[j]; j++;
    }
    out.push(s);
    return j + 1;
  }
}

function sourceFiles(root) {
  const files = [];
  const walk = (d) => {
    let es = [];
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(ts|mjs)$/.test(e.name)) files.push(p);
    }
  };
  for (const s of WORD_SOURCES) { if (s.endsWith('.sql')) files.push(join(root, s)); else walk(join(root, s)); }
  return files.sort();
}

/** The sorted vocabulary of the source under root. */
export function buildWords(root = ROOT) {
  const set = new Set();
  for (const f of sourceFiles(root)) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const s of literals(src, f.endsWith('.sql'))) for (const w of s.match(/[A-Za-z]{2,}/g) ?? []) set.add(w.toLowerCase());
  }
  return [...set].sort();
}

export const wordsText = (list) => '[\n' + list.map((w) => JSON.stringify(w)).join(',\n') + '\n]\n';

/** How far kit/fault-words.json is from the source: missing (in the source, not in the file: only masked more) and
 *  extra (in the file, gone from the source: the direction that matters, a removed name must not stay). */
export function wordsDrift(root = ROOT) {
  const now = new Set(buildWords(root));
  let file = [];
  try { file = JSON.parse(readFileSync(join(root, 'kit', 'fault-words.json'), 'utf8')); } catch {}
  const have = new Set(file);
  return { missing: [...now].filter((w) => !have.has(w)), extra: file.filter((w) => !now.has(w)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === '--words') {
  const list = buildWords();
  writeFileSync(join(ROOT, 'kit', 'fault-words.json'), wordsText(list));
  console.log(`kit/fault-words.json: ${list.length} words`);
}
