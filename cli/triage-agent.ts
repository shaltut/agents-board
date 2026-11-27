// cb triage's judge (#4535): one headless model call on this machine that reads a copy of the claude-board code
// (exportTree: tracked files only, so never the board's .env) and returns a
// verdict per fault group, checked against a JSON schema. It cannot write: Read, Grep and Glob only, no shell, no MCP
// server, no settings (so no hooks: a Stop hook would report to the board), no board access. Ahmed's Q3000: Claude
// Opus by default. cb (cli/triage.ts) does every board read and write itself.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

export const DEFAULT_MODEL = 'opus';
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

// The child's environment is an allow-list, never inherited: no HERDR_* (the child must not look like a session in this
// seat to the relay or the hooks), no CB_* and no database URL, no session socket.
const KEEP = ['PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'CLAUDE_CONFIG_DIR'];
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(KEEP.filter((k) => typeof env[k] === 'string').map((k) => [k, env[k]!]));
}

export function claudeArgs(o: { model: string; budget: number; schema: object; board: string }) {
  return ['-p', '--model', o.model, '--tools', 'Read,Grep,Glob', '--json-schema', JSON.stringify(o.schema),
    '--output-format', 'json', '--max-budget-usd', o.budget.toFixed(2), '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', `${o.board.replace(/[\\/]+$/, '')}/kit/mcp/none.json`,
    '--setting-sources', '', '--disable-slash-commands'];
}

// What the judge may read: the code and its docs, never deploy/ (env templates) or anything outside these.
export const JUDGE_PATHS = ['bin', 'cli', 'db', 'prompts', 'server', 'hooks', 'kit', 'docs', 'CLAUDE.md', 'README.md'];
const SECRET = /(?:^|[\\/])(?:\.env[^\\/]*|[^\\/]*\.(?:pem|key|p12|pfx|keystore|jks)|id_[a-z0-9]+|[^\\/]*(?:credential|secret|token|passw|apikey|api[-_]key)[^\\/]*|\.npmrc|\.netrc|\.pgpass)$/i;

/** A temporary copy of the tracked code for the judge to run in (#4535 review I2). A checkout's root holds the board's
 *  .env, and Read needs no approval inside the working folder, while the prompt carries untrusted card titles. In a
 *  git checkout only tracked files are copied (git ls-files: no .env, no untracked scratch); a release copy holds only
 *  release files. Secret-shaped names are skipped either way, and so is anything that is not a regular file inside
 *  the board: symlinks (git mode 120000), junctions, and files reached through one (review I-r2). The caller removes
 *  the folder. */
export function exportTree(board: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cb-judge-'));
  let root: string;
  try { root = realpathSync.native(board); } catch { return dir; }
  const files: string[] = [];
  // -s gives each entry's mode: 120000 is a symlink, 160000 a submodule; neither is copied (review I-r2)
  const git = existsSync(join(board, '.git')) ? spawnSync('git', ['-C', board, 'ls-files', '-s', '-z', '--', ...JUDGE_PATHS], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }) : null;
  if (git?.status === 0) {
    for (const e of git.stdout.split('\0')) {
      const m = /^(\d{6}) [0-9a-f]+ \d+\t([^]+)$/.exec(e);
      if (m && m[1] !== '120000' && m[1] !== '160000') files.push(m[2]!);
    }
  } else {
    // lstat: a symlink or junction is never followed, so the walk stays inside the copy
    const walk = (p: string): void => {
      let st; try { st = lstatSync(p); } catch { return; }
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) { for (const n of readdirSync(p)) if (n !== 'node_modules' && n !== '.git') walk(join(p, n)); }
      else if (st.isFile()) files.push(relative(board, p));
    };
    for (const p of JUDGE_PATHS) walk(join(board, p));
  }
  const inside = root.endsWith(sep) ? root : root + sep;
  for (const f of files) {
    if (SECRET.test(f)) continue;
    const src = join(board, f);
    try {
      // a regular file whose real path is inside the board: a link anywhere on the way (a junction folder git
      // walked into) resolves outside and is skipped
      if (!lstatSync(src).isFile()) continue;
      const real = realpathSync.native(src);
      if (!real.startsWith(inside)) continue;
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(real, join(dir, f));
    } catch {}
  }
  return dir;
}

export type Judged = { ok: true; groups: unknown; cost: number | null; ms: number } | { ok: false; error: string; cost: number | null; ms: number };

/** Runs the judge once. CB_TRIAGE_AGENT_CMD (tests) names a node script to run instead of claude, with the same
 *  arguments and stdin. The prompt goes on stdin, never in an argument (the process list). */
export function runJudge(o: { prompt: string; schema: object; model: string; budget: number; board: string; timeoutMs?: number }): Judged {
  const cwd = exportTree(o.board);
  const args = claudeArgs({ ...o, board: cwd });
  const fake = process.env.CB_TRIAGE_AGENT_CMD;
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync(fake ? process.execPath : 'claude', fake ? [fake, ...args] : args, {
      input: o.prompt, cwd, env: childEnv(), encoding: 'utf8', windowsHide: true,
      timeout: o.timeoutMs ?? (Number(process.env.CB_TRIAGE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS), maxBuffer: 16 * 1024 * 1024,
    });
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
  const ms = Date.now() - t0;
  if ((r.error as any)?.code === 'ETIMEDOUT') return { ok: false, error: `the judge did not finish within ${Math.round((o.timeoutMs ?? (Number(process.env.CB_TRIAGE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)) / 1000)} s`, cost: null, ms };
  if ((r.error as any)?.code === 'ENOENT') return { ok: false, error: 'claude is not installed on this machine (or not on PATH)', cost: null, ms };
  if (r.error) return { ok: false, error: `the judge could not start (${(r.error as any).code ?? 'error'})`, cost: null, ms };
  let j: any;
  try { j = JSON.parse(r.stdout); } catch { return { ok: false, error: `the judge exited ${r.status} without its JSON answer`, cost: null, ms }; }
  const cost = typeof j?.total_cost_usd === 'number' ? j.total_cost_usd : null;
  // the budget cap, a turn limit or an API error end the run with is_error and a subtype naming why
  if (r.status !== 0 || j?.is_error || (j?.subtype && j.subtype !== 'success'))
    return { ok: false, error: `the judge stopped: ${/^[\w-]{1,40}$/.test(String(j?.subtype)) ? j.subtype : `exit ${r.status}`}`, cost, ms };
  let groups = j?.structured_output;
  if (groups == null && typeof j?.result === 'string') try { groups = JSON.parse(j.result); } catch {}
  if (groups == null) return { ok: false, error: 'the judge gave no structured answer', cost, ms };
  return { ok: true, groups, cost, ms };
}
