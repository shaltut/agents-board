// DO NOT copy alone; deploy with node kit/guard/install.mjs
// Checkout-only compatibility entrypoint (#4002). The rules live in kit/guard/core.mjs and the Claude hook in
// kit/guard/shim-claude.mjs; this file re-exports stripMessages, check and protectedPush (test/dangerous.test.ts) and
// still runs as a hook from the checkout: node kit/hooks/block-dangerous.mjs < hook-input.json.
// Both modules load dynamically: copied without ../guard/, it prints a block for every command instead of failing open.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let core = null;
let shim = null;
let loadErr = null;
try {
  core = await import('../guard/core.mjs');
  shim = await import('../guard/shim-claude.mjs');
} catch (e) {
  loadErr = e;
}

const loaded = () => {
  if (loadErr) throw loadErr;
  return core;
};
export const stripMessages = (cmd) => loaded().stripMessages(cmd);
export const check = (command) => loaded().check(command);
export const protectedPush = (cmd, list) => loaded().protectedPush(cmd, list);

// realpath: a symlinked or junction install must still run as the hook (import.meta.url is the real path).
let main = false;
if (process.argv[1]) {
  try {
    main = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    main = import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  }
}
if (main) {
  let out;
  try {
    out = loadErr
      ? { decision: 'block', reason: `Blocked: guard failed to load core (${String(loadErr?.message ?? loadErr).replace(/\s+/g, ' ').slice(0, 200)})` }
      : shim.runClaudeShim(readFileSync(0, 'utf8'), process.env);
  } catch (e) {
    out = { decision: 'block', reason: `Blocked: guard could not read hook input (${String(e?.message ?? e).slice(0, 200)})` };
  }
  process.stdout.write(JSON.stringify(out));
}
