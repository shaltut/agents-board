// The product's name and mark (#4531). Pure: test/brand.test.ts imports it, and public/favicon.svg is pinned to markSvg.

export const NAME = 'Agents Board'

/** The mark's own colours, the same in both themes: a graphite tile, paper brackets and the dark theme's lamp and clear
 *  (an SVG data URI in the browser tab cannot read the page's CSS tokens, so the mark carries its hexes here, once). */
export const MARK = { tile: '#14201F', strip: '#E3EBE8', lamp: '#FFB43C', clear: '#4FD69C' } as const

/** The mark: two strip brackets with the call lamp between them. Amber lamp = something waits on Ahmed; green = all clear. */
export const markSvg = (lamp: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${MARK.tile}"/><g fill="${MARK.strip}"><rect x="6" y="6" width="5" height="20" rx="2.5"/><rect x="6" y="6" width="7.5" height="5" rx="2.5"/><rect x="6" y="21" width="7.5" height="5" rx="2.5"/><rect x="21" y="6" width="5" height="20" rx="2.5"/><rect x="18.5" y="6" width="7.5" height="5" rx="2.5"/><rect x="18.5" y="21" width="7.5" height="5" rx="2.5"/></g><circle cx="16" cy="16" r="4.6" fill="${lamp}"/></svg>`

/** The browser tab: the count of what waits, then the name. */
export const tabTitle = (waiting: number) => (waiting > 0 ? `(${waiting}) ${NAME}` : NAME)
