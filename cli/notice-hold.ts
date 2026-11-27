// #3221: the relay holds routine notices up to HOLD_MS and delivers them together in one push (Ahmed, Q2997), so a
// stream of runner results and GitHub lines wakes an idle session once instead of once per line. Anything important
// goes at once and takes everything held with it, in the board's order. Runner results still arrive one message (one
// line) per job (Q2996): only the push that carries them is shared.
// The hold lives on the board (cb.relay_hold): held messages, broadcasts and huddle lines stay past broadcast_seen and
// held memory changes past the cursor the board keeps in hold_from, so a relay that restarts mid-hold reads them again
// and delivers them once; the window's clock is hold_at, so a restart does not start it again.
// Card events are never held (review I1): the board returns one only while the card is still the seat's, so an event
// held while the card changed hands would never come back.
// Pure, like settle.ts: the relay hands it the inbox it read (after its own filters and the Next-offer settle).

export const HOLD_MS = 10 * 60_000; // Q2997: a low-priority notice may wait up to 10 minutes

// Each test below says "low"; anything it cannot place (an unknown sender or kind, a field an older board does not
// send) is important and delivered at once.

/** The runner's job results, the GitHub watch, and the board's routine digests and nudges (the inbox marks them
 *  `notice`; a digest with a new P0 or a supervisor problem is not marked). Never Ahmed, a session, the supervisor;
 *  never one the inbox marks `urgent` (about a P0 card, a part freed off the seat, GitHub lines by Ahmed's login). */
export const lowMessage = (m: any) =>
  !m.raw && m.urgent !== true
  && (m.actor === 'runner' || m.actor === 'github' || (m.actor === 'board' && typeof m.notice === 'string'));

/** A broadcast or a shared-memory change by anyone but Ahmed. */
export const lowNotice = (x: any) => typeof x.actor === 'string' && x.actor !== 'ahmed';

export type HoldStep = { action: 'none' | 'deliver' | 'hold'; low: number; wait: number | null };

/** What the relay does with one read. typed: Ahmed's dashboard text (taken out of messages before this).
 *  none: nothing to push. deliver: push everything now (something important, the window is over, or a board that
 *  keeps no holds: its inbox has no `hold` key). hold: push nothing, read again in `wait` ms. */
export function holdStep(i: any, typed: unknown[], holdMs = HOLD_MS): HoldStep {
  const lists = { messages: i.messages ?? [], broadcasts: i.broadcasts ?? [], memory: i.memory ?? [] };
  const low = lists.messages.filter(lowMessage).length + lists.broadcasts.filter(lowNotice).length + lists.memory.filter(lowNotice).length;
  const all = lists.messages.length + lists.broadcasts.length + lists.memory.length;
  const urgent = all > low || typed.length > 0
    || [i.events, i.asks, i.answers, i.sent_back, i.answer_copies, i.bugs, i.huddles, i.next_work].some((l) => (l?.length ?? 0) > 0);
  if (urgent) return { action: 'deliver', low, wait: null };
  if (!low) return { action: 'none', low, wait: null };
  if (!('hold' in i)) return { action: 'deliver', low, wait: null };
  const age = Math.max(0, Number(i.hold?.age_ms) || 0);
  return age >= holdMs ? { action: 'deliver', low, wait: null } : { action: 'hold', low, wait: holdMs - age };
}
