// cb triage's judge (#4535): one headless model call on this machine that reads the claude-board code and returns a
// verdict per fault group, checked against a JSON schema. It cannot write: Read, Grep and Glob only, no shell, no MCP
// server, no settings (so no hooks: a Stop hook would report to the board), no board access. Ahmed's Q3000: Claude
// Opus by default. cb (cli/triage.ts) does every board read and write itself.
import { spawnSync } from 'node:child_process';

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

export type Judged = { ok: true; groups: unknown; cost: number | null; ms: number } | { ok: false; error: string; cost: number | null; ms: number };

/** Runs the judge once. CB_TRIAGE_AGENT_CMD (tests) names a node script to run instead of claude, with the same
 *  arguments and stdin. The prompt goes on stdin, never in an argument (the process list). */
export function runJudge(o: { prompt: string; schema: object; model: string; budget: number; board: string; timeoutMs?: number }): Judged {
  const args = claudeArgs(o);
  const fake = process.env.CB_TRIAGE_AGENT_CMD;
  const t0 = Date.now();
  const r = spawnSync(fake ? process.execPath : 'claude', fake ? [fake, ...args] : args, {
    input: o.prompt, cwd: o.board, env: childEnv(), encoding: 'utf8', windowsHide: true,
    timeout: o.timeoutMs ?? (Number(process.env.CB_TRIAGE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS), maxBuffer: 16 * 1024 * 1024,
  });
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
