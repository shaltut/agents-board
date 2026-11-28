// #3221: the relay holds lines that can wait and delivers them together in one push, so a stream of them wakes an idle
// session once instead of once per line. Two kinds of wait, each counted from the first line of its kind:
//   - routine notices wait HOLD_MS (Ahmed, Q2997): runner results (still one line per job, Q2996), GitHub lines, the
//     board's routine digests and nudges, and broadcasts and memory changes not from Ahmed;
//   - session lines wait SETTLE_WINDOW_MS (Q3128): a teammate's tell, a card notice, a bug to triage, a Next offer.
// A "closed" card notice never wakes a session by itself: it goes with the next push.
// Urgent lines go at once and take everything held with them, in the board's order: answers, Ahmed's asks, typing and
// huddles, the supervisor, anything about P0, and what the inbox marks `urgent` (a direct question, a person's line, a
// card cancelled, blocked or taken off the seat, a part freed off it, GitHub lines by Ahmed's login).
// The hold lives on the board (cb.relay_hold): held messages, broadcasts and huddle lines stay past broadcast_seen and
// held memory changes past the cursor the board keeps in hold_from, so a relay that restarts mid-hold reads them again
// and delivers them once. Card lines come back only while the card is still the seat's (review I1), so the relay also
// keeps the ones it holds (cli/held-copy.ts).
// Pure, like settle.ts: the relay hands it the inbox it read (after its own filters and the Next-offer settle).

export const HOLD_MS = 10 * 60_000;      // Q2997: a routine notice may wait up to 10 minutes
export const SETTLE_WINDOW_MS = 120_000; // Q3128: a session's line may wait this long for company

// Each test below says a line may wait; anything it cannot place (an unknown sender or kind, a field an older board
// does not send) is urgent and delivered at once.

/** The runner's job results, the GitHub watch, and the board's routine digests and nudges (the inbox marks them
 *  `notice`; a digest with a new P0 or a supervisor problem is not marked). Never Ahmed, a session, the supervisor;
 *  never one the inbox marks `urgent`. */
export const lowMessage = (m: any) =>
  !m.raw && m.urgent !== true
  && (m.actor === 'runner' || m.actor === 'github' || (m.actor === 'board' && typeof m.notice === 'string'));

/** A broadcast or a shared-memory change by anyone but Ahmed, or another person the inbox marks `urgent`. */
export const lowNotice = (x: any) => typeof x.actor === 'string' && x.actor !== 'ahmed' && x.urgent !== true;

type Wait = 'now' | 'settle' | 'low' | 'ride';
const NOT_SESSIONS = ['ahmed', 'board', 'github', 'runner', 'supervisor'];
const CARD_LINES = ['note', 'moved', 'updated', 'task_created'];
const messageWait = (m: any): Wait => lowMessage(m) ? 'low'
  : m.urgent === false && !m.raw && typeof m.actor === 'string' && !NOT_SESSIONS.includes(m.actor) ? 'settle' : 'now';
const noticeWait = (x: any): Wait => lowNotice(x) ? 'low' : 'now';
// ride: no clock of its own
const eventWait = (e: any): Wait => e.urgent !== false ? 'now' : e.kind === 'done' ? 'ride' : CARD_LINES.includes(e.kind) ? 'settle' : 'now';
const cardWait = (t: any): Wait => typeof t.priority === 'string' && t.priority !== 'P0' && t.actor !== 'ahmed' && t.urgent !== true ? 'settle' : 'now';

/** When this relay first saw each held line. fresh: no read judged yet, so a hold already on the board is a relay's
 *  before this one, and what this read has is as old as that hold. */
export type HoldClock = { seen: Map<string, number>; now: number; fresh: boolean };

export type HoldStep = { action: 'none' | 'deliver' | 'hold'; held: number; wait: number | null; since: number };

/** What the relay does with one read. typed: Ahmed's dashboard text (taken out of messages before this).
 *  none: nothing to push. deliver: push everything now (something urgent, a window is over, or a board that keeps no
 *  holds: its inbox has no `hold` key). hold: push nothing, read again in `wait` ms (null: nothing held has a clock).
 *  since: when the oldest held line on a clock was first seen; with none, the oldest "closed" notice (so later reads
 *  do not renew it); else now. The caller clears the clock once it has pushed, so a failed push keeps its lines' age. */
export function holdStep(i: any, typed: unknown[], clock: HoldClock = { seen: new Map(), now: Date.now(), fresh: true },
                         settleMs = SETTLE_WINDOW_MS): HoldStep {
  const of = (list: any[] | undefined, key: string, wait: (x: any) => Wait, id = 'id') =>
    (list ?? []).map((x) => ({ key: `${key}${x[id]}`, wait: wait(x) }));
  const lines = [
    ...of(i.messages, 'm', messageWait), ...of(i.broadcasts, 'b', noticeWait), ...of(i.memory, 'x', noticeWait),
    ...of(i.events, 'e', eventWait), ...of(i.bugs, 'g', cardWait, 'event_id'), ...of(i.next_work, 'w', cardWait),
  ];
  const start = clock.fresh && i.hold ? clock.now - Math.max(0, Number(i.hold.age_ms) || 0) : clock.now;
  clock.fresh = false;
  let clocked: number | null = null, riding: number | null = null, due: number | null = null;
  const least = (a: number | null, b: number) => a === null ? b : Math.min(a, b);
  for (const l of lines) {
    if (!clock.seen.has(l.key)) clock.seen.set(l.key, start);
    const first = clock.seen.get(l.key)!;
    if (l.wait === 'ride') riding = least(riding, first);
    if (l.wait !== 'settle' && l.wait !== 'low') continue;
    clocked = least(clocked, first);
    due = least(due, first + (l.wait === 'low' ? HOLD_MS : settleMs));
  }
  const since = clocked ?? riding ?? clock.now;
  const held = lines.filter((l) => l.wait !== 'now').length;
  const urgent = held < lines.length || typed.length > 0
    || [i.asks, i.answers, i.sent_back, i.answer_copies, i.huddles].some((l) => (l?.length ?? 0) > 0);
  const deliver: HoldStep = { action: 'deliver', held, wait: null, since };
  if (urgent) return deliver;
  if (!lines.length) { clock.seen.clear(); return { action: 'none', held: 0, wait: null, since }; }
  if (!('hold' in i) || (due !== null && due <= clock.now)) return deliver;
  return { action: 'hold', held, wait: due === null ? null : due - clock.now, since };
}

/** This read's card lines with the ones held from earlier reads that the board no longer returns, in the board's order. */
export function keepLines(read: any[], held: any[]): any[] {
  const have = new Set(read.map((e) => Number(e.id)));
  return [...read, ...held.filter((e) => !have.has(Number(e.id)))].sort((a, b) => Number(a.id) - Number(b.id));
}
