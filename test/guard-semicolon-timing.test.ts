// #4834 review: how the time grows with a long run of ;. Pure: only evaluate() and stripMessages(), nothing runs.
// Prints the best of three for each shape and size; the review's row is judged in guard.test.ts.
import { test } from 'node:test';
import { evaluate, stripMessages } from '../kit/guard/core.mjs';

test('timings of a run of ;', () => {
  const best = (fn: (pad: string) => unknown) => Math.round(Math.min(...[1, 2, 3].map((n) => {
    const from = performance.now();
    fn(' '.repeat(n)); // a new string each time: the last stripped text is cached
    return performance.now() - from;
  })));
  const shapes: [string, (n: number) => string][] = [
    ['no heredoc', (n) => ';'.repeat(n)],
    ['then a heredoc', (n) => `${';'.repeat(n)}\ncat > f <<'EOF'\nx\nEOF`],
    ['on the heredoc line', (n) => `${';'.repeat(n)} cat > f <<'EOF'\nx\nEOF`],
  ];
  for (const [name, make] of shapes) {
    for (const n of [200_000, 600_000]) {
      const command = make(n);
      console.log(`TIMING ${name} ${n / 1000}KB: evaluate ${best((p) => evaluate({ tool: 'shell', command: command + p, role: 'builder' }))} ms, stripMessages ${best((p) => stripMessages(command + p))} ms`);
    }
  }
});
