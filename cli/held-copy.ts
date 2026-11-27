// #3221, #4630: the relay's copy of the messages, broadcasts and memory changes of the read it last held. The board keeps
// a hold only for the same name, project and session; when another agent process takes the pane (a new session id: the
// board starts the row again), the copy is all that is left. It waits (an orphan) until that session binds: under the
// same name it is pushed, under another it is dropped. #4630: it outlives the relay, in the seat's held file, since the
// usual restart order (the old agent dies, its relay leaves about 4 s later, the new agent starts after that) put it out
// of reach. Pure, but for the file helpers.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { HOLD_MS } from './notice-hold.ts';

export type HeldCopy = { actor: string; project: unknown; sid: string | null; messages: any[]; broadcasts: any[]; memory: any[]; at: number };

export const copyCount = (cs: (HeldCopy | undefined)[]) => cs.reduce((n, c) => n + (c ? c.messages.length + c.broadcasts.length + c.memory.length : 0), 0);

/** What a read does with the orphans: push (bound under the copy's name), keep (the row is not bound yet), drop (bound
 *  under another name: dropped counts them), or forget at once (the same session: the board kept the row and returns
 *  them; or older than the hold window, review 78 N2: expired counts them). Every copy is judged on its own (N3). */
export function sortOrphans(copies: HeldCopy[], i: { actor: unknown }, sid: string | null, seat: string, now: number) {
  const push: HeldCopy[] = [], keep: HeldCopy[] = [];
  let dropped = 0, expired = 0;
  for (const c of copies) {
    if (now - c.at > HOLD_MS) expired += copyCount([c]);
    else if (c.sid === sid) continue;
    else if (i.actor === c.actor) push.push(c);
    else if (i.actor === seat || /^session-[0-9a-f]{8}$/.test(String(i.actor))) keep.push(c);
    else dropped += copyCount([c]);
  }
  return { push, keep, dropped, expired };
}

const isCopy = (c: any): c is HeldCopy => c && typeof c.actor === 'string' && (c.sid === null || typeof c.sid === 'string')
  && Array.isArray(c.messages) && Array.isArray(c.broadcasts) && Array.isArray(c.memory) && typeof c.at === 'number';

/** Leaves the copies for the next relay in the pane (owner only: they are the seat's notices). None: no file. */
export function writeCopies(file: string, copies: HeldCopy[]) {
  if (!copies.length) { rmSync(file, { force: true }); return; }
  rmSync(file, { force: true }); // a new file, so the mode applies
  writeFileSync(file, JSON.stringify(copies), { mode: 0o600 });
}

/** The copies the last relay left, once (the file goes), without the ones past the hold window. A bad file is none. */
export function readCopies(file: string, now: number): HeldCopy[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { raw = []; }
  rmSync(file, { force: true });
  return Array.isArray(raw) ? raw.filter(isCopy).filter((c) => now - c.at <= HOLD_MS) : [];
}
