// Runner summaries: turn a job's log into a short, masked board summary. Pure apart from logTail's file read.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const MAX = 1000;
const MAX_NAMES = 5;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export const cut = (s: string, max = MAX) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

function shape(counts: { passed: number; failed: number; skipped: number; cancelled?: number; todo?: number }, names: string[]) {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  // cancelled and todo only when there are some: node:test lists cancelled tests with the failing ones
  const cancelled = counts.cancelled ? `${counts.cancelled} cancelled, ` : '';
  let text = `${counts.passed} passed, ${counts.failed} failed, ${cancelled}${counts.skipped} skipped${counts.todo ? `, ${counts.todo} todo` : ''}.`;
  if (counts.failed > 0 || counts.cancelled || unique.length) {
    const shown = unique.slice(0, MAX_NAMES).join('; ');
    const more = unique.length > MAX_NAMES ? `; and ${unique.length - MAX_NAMES} more` : '';
    text += ` Failing: ${shown}${more}`;
  }
  // failed: what did not pass (failed or cancelled), for a step that exits non-zero with none (#4417)
  return { text: cut(text), ran: counts.passed + counts.failed, failed: counts.failed + (counts.cancelled ?? 0) };
}

// each line is cut to 2000 chars so the per-line regexes below cannot backtrack on a megabyte line
const split = (output: string) => output.replace(ANSI, '').replaceAll('\0', '').split(/\r?\n/).map((l) => l.slice(0, 2000));
const COUNT = /^\s*(?:\S{1,4}\s+)?(pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/;
// code-frame lines (a linted file's source: oxlint, prettier's `[error] 2 | code`, Babel's `> 12 | code`) stay off the
// board; so do pnpm's trailer lines, which would push the one real error out of the tail
const FRAME = /^\s*(?:\[\w+\]\s*)?>?\s*(?:\d+\s*[│|]|[│|·╭╰─])/;
const DROP = /ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL|^\s*Exit status \d+|^\s*WARN\s|^\s*(?:[A-Za-z]:)?[\\/]\S*:\s*$/;

// the last 5 lines that are not code frames or trailer lines; with nothing left but trailer lines, the last line that
// is not a code frame; '' when there is none
function lastLines(lines: string[]): string {
  const kept = lines.filter((l) => l.trim() && !FRAME.test(l));
  const tail = kept.filter((l) => !DROP.test(l)).slice(-5);
  return (tail.length ? tail : kept.slice(-1)).join('\n');
}

// node:test's closing block (tests, suites, pass ... todo, duration_ms) and vitest's (Test Files, Tests, Duration)
const CLOSING = /^\s*(?:\S{1,4}\s+)?(?:tests|suites|duration_ms)\s+[\d.]+\s*$|^\s*(?:Test Files|Tests|Duration)\s/;

/** Why a command that printed test counts still exited non-zero (#4417): its lines after the last count line
 *  (lefthook's `exit status 1` and the command it failed, a crash after the run), else its last lines; '' for none. */
export function afterCounts(output: string): string {
  const lines = split(output);
  const end = lines.findLastIndex((l) => COUNT.test(l) || CLOSING.test(l));
  return lastLines(lines.slice(end + 1)) || lastLines(lines);
}

/** The board summary for a log: counts and failing names for node:test / TAP / vitest, else the last 5 lines that are not code frames or pnpm trailer lines. */
export function summarize(output: string): { text: string; ran: number | null; failed: number | null } {
  const lines = split(output);

  const vt = lines.map((l) => /^\s*Tests\s+(\d+ (?:failed|passed|skipped|todo)\b.*|no tests)\s*$/.exec(l)?.[1]).filter((v): v is string => v !== undefined).at(-1);
  if (vt !== undefined) {
    const n = (w: string) => Number(new RegExp(`(\\d+) ${w}\\b`).exec(vt)?.[1] ?? 0);
    const names = lines.flatMap((l) => /^\s*FAIL\s+(.+?)\s*$/.exec(l)?.[1] ?? []);
    return shape({ passed: n('passed'), failed: n('failed'), skipped: n('skipped'), todo: n('todo') }, names);
  }

  const c: Record<string, number> = {};
  const names: string[] = [];
  for (const l of lines) {
    const m = COUNT.exec(l);
    if (m) c[m[1]!] = Number(m[2]); // last occurrence wins
    const name = /^\s*✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/.exec(l)?.[1] ?? /^\s*not ok \d+ - (.+?)(?:\s+#.*)?\s*$/.exec(l)?.[1];
    if (name) names.push(name);
  }
  if (c.pass !== undefined || c.fail !== undefined || c.skipped !== undefined) {
    return shape({ passed: c.pass ?? 0, failed: c.fail ?? 0, skipped: c.skipped ?? 0, cancelled: c.cancelled, todo: c.todo }, names);
  }

  return { text: cut(lastLines(lines) || '(no output)'), ran: null, failed: null }; // never an empty summary
}

const MASK = '[masked]';
const SAFE_LOGINS = new Set(['git', 'cb', 'opc', 'ubuntu', 'root', 'admin', 'postgres', 'ec2-user', 'azureuser', 'debian', 'deploy']);
const KEYED = /(?<![a-z0-9])[a-z0-9_]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|accountkey|token)["']?\s*[=:]\s*["']?([^\s<"',;]{6,})/gi;

/** Replaces what the board's cb._sensitive would refuse (patterns copied from db/schema.sql) with [masked]. */
export function mask(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g, MASK)
    .replace(/\bbearer\s+[a-z0-9._~+/=-]{20,}/gi, MASK)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}[A-Za-z0-9._-]*/g, MASK)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?:-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY)?-*/g, MASK)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/gi, MASK)
    .replace(KEYED, (m, v: string) => (/[0-9!@#$%^&*+=/_.-]/.test(v) ? MASK : m))
    .replace(/--(?:password|passwd|secret|token|api-key)[ =][^\s<]+/gi, MASK)
    .replace(/\b[12][0-9]{9}\b/g, (m) => (m === '2147483647' || m === '2147483648' ? m : MASK))
    .replace(/([a-z0-9._%+-]+)@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi, (m, local: string) => (SAFE_LOGINS.has(local.toLowerCase()) ? m : MASK))
    .replace(/\+[0-9][0-9 -]{8,}[0-9]|\b05[0-9]{8}\b/g, MASK);
}

/** The last `bytes` of a file as text. */
export function logTail(path: string, bytes = 1_048_576): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
