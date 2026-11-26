// Claude Code SessionStart hook: hands this session's inbox to its seat's relay and starts the relay when none runs.
// The inbox ($CLAUDE_CODE_MESSAGING_SOCKET, _TOKEN) goes into the seat's endpoint file (cli/agents/claude.ts), so the
// relay (cli/relay.ts) needs no Claude in its own env, and a new Claude in the same pane is served by the same relay.
// Prints nothing and always exits 0: a hook must never fail its session. The token goes into that file only.
const { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token, HERDR_PANE_ID: pane } = process.env;
if (socket && token && pane) {
  try {
    const { spawn } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { machine } = await import('../server/db.ts');
    const { seatKey } = await import('../cli/bridge.ts');
    const { writeClaudeEndpoint } = await import('../cli/agents/claude.ts');
    const m = machine();
    writeClaudeEndpoint(m, pane, { socket, token, pid: process.ppid });
    let running = false; // the seat's relay holds cli/relay.ts's lock file
    try {
      const pid = Number(readFileSync(join(tmpdir(), `cb-relay-${seatKey(m, pane)}.pid`), 'utf8'));
      if (pid > 0) { process.kill(pid, 0); running = true; }
    } catch {}
    if (!running)
      spawn(process.execPath, [join(import.meta.dirname, '..', 'cli', 'relay.ts'), '--pane', pane, '--agent', 'claude'],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}
process.exit(0);
