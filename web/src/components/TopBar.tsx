import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAsks, useMemories, useProjects, useQuestions } from '@/lib/api'
import { replyIds } from '@/lib/asks'
import { headerPages, type Page, type Route } from '@/lib/route'
import { Kbd } from '@/components/ui/kbd'
import { ProjectSwitcher } from './ProjectSwitcher'
import { Mark, useTabLamp } from './Mark'
import { NAME } from '@/lib/brand'
import { RingToggle, ThemeToggle } from './ThemeToggle'
import { useRing } from '@/lib/ring'
import { Account, useWho } from './Account'
import { GroupMenus, pageLink, tabClass } from './NavMenus'

export function TopBar({ route, pages, live, onSearch }: { route: Route; pages: readonly Page[]; live: 'live' | 'reconnecting'; onSearch: () => void }) {
  const { data: all = [] } = useQuestions(route.project, 'open')
  // questions handed to Cai/Ana aren't waiting on Ahmed; nor are a disabled project's, until it is enabled (#4559, Q3019)
  const off = new Set((useProjects().data ?? []).filter((p) => p.state !== 'enabled').map((p) => p.slug))
  const open = all.filter((q) => !q.assigned_to && !off.has(q.project))
  const { data: mems = [] } = useMemories(route.project)
  const proposed = mems.filter((m) => m.status === 'proposed').length
  useTabLamp(open.length)
  // Ring on any project, not just the one in view: a new question should reach Ahmed wherever he is.
  const { data: everywhere } = useQuestions(undefined, 'open')
  useRing(everywhere?.filter((q) => !q.assigned_to).map((q) => q.id))
  // a session's reply to one of Ahmed's asks (#936) rings too, on any view
  const { data: asks } = useAsks(undefined)
  useRing(asks && replyIds(asks))
  const { data: who } = useWho()
  const nav = useRef<HTMLElement>(null)
  const more = useMoreToTheRight(nav, pages)

  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md backdrop-saturate-150">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-0 px-4 sm:px-6 lg:flex-nowrap">
        {/* the logo and the tools keep their width; the tabs and group menus are what gives way (they scroll) */}
        <a href="#/today" className="flex h-13 shrink-0 items-center gap-2.5 rounded-md whitespace-nowrap" aria-label={`${NAME}, go to Today`}>
          <Mark lit={open.length > 0} />
          <span className="hidden text-[15px] font-semibold tracking-tight [font-stretch:88%] sm:inline">{NAME}</span>
        </a>
        <span aria-hidden className="hidden h-5 w-px bg-border sm:block" />
        <ProjectSwitcher project={route.project} settings={pages.some((p) => p.view === 'settings')} />

        <nav ref={nav} className={cn("order-last -mx-4 flex w-[calc(100%+2rem)] items-center gap-0.5 overflow-x-auto border-t px-2 py-1.5 [scrollbar-width:none] sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-5 lg:order-none lg:mx-2 lg:w-auto lg:min-w-0 lg:border-t-0 lg:p-0",
          more && "[mask-image:linear-gradient(to_left,transparent,currentColor_3rem)]")} aria-label="Views">
          {headerPages(pages).map((t) => {
            const active = route.view === t.view || (t.view === 'today' && route.view === 'questions')
            return (
              <a key={t.view} {...pageLink(t, route)} aria-current={active ? 'page' : undefined} title={`${t.label} (${t.digit}, or g then ${t.g})`}
                className={tabClass(active)}>
                <span aria-hidden className={cn('callsign hidden w-2 text-[11px] text-muted-foreground/70 xl:inline', active && 'text-muted-foreground')}>{t.digit}</span>
                {t.label}
                {t.view === 'today' && open.length > 0 && (
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-lamp tabular-nums">
                    <span className="lamp size-1.5" />{open.length}
                    <span className="sr-only">waiting on you</span>
                  </span>
                )}
              </a>
            )
          })}
          {/* every other page sits in a group menu; Memory's proposals count shows on its group's button */}
          <GroupMenus pages={pages} route={route} counts={{ memory: proposed }} />
        </nav>

        <div className="ml-auto flex items-center gap-1.5 whitespace-nowrap lg:shrink-0">
          <span role="status" className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground"
            title={live === 'live' ? 'Updates arrive as the agents write' : 'Lost the live connection, retrying'}>
            <span className={cn('size-1.5 rounded-full', live === 'live' ? 'bg-clear shadow-[0_0_8px_var(--clear)]' : 'animate-pulse bg-st-blocked')} />
            <span className="hidden md:inline">{live === 'live' ? 'Live' : 'Reconnecting…'}</span>
          </span>
          {who?.role === 'admin' && <Account user={who.user} compact />}
          <RingToggle />
          <ThemeToggle />
          <button onClick={onSearch} aria-label="Jump to a task, project or view"
            className="flex h-8 items-center gap-2 rounded-md border bg-card px-2 text-sm text-muted-foreground transition-colors hover:border-input hover:text-foreground sm:px-2.5">
            <Search className="size-3.5" /> <span className="hidden 2xl:inline">Jump to…</span> <Kbd className="hidden sm:inline-flex">Ctrl&nbsp;K</Kbd>
          </button>
        </div>
      </div>
    </header>
  )
}


/** True while the nav row has items cut off on the right: the row then fades out at that edge, so a hidden menu
 *  (on a phone, Machines and Settings once they land) reads as "scroll for more" instead of a clipped word. */
function useMoreToTheRight(ref: React.RefObject<HTMLElement | null>, pages: readonly Page[]) {
  const [more, setMore] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    for (const c of el.children) ro.observe(c)
    el.addEventListener('scroll', check, { passive: true })
    return () => { ro.disconnect(); el.removeEventListener('scroll', check) }
  }, [ref, pages])
  return more
}
