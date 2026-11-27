// The Runners page (#4527): what /api/runners (cb.runner_queue) returns, and every word the page shows for it. Plain
// words only: no state names, reason keys, exit codes or lane numbers reach the reader. No React: test/runners-web.test.ts
// runs it in node.

export type JobState = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled'
export type Why =
  | { reason: 'next' } | { reason: 'no_runner' }
  | { reason: 'slot' | 'lane'; busy: number; of: number }
  | { reason: 'held'; by: string; at: string }
  | { reason: 'paused' | 'draining'; runner: string; by: string | null; at: string | null }
  | { reason: 'down'; runner: string; since: string | null }
export interface Job {
  id: number; project: string; repo: string; recipe: string; params: Record<string, string[]>; sha: string; requester: string
  task_id: number | null; state: JobState; summary: string | null; runner: string | null; retry_of: number | null
  created_at: string; started_at: string | null; finished_at: string | null
  db?: boolean; place?: number; why?: Why
}
export interface Runner {
  name: string; last_seen: string | null; started_at: string | null; alive: boolean
  mode: 'on' | 'paused' | 'draining'; mode_by: string | null; mode_at: string | null
  slots: number | null; db_lanes: number | null // reported by the runner at start; null = not reported yet
  slots_set: number | null; lanes_set: number | null; set_by: string | null; set_at: string | null // Ahmed's setting
  busy: number; busy_db: number; cap: number | null; lanes: number | null
}
export interface Queue {
  now: string; project: string | null; hours: number; supervisor: boolean
  runners: Runner[]; holds: { project: string; held_by: string; held_at: string }[]
  counts: { waiting: number; running: number; waiting_here: number; running_here: number; passed_hour: number; failed_hour: number }
  running: Job[]; waiting: Job[]; finished: Job[]
}

/** Recipe names are what sessions type (cb run <recipe>); the common ones get a plain label, any other shows as the
 *  command word itself. */
const RECIPES: Record<string, string> = {
  test: 'Tests', vitest: 'Tests', itest: 'Database tests', check: 'Type check', typecheck: 'Type check', tsc: 'Type check',
  lint: 'Lint', build: 'Build', e2e: 'Browser tests', format: 'Format check',
}
export const recipeLabel = (recipe: string): { text: string; command: boolean } =>
  RECIPES[recipe] ? { text: RECIPES[recipe]!, command: false } : { text: `cb run ${recipe}`, command: true }

export const STATE_WORDS: Record<JobState, string> = {
  queued: 'Waiting', running: 'Running', passed: 'Passed', failed: 'Failed', error: 'Could not run', cancelled: 'Stopped',
}

/** A person or session, as the page names them. */
export const who = (actor: string | null | undefined) =>
  !actor ? 'someone' : actor === 'ahmed' ? 'Ahmed' : actor === 'runner' ? 'the runner' : actor

// Summaries the board and the runner write themselves (cli/runner-job.ts, cli/recipes.ts, cb.job_cancel and friends),
// in the reader's words. Anything else is the job's own output, shown apart and never as the board's words.
const KNOWN: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^cancelled by (.+)$/, (m) => `Stopped by ${who(m[1])}.`],
  [/^error: push it first$|^error: not on a branch of origin$/, () => 'The commit is not on GitHub yet. Push it, then run again.'],
  [/^error: could not fetch from origin$/, () => 'Could not download the code.'],
  [/^error: runner restarted$/, () => 'Stopped because the runner restarted. Run it again.'],
  [/^error: timed out after (\d+) min$/, (m) => `Took longer than ${m[1]} minutes and was stopped.`],
  [/^error: Docker is not running$/, () => 'Docker was not running on the runner machine.'],
  [/^error: not in the repo at \S+: (.+?)(?: \(paths are relative.*)?$/s, (m) => `A file it was asked to run is not in that commit: ${m[1]}`],
  [/^error: bad parameter (\S+): /, (m) => `A value given for ${m[1]} is not allowed.`],
  [/^error: could not start (\S+)$/, (m) => `Could not start ${m[1]} on the runner machine.`],
  [/^error: the runner lost the board connection/, () => 'The runner lost its link to the board while starting it.'],
  [/^error: a DB job got no DB lane$|^error: bad job row|^error: runner fault/, () => 'The runner could not start it. Its log on the PC says why.'],
]

/** One ended or running job's result: the board's own words (said), and the job's output to show apart (output). */
export function result(j: Pick<Job, 'state' | 'summary'>): { said: string; output: string | null } {
  const s = (j.summary ?? '').trim()
  for (const [re, words] of KNOWN) {
    const m = re.exec(s)
    if (m) return { said: words(m), output: null }
  }
  const said = j.state === 'error' ? 'Could not run.' : STATE_WORDS[j.state] + '.'
  return { said, output: s && j.state !== 'cancelled' ? s : null }
}

/** Why a waiting job has not started, in words. */
export function waitWords(why: Why | undefined, at: (iso: string) => string = clockOf): string {
  if (!why) return 'Waiting'
  switch (why.reason) {
    case 'next': return 'Starts next'
    case 'no_runner': return 'No runner offers this check now'
    case 'held': return `This project's jobs are held by ${who(why.by)}`
    case 'down': return 'The runner is not answering'
    case 'paused': return `The runner is paused${why.by ? ` by ${who(why.by)}` : ''}${why.at ? ` since ${at(why.at)}` : ''}`
    case 'draining': return 'The runner is finishing its jobs before a restart'
    case 'lane': return `Waiting for a database lane (${why.busy} of ${why.of} busy)`
    case 'slot': return `Starts when a slot frees (${why.busy} of ${why.of} busy)`
    default: return 'Waiting'
  }
}

export const clockOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** The runner card's first line. */
export function modeWords(r: Runner, at: (iso: string) => string = clockOf): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!r.alive) return { text: r.last_seen ? `Not answering since ${at(r.last_seen)}` : 'Not answering', tone: 'bad' }
  if (r.mode === 'paused') return { text: `Paused${r.mode_by ? ` by ${who(r.mode_by)}` : ''}${r.mode_at ? ` at ${at(r.mode_at)}` : ''}: takes no new jobs`, tone: 'warn' }
  if (r.mode === 'draining') return r.busy
    ? { text: `Finishing ${r.busy} ${r.busy === 1 ? 'job' : 'jobs'} before a restart: takes no new jobs`, tone: 'warn' }
    : { text: 'Ready to restart: nothing is running', tone: 'ok' }
  return { text: 'Taking jobs', tone: 'ok' }
}

/** "7 of 10 in use", and what Ahmed's setting changes: a lower one applies now, a higher one when the runner restarts. */
export function capacity(busy: number, reported: number | null, set: number | null, noun: 'slot' | 'lane') {
  const of = reported == null ? set : set == null ? reported : Math.min(reported, set)
  const used = of == null ? `${busy} in use (the runner has not reported how many it has)` : `${busy} of ${of} in use`
  let plan: string | null = null
  if (set != null && reported != null && set > reported) plan = `Set to ${set}: takes effect when the runner restarts`
  else if (set != null && reported != null && set < reported) plan = `Set to ${set} on the board (the runner has ${reported})`
  else if (set != null && reported == null) plan = `Set to ${set} on the board`
  if (of != null && busy > of) plan = `${plan ? plan + '. ' : ''}No new ${noun === 'slot' ? 'jobs start' : 'database jobs start'} until ${busy - of} ${busy - of === 1 ? 'finishes' : 'finish'}`
  return { used, of, plan }
}

/** 48 s · 4 min 12 s · 1 h 3 min */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`
  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ''}`
}

/** The log stays on the PC (Q2981): the page offers the command, only for a job that started (no log before). */
export const logCommand = (j: Pick<Job, 'id' | 'started_at'>) => j.started_at ? `cb job log ${j.id} --tail 80` : null

/** "files: a.test.ts, b.test.ts" for a job's parameters; long lists cut. */
export function paramsLine(params: Record<string, string[]> | null | undefined, max = 3): string {
  return Object.entries(params ?? {}).filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `${k}: ${v.slice(0, max).join(', ')}${v.length > max ? ` and ${v.length - max} more` : ''}`).join(' · ')
}

/** The finished list's filter. */
export type Finished = 'all' | 'failed' | 'error' | 'cancelled'
export const FINISHED_FILTERS: { key: Finished; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'failed', label: 'Failed' }, { key: 'error', label: 'Could not run' }, { key: 'cancelled', label: 'Stopped' },
]
export const finishedOf = (jobs: Job[], f: Finished) => f === 'all' ? jobs : jobs.filter((j) => j.state === f)

/** A refused action, in words for the page: the board's own sentence when it is one of the queue's refusals, never a
 *  raw database or network error. */
export function actionError(e: unknown): string {
  const m = e instanceof Error ? e.message : ''
  if (/^(only (Ahmed|the requester)|Only Ahmed)/.test(m)) return m.replace(/\s*\(.*$/, '')
  if (/already waiting or running as job #\d+$/.test(m)) return `The same check is already waiting or running (job #${/#(\d+)$/.exec(m)![1]}).`
  if (/not waiting any more|already ended|has not ended/.test(m)) return 'That job has moved on since the page loaded. The list is up to date now.'
  if (/^no recipe /.test(m)) return 'No runner offers that check any more, so it cannot run again.'
  if (/must be 1 to (64|9)|cannot be more than slots/.test(m)) return m.charAt(0).toUpperCase() + m.slice(1) + '.'
  return 'That did not go through. Try again in a moment.'
}
