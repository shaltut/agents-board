import { useSyncExternalStore } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { href, navGroups, openPage, type Page, type Route } from '@/lib/route'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Kbd } from '@/components/ui/kbd'

// Below Tailwind's sm (640px) the group menus open as bottom sheets: big rows for a thumb, and every page in reach.
const PHONE = '(max-width: 639.98px)'
function usePhone() {
  return useSyncExternalStore((f) => { const m = matchMedia(PHONE); m.addEventListener('change', f); return () => m.removeEventListener('change', f) },
    () => matchMedia(PHONE).matches)
}

export const tabClass = (active: boolean) => cn('group flex h-8 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-sm sm:gap-2 sm:px-2.5 whitespace-nowrap transition-colors duration-150',
  active ? 'bg-raised font-medium text-foreground' : 'text-muted-foreground hover:bg-raised/60 hover:text-foreground')

/** Where a page link goes: the page fresh, keeping the project and the tag and type filters. */
const pageHref = (page: Page, route: Route) => href({ view: page.view, project: route.project, tag: route.tag, type: route.type })

/** A link to a page that opens it fresh on a plain click and leaves ctrl/shift/middle click to the browser (new tab). */
export function pageLink(page: Page, route: Route) {
  return {
    href: pageHref(page, route),
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
 *  arrows open it, Esc closes it and focus goes back to its button (Radix). On a phone it is a bottom sheet instead.
 *  The open page's group is highlighted and names the page; grey counts (Memory's proposals) ride on its button too. */
export function GroupMenus({ pages, route, counts }: { pages: readonly Page[]; route: Route; counts: Partial<Record<Page['view'], number>> }) {
  const phone = usePhone()
  return navGroups(pages, route.view).map((g) => {
    const count = g.pages.reduce((n, p) => n + (counts[p.view] ?? 0), 0)
    const label = (
      <>
        {/* phone: the group's name (the open page is marked inside the sheet); 640-1535px: the open page's name, so all
            seven items fit a 1280px row once Runners, Usage and Project settings land; from 1536px: "Team · Users" */}
        {g.current ? (
          <>
            <span className="sm:text-muted-foreground sm:max-2xl:sr-only">{g.label}<span className="max-sm:hidden"> ·</span></span>
            <span className="max-sm:sr-only">{g.current.label}</span>
          </>
        ) : g.label}
        {count > 0 && (
          <span className="text-[12px] font-semibold text-muted-foreground tabular-nums">
            {count}<span className="sr-only"> waiting for you</span>
          </span>
        )}
        {/* the chevron at every width: it is what says "this opens a menu" */}
        <ChevronDown aria-hidden className="size-3 text-muted-foreground sm:size-3.5" />
      </>
    )
    const trigger = cn(tabClass(!!g.current), 'gap-1 sm:gap-1.5 aria-expanded:bg-raised aria-expanded:text-foreground')
    if (phone) return (
      <Sheet key={g.id}>
        <SheetTrigger className={trigger}>{label}</SheetTrigger>
        <SheetContent side="bottom" className="max-h-[80dvh] gap-0 overflow-y-auto pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <SheetHeader className="pb-2">
            <SheetTitle>{g.label}</SheetTitle>
            <SheetDescription className="sr-only">Pages in {g.label}</SheetDescription>
          </SheetHeader>
          <nav aria-label={g.label} className="grid px-2 pb-2">
            {g.pages.map((p) => {
              const active = p === g.current
              const Icon = p.icon
              return (
                <SheetClose key={p.view} asChild>
                  <a href={pageHref(p, route)} aria-current={active ? 'page' : undefined}
                    className={cn('flex h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors hover:bg-raised/60', active && 'bg-raised font-medium')}>
                    <Icon className="size-4 text-muted-foreground" />
                    {p.label}
                    {(counts[p.view] ?? 0) > 0 && <span className="text-[12px] font-semibold text-muted-foreground tabular-nums">{counts[p.view]}</span>}
                  </a>
                </SheetClose>
              )
            })}
          </nav>
        </SheetContent>
      </Sheet>
    )
    return (
      <DropdownMenu key={g.id} modal={false}>
        <DropdownMenuTrigger className={trigger}>{label}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto min-w-52">
          {g.pages.map((p) => {
            const active = p === g.current
            const Icon = p.icon
            return (
              <DropdownMenuItem key={p.view} asChild className={cn('py-1.5', active && 'bg-raised font-medium')}>
                {/* a plain href: Radix closes the menu on select (a prevented click would keep it open); ctrl-click opens a tab */}
                <a href={pageHref(p, route)} aria-current={active ? 'page' : undefined}>
                  <Icon className="text-muted-foreground" />
                  {p.label}
                  {(counts[p.view] ?? 0) > 0 && <span className="text-[12px] font-semibold text-muted-foreground tabular-nums">{counts[p.view]}</span>}
                  <PageKeys page={p} />
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
