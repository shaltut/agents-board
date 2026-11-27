import { useEffect, useState } from 'react'
import { BookMarked, CalendarClock, Columns3, Gauge, History, ListOrdered, MessagesSquare, Milestone, Radio, Server, Settings, Target, Users, type LucideIcon } from 'lucide-react'

export type View = 'today' | 'board' | 'backlog' | 'sessions' | 'huddles' | 'history' | 'people' | 'epics' | 'memory' | 'goals' | 'runners' | 'usage' | 'settings' | 'questions'

export type Group = 'work' | 'team' | 'knowledge' | 'machines' | 'settings'
export const GROUPS: readonly { id: Group; label: string }[] = [
  { id: 'work', label: 'Work' }, { id: 'team', label: 'Team' }, { id: 'knowledge', label: 'Knowledge' },
  { id: 'machines', label: 'Machines' }, { id: 'settings', label: 'Settings' },
]

/** A page on the header (no group) or in a group menu. `digit`: its number key (the ten from before the menus, kept so
 *  habits keep working); `g`: the letter after g. `owner`: only the owner sees it (the server refuses others anyway). */
export interface Page { view: Exclude<View, 'questions'>; label: string; icon: LucideIcon; group?: Group; digit?: string; g: string; owner?: boolean }

/** THE page list (#4528): the header, the group menus, the command menu, the number keys and the g keys all read it.
 *  Order = menu order. A new page already has its line here; it adds its screen to App.tsx's SCREENS, and until then it
 *  stays out of every menu and key, so nothing leads to a page that is not there. */
export const PAGES: readonly Page[] = [
  { view: 'today', label: 'Today', icon: CalendarClock, digit: '1', g: 't' },
  { view: 'board', label: 'Board', icon: Columns3, digit: '2', g: 'b' },
  { view: 'backlog', label: 'Backlog', icon: ListOrdered, group: 'work', digit: '3', g: 'l' }, // b is Board
  { view: 'goals', label: 'Goals', icon: Target, group: 'work', digit: '0', g: 'g' },
  { view: 'epics', label: 'Epics', icon: Milestone, group: 'work', digit: '8', g: 'e' },
  { view: 'sessions', label: 'Sessions', icon: Radio, group: 'team', digit: '4', g: 's' },
  { view: 'huddles', label: 'Huddles', icon: MessagesSquare, group: 'team', digit: '5', g: 'h' },
  { view: 'people', label: 'Users', icon: Users, group: 'team', digit: '7', g: 'u' },
  { view: 'memory', label: 'Memory', icon: BookMarked, group: 'knowledge', digit: '9', g: 'm' },
  { view: 'history', label: 'History', icon: History, group: 'knowledge', digit: '6', g: 'y' }, // h is Huddles
  { view: 'runners', label: 'Runners', icon: Server, group: 'machines', g: 'r' },
  { view: 'usage', label: 'Usage', icon: Gauge, group: 'machines', g: 'a', owner: true }, // u is Users, s Sessions
  { view: 'settings', label: 'Project settings', icon: Settings, group: 'settings', g: 'p', owner: true },
]

/** The board's owner: the PC's own screen, or the admin named ahmed (the server's admin.name check, People.tsx). */
export const isOwner = (who?: { role: string; user?: { name: string } } | null) =>
  !!who && (who.role === 'local' || (who.role === 'admin' && who.user?.name === 'ahmed'))

/** The pages this viewer gets: built ones only, and owner-only pages for the owner only. */
export const visiblePages = (owner: boolean, built: (v: View) => boolean): Page[] =>
  PAGES.filter((p) => built(p.view) && (owner || !p.owner))

export const pageOf = (view: View) => PAGES.find((p) => p.view === (view === 'questions' ? 'today' : view))
export const headerPages = (pages: readonly Page[]) => pages.filter((p) => !p.group)
export const digitView = (key: string, pages: readonly Page[]) => pages.find((p) => p.digit === key)?.view

/** The group menus that have something to show, each with the open page when it lives there (its button names it). */
export function navGroups(pages: readonly Page[], view: View) {
  const open = pageOf(view)?.view
  return GROUPS.map((g) => {
    const mine = pages.filter((p) => p.group === g.id)
    return { ...g, pages: mine, current: mine.find((p) => p.view === open) }
  }).filter((g) => g.pages.length > 0)
}

/** Open a page fresh: no task panel, session, huddle, epic or goal carried over from the last one. */
export const openPage = (view: View) => go({ view, task: undefined, actor: undefined, huddle: undefined, epic: undefined, goal: undefined })

export interface Route { view: View; project?: string; task?: number; tag?: string; type?: string; actor?: string; huddle?: number; epic?: number; goal?: number }

/** Hash routes: #/board?p=<project>&t=<task id>&g=<tag>&k=<type>, #/epics?e=<epic id>, #/goals?goal=<goal id>. The task panel opens over whatever view is showing. */
export function parse(hash = location.hash): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?')
  const p = new URLSearchParams(query)
  const view = (path === 'questions' || PAGES.some((p) => p.view === path) ? path : 'today') as View
  const t = Number(p.get('t'))
  return { view, project: p.get('p') || undefined, task: t > 0 ? t : undefined, tag: p.get('g') || undefined, type: p.get('k') || undefined, actor: p.get('a') || undefined, huddle: Number(p.get('h')) || undefined, epic: Number(p.get('e')) || undefined, goal: Number(p.get('goal')) || undefined }
}

export function href(r: Route) {
  const p = new URLSearchParams()
  if (r.project) p.set('p', r.project)
  if (r.task) p.set('t', String(r.task))
  if (r.tag) p.set('g', r.tag)
  if (r.type) p.set('k', r.type)
  if (r.actor) p.set('a', r.actor)
  if (r.huddle) p.set('h', String(r.huddle))
  if (r.epic) p.set('e', String(r.epic))
  if (r.goal) p.set('goal', String(r.goal))
  const s = p.toString()
  return `#/${r.view}${s ? `?${s}` : ''}`
}

export function go(patch: Partial<Route>) {
  location.hash = href({ ...parse(), ...patch })
}

export function useRoute(): Route {
  const [r, setR] = useState(parse)
  useEffect(() => {
    const on = () => setR(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return r
}
