import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { href, navGroups, openPage, type Page, type Route } from '@/lib/route'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'

export const tabClass = (active: boolean) => cn('group flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm sm:px-2.5 whitespace-nowrap transition-colors duration-150',
  active ? 'bg-raised font-medium text-foreground' : 'text-muted-foreground hover:bg-raised/60 hover:text-foreground')

/** A link to a page that opens it fresh on a plain click and leaves ctrl/shift/middle click to the browser (new tab). */
export function pageLink(page: Page, route: Route) {
  return {
    href: href({ view: page.view, project: route.project, tag: route.tag }),
    onClick: (e: React.MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); openPage(page.view) },
  }
}

/** The page's keys as the menus show them: its number key (if it has one) and g then its letter. */
export function PageKeys({ page, className }: { page: Page; className?: string }) {
  return (
    <span className={cn('ml-auto flex items-center gap-1 pl-3', className)} aria-hidden>
      {page.digit && <Kbd>{page.digit}</Kbd>}
      <Kbd>g&nbsp;{page.g}</Kbd>
    </span>
  )
}

/** The header's group menus (Work, Team, Knowledge, Machines, Settings). A click menu, not hover: Enter, Space or the
 *  arrows open it, Esc closes it and focus goes back to its button (Radix). The open page's group names that page, so
 *  you can always see where you are; grey counts (Memory's proposals) ride on the group button too. */
export function GroupMenus({ pages, route, counts }: { pages: readonly Page[]; route: Route; counts: Partial<Record<Page['view'], number>> }) {
  return navGroups(pages, route.view).map((g) => {
    const count = g.pages.reduce((n, p) => n + (counts[p.view] ?? 0), 0)
    return (
      <DropdownMenu key={g.id} modal={false}>
        <DropdownMenuTrigger className={cn(tabClass(!!g.current), 'gap-1.5 aria-expanded:bg-raised aria-expanded:text-foreground')}>
          {/* below 1536px the button shows only the open page's name, so all seven items fit a 1280px row once Runners,
              Usage and Project settings land; screen readers still hear the group */}
          {g.current ? <><span className="text-muted-foreground max-2xl:sr-only">{g.label} ·</span>{g.current.label}</> : g.label}
          {count > 0 && (
            <span className="text-[12px] font-semibold text-muted-foreground tabular-nums">
              {count}<span className="sr-only"> waiting for you</span>
            </span>
          )}
          {/* below sm the chevrons go so Today, Board and the three groups fit 375px without scrolling */}
          <ChevronDown aria-hidden className="hidden size-3.5 text-muted-foreground sm:block" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto min-w-52">
          {g.pages.map((p) => {
            const active = p === g.current
            const Icon = p.icon
            return (
              <DropdownMenuItem key={p.view} asChild className={cn('py-2.5 sm:py-1.5', active && 'bg-raised font-medium')}>
                <a {...pageLink(p, route)} aria-current={active ? 'page' : undefined}>
                  <Icon className="text-muted-foreground" />
                  {p.label}
                  {(counts[p.view] ?? 0) > 0 && <span className="text-[12px] font-semibold text-muted-foreground tabular-nums">{counts[p.view]}</span>}
                  <PageKeys page={p} className="hidden sm:flex" />
                </a>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  })
}

/** After g: which letter opens which page, until the letter comes, Esc, or the time runs out. */
export function GoHint({ pages }: { pages: readonly Page[] }) {
  return (
    <div role="status" className="fixed right-4 bottom-4 z-50 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      <span className="font-medium">Go to:</span>{' '}
      {pages.map((p, i) => (
        <span key={p.view} className="whitespace-nowrap">{i > 0 && <span className="text-muted-foreground"> · </span>}<Kbd>{p.g}</Kbd> {p.label}</span>
      ))}
    </div>
  )
}
