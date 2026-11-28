// Which of the page's queries a board change makes stale, and when to re-fetch them (2026-11-18 slowness work).
//
// The server's /api/stream sends one 'change' event per database NOTIFY, and its data is the table that changed
// (cb.notify() in db/schema.sql: pg_notify('cb', tg_table_name)). Before this, any change re-fetched every query on
// the page, about once every 2 s per open tab while sessions worked. No imports: test/invalidate.test.ts runs it in node.

/** Table → the query keys (first element of each queryKey) whose endpoint reads it, directly or through a cb.*
 *  function (epics_list, goals_list, sessions_overview, huddles_list, asks_list, mem_stats). When a read starts using
 *  another table, add its key here. A table missing from this map re-fetches everything. */
export const TABLE_KEYS: Record<string, string[]> = {
  tasks: ['tasks', 'task', 'page', 'epics', 'epic', 'goals', 'goal', 'goal-preview', 'today', 'me', 'projects', 'people', 'sessions', 'squad-page'],
  task_blockers: ['tasks', 'task', 'epic'],
  epics: ['epics', 'epic', 'task'],
  goals: ['goals', 'goal', 'goal-preview', 'tasks'],
  goal_tasks: ['goals', 'goal', 'goal-preview', 'tasks'],
  questions: ['questions', 'task', 'goal', 'me', 'projects', 'people', 'sessions', 'memories'],
  // every write's history line: what shows activity, never the board's lists
  // (a squad save writes one too: the settings page re-reads)
  events: ['events', 'today', 'task', 'page', 'me', 'people', 'sessions', 'asks', 'huddles', 'huddle', 'memories', 'squad-page'],
  // the role texts (up to 8 of 8000 characters, with their edits): only when one changes, not on every history line
  role_texts: ['role-texts'],
  asks: ['asks'],
  projects: ['projects', 'squad-page'],
  huddles: ['huddles', 'huddle'],
  users: ['users', 'people', 'sessions', 'whoami'],
  user_projects: ['users', 'people'],
  memories: ['memories'],
  // the Runners page (#4527): the stream's own queue event (channel cb_queue), never a change event; a hidden tab waits
  jobs: ['runners'],
}

/** The query keys to re-fetch for a batch of changed tables, or 'all' ('listen' = the stream reconnected). */
export function keysFor(tables: Set<string>): string[] | 'all' {
  const keys = new Set<string>()
  for (const t of tables) {
    const k = TABLE_KEYS[t]
    if (!k) return 'all'
    k.forEach((x) => keys.add(x))
  }
  return [...keys]
}

/** What a hidden tab still re-fetches, by table: the queries behind the tab-title count and the ring (TopBar: open
 *  questions, and replies to Ahmed's asks, which are history lines; a guest's page: me, for questions handed to them).
 *  That is how a new question is heard with the board in the background. A card change does not ring: it waits. */
export const RINGING: Record<string, string[]> = { questions: ['questions', 'me'], asks: ['asks'], events: ['asks'] }
const ringingFor = (tables: Set<string>): string[] => {
  const keys = new Set<string>()
  for (const t of tables) (t in TABLE_KEYS ? RINGING[t] ?? [] : ['questions', 'asks', 'me']).forEach((k) => keys.add(k))
  return [...keys]
}

/** Collects changes and re-fetches: once a burst settles (settle ms), then at most once per gap ms. A hidden tab
 *  re-fetches only RINGING; visible() catches up once with everything that changed meanwhile. */
export function refresher(o: { invalidate: (keys: string[] | 'all') => void; hidden: () => boolean; gap?: number; settle?: number }) {
  const gap = o.gap ?? 2000, settle = o.settle ?? 120
  let pending = new Set<string>() // since the last full fetch: what visible() catches up
  let fresh = new Set<string>() // since the last fetch of any kind: what a hidden tab has not checked for rings yet
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    timer = undefined
    last = Date.now()
    if (o.hidden()) {
      const ringing = ringingFor(fresh) // a reconnect or an unmapped table: everything that rings
      fresh = new Set()
      if (ringing.length) o.invalidate(ringing)
      return
    }
    const keys = keysFor(pending)
    pending = new Set(); fresh = new Set()
    o.invalidate(keys)
  }
  const schedule = () => {
    if (timer || !(o.hidden() ? fresh : pending).size) return
    timer = setTimeout(flush, Math.max(settle, last + gap - Date.now()))
  }
  return {
    change(table: string) { pending.add(table); fresh.add(table); schedule() },
    visible: schedule,
    stop() { clearTimeout(timer); timer = undefined },
  }
}
