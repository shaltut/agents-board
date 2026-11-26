// Claude Code SessionStart hook: one line that points a new session at the board.
// Separate from the relay hook (cli/relay.ts), so changing this never restarts live relays.
// Only herdr panes get it: board sessions always run in one.
import { homedir } from 'node:os';
import { join } from 'node:path';

if (process.env.HERDR_PANE_ID) {
  let context = 'Claude Board: if this session takes work from the board, run `cb start` first and do what it prints. Manual: `cb help`.';
  // #4348: a guard nothing runs fails open, silently. A static look at the wiring (no probes: this runs at every start);
  // the fix is Ahmed's (~/.claude is inside the fence, #4345). Never let the check stop the hint.
  try {
    const { checkWiring } = await import('../kit/guard/install.mjs');
    const w = checkWiring(join(homedir(), '.claude', 'settings.json'), join(homedir(), '.claude-board', 'guard'), { probes: false });
    if (!w.ok) context += `\nGuard: ${w.problems[0]}. The command guard may not be running in this session: tell Ahmed with cb ask, and do not change ~/.claude yourself.`;
  } catch {}
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
}
