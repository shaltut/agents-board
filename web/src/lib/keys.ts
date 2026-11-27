type Target = { isContentEditable?: boolean; tagName?: string; closest?: (selector: string) => unknown } | null

/** Single-key shortcuts (1-9 and 0, g, c, /) stay quiet while you type, and while a menu or a select list has the
 *  keyboard: there the keys belong to the menu (typeahead, arrows), not to view switching. */
export function shortcutsOff(target: Target) {
  if (!target) return false
  if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName ?? '')) return true
  return !!target.closest?.('[role="menu"], [role="listbox"]')
}

/** How long after g the letter may come (the GitHub and Gmail pattern). */
export const CHORD_MS = 1200

/** g then a letter opens a page. `since`: when g was pressed, null when not waiting. The key after g is always used up
 *  (so g c never also opens a new task), whether or not it names a page this viewer may open. */
export function chord<V>(since: number | null, key: string, now: number, pages: readonly { view: V; g: string }[]):
  { since: number | null; used: boolean; view?: V } {
  if (since !== null && now - since <= CHORD_MS) {
    const view = pages.find((p) => p.g === key)?.view
    return view === undefined ? { since: null, used: true } : { since: null, used: true, view }
  }
  return key === 'g' ? { since: now, used: true } : { since: null, used: false }
}
