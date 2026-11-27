// Today's one line on seats whose code is not the board's (#4352): cb.seats_code, through /api/today. Pure, so the
// node tests pin the words (test/code-sha.test.ts).

export type SeatsCode = { board: string; live: number; off: { machine: string; seats: number }[] }

/** "3 seats run other code than the board (abc1234): macbook 2, pc 1", or null when every live seat runs the board's
 *  code (or the board serves no release). "Other", not "older": a commit alone does not say which came first, and a
 *  checkout can be ahead of the board. A seat whose relay does not say its code counts as other. */
export function seatsCodeLine(c: SeatsCode | null | undefined): string | null {
  if (!c || !c.off.length) return null
  const n = c.off.reduce((s, m) => s + m.seats, 0)
  return `${n} ${n === 1 ? 'seat runs' : 'seats run'} other code than the board (${c.board.slice(0, 7)}): `
    + c.off.map((m) => `${m.machine} ${m.seats}`).join(', ')
}
