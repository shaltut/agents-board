// The Projects page (#4559 slice 2): a project's state in Ahmed's words, the buttons each state offers, and the
// confirm dialog's lines from cb.project_state_preview. Pure: no React, so test/project-states-web.test.ts reads it.
// No stored state value reaches the screen: every word on the page comes from here.
import type { Project } from './api'
import { plural } from './squad.ts' // with its extension: node's test run loads this file too

export type State = Project['state']
export const STATE_LABEL: Record<State, string> = { enabled: 'Enabled', disabled: 'Disabled', archived: 'Archived' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')
/** "27 Nov 14:05", in the viewer's time. */
export const when = (iso: string) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
/** "27 Nov", for an archived project (the hour no longer matters). */
const dayOf = (iso: string) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]}` }
/** Who changed it: Ahmed, or nobody named (the board's one-time mapping of an already archived project). */
const by = (p: Pick<Project, 'state_by'>) => (p.state_by === 'ahmed' ? ' by Ahmed' : '')

/** The row's line under the name: "Enabled", "Disabled by Ahmed on 27 Nov 14:05", "Archived on 2 Nov". */
export function stateLine(p: Pick<Project, 'state' | 'state_by' | 'state_at'>): string {
  if (p.state === 'disabled') return `Disabled${by(p)}${p.state_at ? ` on ${when(p.state_at)}` : ''}`
  if (p.state === 'archived') return `Archived${p.state_at ? ` on ${dayOf(p.state_at)}` : ''}`
  return 'Enabled'
}

/** The row's counts: what is going on there, or, once disabled, what is waiting. */
export function countsLine(p: Pick<Project, 'state' | 'open_count' | 'in_progress_count' | 'seats_live' | 'question_count'>): string {
  if (p.state === 'archived') return `${plural(p.open_count, 'open card')} kept, readable`
  if (p.state === 'disabled') return [`${p.open_count} open`, p.in_progress_count > 0 && `${p.in_progress_count} in progress, held and waiting`,
    p.seats_live > 0 && `${plural(p.seats_live, 'seat')} still live`].filter(Boolean).join(' · ')
  return [`${p.open_count} open`, `${p.in_progress_count} in progress`, `${plural(p.seats_live, 'seat')} live`,
    p.question_count > 0 && `${plural(p.question_count, 'question')} for you`].filter(Boolean).join(' · ')
}

/** The buttons a row offers, in order. confirm: opens the dialog first (Disable and Archive); the others act at once.
 *  Archive only a disabled project; Unarchive goes back to Disabled, never straight to Enabled. */
export interface Action { to: State; label: string; confirm: boolean }
export function actions(state: State): Action[] {
  if (state === 'enabled') return [{ to: 'disabled', label: 'Disable…', confirm: true }]
  if (state === 'disabled') return [{ to: 'enabled', label: 'Enable', confirm: false }, { to: 'archived', label: 'Archive…', confirm: true }]
  return [{ to: 'disabled', label: 'Unarchive', confirm: false }]
}

/** What the change did, for the toast. */
export function doneText(name: string, from: State, to: State): string {
  if (to === 'enabled') return `${name} is enabled: work is handed out there again`
  if (to === 'archived') return `${name} is archived`
  return from === 'archived' ? `${name} is unarchived: it is disabled until you enable it` : `${name} is disabled: no new work starts there`
}

/** cb.project_state_preview's counts (numbers only are read). */
export interface Preview {
  name: string; seats_live: number; open: number; in_progress: number; held: number
  jobs_waiting: number; jobs_running: number; questions: number; github_watches: number
}

/** The confirm dialog: title, the sentence under it, one line per thing it touches, and the button. Every line is
 *  already true at this slice: the supervisor's closing of idle seats (slice 3) and the cancelling of waiting jobs on
 *  archive (slice 4) are left out until they ship. */
export function confirmText(to: 'disabled' | 'archived', pv: Preview): { title: string; lead: string; lines: string[]; button: string } {
  const n = pv.name
  if (to === 'archived') {
    return {
      title: `Archive ${n}?`,
      lead: 'Nothing new may be filed there, by anyone. Nothing is deleted.',
      lines: [
        `${plural(pv.open, 'open card')} ${pv.open === 1 ? 'stays' : 'stay'} readable, with every page, memory and the squad.`,
        `It folds away under Archived on this page and leaves every project list.`,
        `Unarchive brings it back as disabled; enable it after that.`,
      ],
      button: `Archive ${n}`,
    }
  }
  const lines = [
    pv.seats_live > 0 && `${plural(pv.seats_live, 'seat')} live: each gets a notice, stops at a safe point and writes where it stands.`,
    pv.in_progress > 0 && `${plural(pv.in_progress, 'card')} in progress ${pv.in_progress === 1 ? 'keeps its holder' : 'keep their holders'}.`,
    (pv.jobs_waiting > 0 || pv.jobs_running > 0) && [
      pv.jobs_waiting > 0 && `${plural(pv.jobs_waiting, 'test run')} waiting ${pv.jobs_waiting === 1 ? 'stays' : 'stay'} waiting.`,
      pv.jobs_running > 0 && `${pv.jobs_running} running ${pv.jobs_running === 1 ? 'finishes' : 'finish'}.`,
    ].filter(Boolean).join(' '),
    pv.questions > 0 && `${plural(pv.questions, 'question')} for you ${pv.questions === 1 ? 'leaves' : 'leave'} Today and Telegram until you enable it.`,
    pv.github_watches > 0 && `${plural(pv.github_watches, 'GitHub repo watch', 'GitHub repo watches')} ${pv.github_watches === 1 ? 'stops' : 'stop'} until you enable it.`,
  ].filter((x): x is string => !!x)
  return {
    title: `Disable ${n}?`,
    lead: 'No new work starts there. Nothing is deleted, and Enable brings it all back.',
    lines: lines.length ? lines : ['Nothing is running there now.'],
    button: `Disable ${n}`,
  }
}

/** The banner on a chosen project's Board, Backlog and Sessions while it gets no work; null while it is enabled. */
export function bannerText(p: Pick<Project, 'name' | 'state' | 'state_by' | 'state_at'>): string | null {
  if (p.state === 'disabled')
    return `${p.name} has been disabled${by(p)}${p.state_at ? ` since ${when(p.state_at)}` : ''}: no new work is handed out. Cards and history are kept.`
  if (p.state === 'archived') return `${p.name} is archived: nothing new goes there. Cards and history are kept.`
  return null
}

/** Enabled first, then disabled, by name; archived ones come apart, folded. */
export function groups<P extends Pick<Project, 'state' | 'name'>>(ps: readonly P[]): { shown: P[]; archived: P[] } {
  const order = (p: P) => (p.state === 'enabled' ? 0 : 1)
  const shown = ps.filter((p) => p.state !== 'archived').sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
  return { shown, archived: ps.filter((p) => p.state === 'archived').sort((a, b) => a.name.localeCompare(b.name)) }
}
