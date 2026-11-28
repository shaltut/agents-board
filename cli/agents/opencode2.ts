// What a 2.x seat needs before anything is delivered to it (#4817 slice 2). Pure: no database.
import { readFileSync } from 'node:fs';

/** The 2.x builds someone has watched call the guard's hook for a tool call (a blocked write, then a call that ran). The
 *  marker below shows the hook is in, not that OpenCode calls it, so a new build is added only after the same check. */
export const OPENCODE2_ACCEPTED: readonly string[] = ['2.2.0'];

/** `opencode2 --version` prints one line, `opencode v<version>`. Anything else is refused. */
export function opencode2VersionRefusal(printed: string): string | null {
  const version = /^opencode v(\S+)$/.exec(printed.trim())?.[1];
  if (version !== undefined && OPENCODE2_ACCEPTED.includes(version)) return null;
  return `this OpenCode 2.x build is not accepted (--version printed ${JSON.stringify(printed.trim().slice(0, 80))}; accepted: ${OPENCODE2_ACCEPTED.join(', ')}): check that it runs the guard's hook, then add it to OPENCODE2_ACCEPTED`;
}

/** Whether the guard plugin inside this launch's agent wrote its proof (kit/guard/opencode-plugin-v2.js prove()): the
 *  marker file holds the nonce the launch put in its env. No file, another nonce or unreadable text: not proven. */
export function guardProven(marker: string, nonce: string): boolean {
  if (!nonce) return false;
  try { return JSON.parse(readFileSync(marker, 'utf8'))?.nonce === nonce; } catch { return false; }
}
