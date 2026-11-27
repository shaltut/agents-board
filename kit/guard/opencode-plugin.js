// The board's guard plugin for OpenCode (#4609). node kit/guard/install.mjs --agents opencode writes this file to
// <XDG_CONFIG_HOME or ~/.config>/opencode/plugins/cb-guard.js with NODE and SHIM filled in (the installed guard, never
// the checkout); OpenCode loads every file in that folder. tool.execute.before sends EVERY tool call to the shim as
// {"tool","args","sessionID"} on stdin, with the pane's env (CB_ROLE, CB_AGENT, ...), and throws to stop the call.
// It fails closed: the shim not starting, exiting non-zero, timing out or printing anything other than {} (allow) or
// {"decision":"block","reason":...} stops the call. The shim itself denies a tool it does not know. Exactly one export:
// OpenCode treats every exported function as a plugin. As written here (not installed) NODE is no program, so it blocks.
import { spawnSync } from 'node:child_process';

const NODE = "__CB_NODE__";
const SHIM = "__CB_SHIM__";
const TIMEOUT_MS = 15000;

// null to allow, else why the call is stopped
function judge(tool, args, sessionID) {
  const r = spawnSync(NODE, [SHIM], { input: JSON.stringify({ tool, args: args ?? {}, sessionID }), encoding: 'utf8', env: process.env, timeout: TIMEOUT_MS, windowsHide: true });
  if (r.error || r.status !== 0) return `Blocked: the board guard did not run (${r.error ? r.error.message : `exit ${r.status}`}): run node kit/guard/install.mjs --check --agents opencode`;
  let out;
  try { out = JSON.parse(String(r.stdout).trim()); } catch { return 'Blocked: the board guard printed something that is not its answer: run node kit/guard/install.mjs --check --agents opencode'; }
  if (out && typeof out === 'object' && !Array.isArray(out) && Object.keys(out).length === 0) return null;
  if (out?.decision === 'block' && typeof out.reason === 'string' && out.reason) return out.reason;
  return 'Blocked: the board guard gave no decision';
}

export const CbGuard = async () => ({
  'tool.execute.before': async (input, output) => {
    const why = judge(input?.tool, output?.args, input?.sessionID);
    if (why !== null) throw new Error(why);
  },
});
