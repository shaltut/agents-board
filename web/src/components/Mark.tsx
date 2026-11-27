import { useEffect } from 'react'
import { cn } from '@/lib/utils'
import { MARK, markSvg, tabTitle } from '@/lib/brand'

/** The mark (lib/brand.ts): two brackets with the call lamp between them. Same geometry as public/favicon.svg. */
export function Mark({ lit = true, className }: { lit?: boolean; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-6 shrink-0 [&>svg]:size-full', className)}
    dangerouslySetInnerHTML={{ __html: markSvg(lit ? MARK.lamp : MARK.clear) }} />
}

/** The browser tab shows the same lamp and the count, so a background tab tells Ahmed whether anyone is holding. */
export function useTabLamp(waiting: number) {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link) link.href = `data:image/svg+xml,${encodeURIComponent(markSvg(waiting > 0 ? MARK.lamp : MARK.clear))}`
    document.title = tabTitle(waiting)
  }, [waiting])
}
