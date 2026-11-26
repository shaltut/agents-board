// #4336: hold a "new work in Next" offer until it has settled. The lead often creates a card in Next and assigns it a
// few seconds later; offered in that gap, an idle builder is told to take a card that is someone else's by the time it
// looks. pending maps card id → the card and when the relay first saw it offered; due are the cards whose settle time
// has passed (each once: they leave pending), wait is how long until the next one is due (null: none pending). The
// caller re-checks due cards against the board before pushing them.
export type Work = { id: number; title: string; priority: string };

export function settleWork(pending: Map<number, { t: Work; at: number }>, offered: Work[], now: number, settleMs: number) {
  for (const t of offered) if (!pending.has(Number(t.id))) pending.set(Number(t.id), { t, at: now });
  const due: Work[] = [];
  let wait: number | null = null;
  for (const [id, p] of pending) {
    const left = p.at + settleMs - now;
    if (left <= 0) { due.push(p.t); pending.delete(id); }
    else wait = wait === null ? left : Math.min(wait, left);
  }
  return { due, wait };
}

// The relay's whole step (review I3), pure so it is testable: settle what the inbox offers, re-check what is due with
// stillOpen (cb.work_still_open), push only what the board still has open for this session. An unbound seat (no actor)
// settles nothing, so an offer is not used up before the seat binds (M2). A re-check that throws (a board without the
// function yet) offers what is due unchecked, as before, and never fails the relay's check.
export async function offerSettled(o: {
  pending: Map<number, { t: Work; at: number }>; offered: Work[]; now: number; settleMs: number; actor: string | null;
  stillOpen: (ids: number[]) => Promise<number[]>; log: (line: string) => void;
}): Promise<{ work: Work[]; wait: number | null }> {
  if (!o.actor) return { work: [], wait: null };
  const { due, wait } = settleWork(o.pending, o.offered, o.now, o.settleMs);
  if (!due.length) return { work: [], wait };
  let open: Set<number>;
  try { open = new Set((await o.stillOpen(due.map((t) => Number(t.id)))).map(Number)); }
  catch (e: any) { o.log(`next re-check failed (offered unchecked): ${e?.message ?? e}`); open = new Set(due.map((t) => Number(t.id))); }
  return { work: due.filter((t) => open.has(Number(t.id))), wait };
}
