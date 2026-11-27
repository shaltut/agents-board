import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { type Task, type User } from '@/lib/api'
import { useWho } from '@/components/Account'
import { Guest } from '@/views/Guest'
import { Login } from '@/views/Login'
import { useLive } from '@/lib/live'
import { digitView, go, isOwner, openPage, pageOf, useRoute, visiblePages, type Route, type View } from '@/lib/route'
import { chord, CHORD_MS, keyName, shortcutsOff } from '@/lib/keys'
import { TopBar } from '@/components/TopBar'
import { CommandMenu } from '@/components/CommandMenu'
import { GoHint } from '@/components/NavMenus'
import { NewTask } from '@/components/NewTask'
import { TaskPanel } from '@/components/TaskPanel'
import { Today } from '@/views/Today'
import { Board } from '@/views/Board'
import { Backlog } from '@/views/Backlog'
import { History } from '@/views/History'
import { Sessions } from '@/views/Sessions'
import { Huddles } from '@/views/Huddles'
import { People } from '@/views/People'
import { Epics } from '@/views/Epics'
import { Memory } from '@/views/Memory'
import { Goals } from '@/views/Goals'
import { TagChip, TypeChip } from '@/components/Chips'


/** The full board for an admin (or on the PC board's own screen); a signed-in member gets the guest page; anyone
 *  else gets the login page. */
export function Gate() {
  const { data } = useWho()
  if (!data) return null
  if (data.role === 'local' || data.role === 'admin') {
    if (location.pathname === '/login') history.replaceState(null, '', '/')
    return <App />
  }
  if (data.role === 'guest') {
    if (location.pathname === '/login') history.replaceState(null, '', '/')
    return <GuestLive user={data.user} />
  }
  return <Login />
}

function GuestLive({ user }: { user: User }) {
  useLive()
  return <Guest user={user} />
}

/** Every page that has a screen. A page in route.ts's PAGES without one here stays out of the menus and keys, and its
 *  address shows Today. */
const SCREENS: Partial<Record<View, ComponentType<{ route: Route }>>> = {
  today: Today, questions: Today, board: Board, backlog: Backlog, sessions: Sessions, huddles: Huddles, history: History,
  people: People, epics: Epics, memory: Memory, goals: Goals,
}

export default function App() {
  const hashRoute = useRoute()
  const route: Route = SCREENS[hashRoute.view] ? hashRoute : { ...hashRoute, view: 'today' }
  const live = useLive()
  const { data: who } = useWho()
  const owner = isOwner(who)
  const pages = useMemo(() => visiblePages(owner, (v) => !!SCREENS[v]), [owner])
  const [menu, setMenu] = useState(false)
  const [newTask, setNewTask] = useState(false)
  const [hint, setHint] = useState(false) // g pressed: the letters show in the corner until the next key or the timeout
  const keys = useRef({ pages, since: null as number | null })
  useEffect(() => { keys.current.pages = pages }, [pages]) // the key handler is bound once and reads the latest list

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && keyName({ key: e.key, code: e.code })?.toLowerCase() === 'k') { e.preventDefault(); setMenu((m) => !m); return }
      const k = keys.current
      if (shortcutsOff(e.target as Element | null) || e.ctrlKey || e.metaKey || e.altKey) { k.since = null; setHint(false); return }
      const key = keyName(e) // null: auto-repeat; a non-Latin layout reads the physical key
      if (key === null) return
      const c = chord(k.since, key, Date.now(), k.pages)
      k.since = c.since
      setHint(c.since !== null)
      if (c.used) {
        if (key !== 'Escape') e.preventDefault() // Esc still reaches an open dialog
        if (c.view) openPage(c.view)
        return
      }
      const view = digitView(key, k.pages) // 1-9 and 0: the same pages as before the menus
      if (view) openPage(view)
      else if (key === 'c') { e.preventDefault(); setNewTask(true) }
      else if (key === '/') { e.preventDefault(); setMenu(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!hint) return
    const t = setTimeout(() => { keys.current.since = null; setHint(false) }, CHORD_MS)
    return () => clearTimeout(t)
  }, [hint])

  const View = SCREENS[route.view] ?? Today
  const ownersOnly = pageOf(route.view)?.owner && !owner // the server refuses the data too; this just says why

  return (
    <div className="min-h-dvh">
      <button onClick={() => document.getElementById('main')?.focus()}
        className="sr-only z-50 rounded-md bg-foreground px-3 py-2 text-sm text-background focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </button>
      <TopBar route={route} pages={pages} live={live} onSearch={() => setMenu(true)} />
      <main id="main" tabIndex={-1} className="outline-none mx-auto max-w-[1600px] px-4 pt-6 pb-16 sm:px-6 lg:pt-8">
        {(route.tag || route.type) && (route.view === 'board' || route.view === 'backlog') && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm" role="status">
            <span className="text-muted-foreground">Only</span>
            {route.type && <TypeChip type={route.type as Task['type']} active />}
            {route.tag && <><span className="text-muted-foreground">{route.type ? 'tagged' : 'tasks tagged'}</span><TagChip tag={route.tag} active /></>}
            <button onClick={() => go({ tag: undefined, type: undefined })} className="rounded-md px-1.5 py-0.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Show all
            </button>
          </div>
        )}
        {ownersOnly ? <p className="text-sm text-muted-foreground">This page is for the board's owner.</p> : <View route={route} />}
      </main>
      <CommandMenu open={menu} onOpenChange={setMenu} onNewTask={() => setNewTask(true)} pages={pages} />
      {hint && <GoHint pages={pages} />}
      <NewTask open={newTask} onOpenChange={setNewTask} project={route.project} />
      <TaskPanel id={route.task} />
    </div>
  )
}
