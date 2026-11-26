// Claude Code SessionStart hook: hands this session's inbox to its seat's relay and starts the relay when none runs.
// The inbox ($CLAUDE_CODE_MESSAGING_SOCKET, _TOKEN) goes into the seat's endpoint file (cli/agents/claude.ts), so the
// relay (cli/relay.ts) needs no Claude in its own env, and a new Claude in the same pane is served by the same relay.
// A nested session (a `claude -p` run inside this pane) never takes the seat from a live session on another socket.
// Prints nothing and always exits 0: a hook must never fail its session. The token goes into that file only.
const { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token, HERDR_PANE_ID: pane } = process.env;
if (socket && token && pane) {
  try {
    const { spawn } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { machine } = await import('../server/db.ts');
    const { seatKey, seatLockHolder } = await import('../cli/bridge.ts');
    const { claudeAdapter, readClaudeEndpoint, writeClaudeEndpoint } = await import('../cli/agents/claude.ts');
    const m = machine();
    const ep = readClaudeEndpoint(m, pane);
    // same socket (a /clear, a resume) or a dead agent: this session takes the seat; an unknown answer counts as alive
    if (!ep || ep.socket === socket || !(await claudeAdapter.isAlive({ machine: m, pane, agent: 'claude' }).catch(() => true)))
      writeClaudeEndpoint(m, pane, { socket, token, pid: process.ppid });
    // a relay holds the seat while its lock is fresh and its pid answers (cli/bridge.ts seatLockHolder)
    if (!seatLockHolder(join(tmpdir(), `cb-relay-${seatKey(m, pane)}.pid`)))
      spawn(process.execPath, [join(import.meta.dirname, '..', 'cli', 'relay.ts'), '--pane', pane, '--agent', 'claude'],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}
process.exit(0);
