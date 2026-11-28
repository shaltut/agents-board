// Which heredoc bodies the guard drops as text. In each command here a shell runs the body, so it must be judged.
// Pure: only evaluate(), nothing runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../kit/guard/core.mjs';

test('a heredoc body a shell runs is judged, whatever the words before the marker look like', () => {
  const allowed = [
    // a ; inside quotes: the text after it reads as a cb command, and the quoted script's shell reads the heredoc
    `bash -c "bash; cb x" <<'EOF'`,
    // cat writes to its own output, which the pipe sends on to a shell
    "cat > /dev/stdout <<'EOF' | bash",
  ].filter((head) => evaluate({ tool: 'shell', command: `${head}\nunset CB_ROLE\nEOF`, role: 'builder' }).allow);
  assert.deepEqual(allowed, []);
});
