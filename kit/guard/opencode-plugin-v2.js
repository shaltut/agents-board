// The board's guard plugin for OpenCode 2.x (#4817). 2.x never runs a 1.x plugin (cb-guard.js), so node
// kit/guard/install.mjs --agents opencode writes this beside it, as cb-guard-v2.js, with NODE and SHIM filled in (the
// installed guard, never the checkout). The execute.before hook sends EVERY tool call to the shim as
// {"tool","args","sessionID"} on stdin, with the env of the OpenCode server it runs in, and throws to stop the call:
// the model gets the reason as the tool's error. It fails closed: the shim not starting, exiting non-zero, timing out
// or printing anything other than {} (allow) or {"decision":"block","reason":...} stops the call. As written here (not
// installed) NODE is no program, so it blocks. judge() is cb-guard.js's: each file is installed on its own.
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

export default {
  id: 'cb-guard',
  // OpenCode 1.x loads this folder too and reads server() from a default export: no hooks there, cb-guard.js guards it
  server: async () => ({}),
  async setup(ctx) {
    await ctx.tool.hook('execute.before', (event) => {
      const why = judge(event?.tool, event?.input, event?.sessionID);
      if (why !== null) throw new Error(why);
    });
  },
};
