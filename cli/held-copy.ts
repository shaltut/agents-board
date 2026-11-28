// #3221, #4630: the relay's copy of the messages, broadcasts and memory changes of the read it last held. The board keeps
// a hold only for the same name, project and session; when another agent process takes the pane (a new session id: the
// board starts the row again), the copy is all that is left. It waits (an orphan) until that session binds: under the
// same name it is pushed, under another it is dropped. #4630: it outlives the relay, in the seat's held file, since the
// usual restart order (the old agent dies, its relay leaves about 4 s later, the new agent starts after that) put it out
// of reach. Pure, but for the file helpers.
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOLD_MS } from './notice-hold.ts';

// events: held card lines (#3221 settle window); a copy a relay from before them left has none. at: when its oldest line
// on a clock was first held (holdStep's since, review 106 N2-a), never the last held read, which the 30 s poll renews.
export type HeldCopy = { actor: string; project: unknown; sid: string | null; messages: any[]; broadcasts: any[]; memory: any[]; events?: any[]; at: number };

export const copyCount = (cs: (HeldCopy | undefined)[]) =>
  cs.reduce((n, c) => n + (c ? c.messages.length + c.broadcasts.length + c.memory.length + (c.events?.length ?? 0) : 0), 0);

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
  && Array.isArray(c.messages) && Array.isArray(c.broadcasts) && Array.isArray(c.memory) && typeof c.at === 'number'
  && (c.events === undefined || Array.isArray(c.events));

/** Leaves the copies for the next relay in the pane (owner only: they are the seat's notices). None: no file. */
export function writeCopies(file: string, copies: HeldCopy[]) {
  if (!copies.length) { rmSync(file, { force: true }); return; }
  rmSync(file, { force: true }); // a new file, so the mode applies; wx: never through a link planted meanwhile (review 106 L3)
  writeFileSync(file, JSON.stringify(copies), { mode: 0o600, flag: 'wx' });
}

/** The copies the last relay left, once (the file goes), without the ones past the hold window. A bad file is none. */
export function readCopies(file: string, now: number): HeldCopy[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { raw = []; }
  rmSync(file, { force: true });
  return Array.isArray(raw) ? raw.filter(isCopy).filter((c) => now - c.at <= HOLD_MS) : [];
}

/** Review 106 L2: removes the held files in dir older than the hold window. herdr never reuses a pane id, so a seat
 *  restarted in a new pane leaves its file unread; nothing in one that old would be pushed anyway. */
export function sweepHeld(dir: string, now: number) {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!/^cb-relay-.+\.held$/.test(n)) continue;
    try { if (now - statSync(join(dir, n)).mtimeMs > HOLD_MS) rmSync(join(dir, n), { force: true }); } catch {}
  }
}
