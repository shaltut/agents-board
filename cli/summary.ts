// Runner summaries: turn a job's log into a short, masked board summary. Pure apart from logTail's file read.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const MAX = 1000;
const MAX_NAMES = 5;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export const cut = (s: string, max = MAX) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

function shape(counts: { passed: number; failed: number; skipped: number }, names: string[]) {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  let text = `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped.`;
  if (counts.failed > 0 || unique.length) {
    const shown = unique.slice(0, MAX_NAMES).join('; ');
    const more = unique.length > MAX_NAMES ? `; and ${unique.length - MAX_NAMES} more` : '';
    text += ` Failing: ${shown}${more}`;
  }
  return { text: cut(text), ran: counts.passed + counts.failed };
}

/** The board summary for a log: counts and failing names for node:test / TAP / vitest, else the last 3 lines that are not code frames. */
export function summarize(output: string): { text: string; ran: number | null } {
  // each line is cut to 2000 chars so the per-line regexes below cannot backtrack on a megabyte line
  const lines = output.replace(ANSI, '').split(/\r?\n/).map((l) => l.slice(0, 2000));

  const vt = lines.map((l) => /^\s*Tests\s+(\d+ (?:failed|passed|skipped|todo)\b.*|no tests)\s*$/.exec(l)?.[1]).filter((v): v is string => v !== undefined).at(-1);
  if (vt !== undefined) {
    const n = (w: string) => Number(new RegExp(`(\\d+) ${w}\\b`).exec(vt)?.[1] ?? 0);
    const names = lines.flatMap((l) => /^\s*FAIL\s+(.+?)\s*$/.exec(l)?.[1] ?? []);
    return shape({ passed: n('passed'), failed: n('failed'), skipped: n('skipped') }, names);
  }

  const c: Record<string, number> = {};
  const names: string[] = [];
  for (const l of lines) {
    const m = /^\s*(?:\S{1,4}\s+)?(pass|fail|skipped)\s+(\d+)\s*$/.exec(l);
    if (m) c[m[1]!] = Number(m[2]); // last occurrence wins
    const name = /^\s*✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/.exec(l)?.[1] ?? /^\s*not ok \d+ - (.+?)(?:\s+#.*)?\s*$/.exec(l)?.[1];
    if (name) names.push(name);
  }
  if (c.pass !== undefined || c.fail !== undefined || c.skipped !== undefined) {
    return shape({ passed: c.pass ?? 0, failed: c.fail ?? 0, skipped: c.skipped ?? 0 }, names);
  }

  // code-frame lines (a linted file's source) stay off the board
  const frame = /^\s*(?:\d+\s*[│|]|[·│╭╰─])/;
  return { text: cut(lines.filter((l) => l.trim() && !frame.test(l)).slice(-3).join('\n')), ran: null };
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
