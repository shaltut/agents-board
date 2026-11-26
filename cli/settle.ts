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
