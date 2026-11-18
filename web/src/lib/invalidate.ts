// Which of the page's queries a board change makes stale (#2 of the 2026-11-18 slowness work).
//
// The server's /api/stream sends one 'change' event per database NOTIFY, and its data is the table that changed
// (cb.notify() in db/schema.sql: pg_notify('cb', tg_table_name)). Before this, any change re-fetched every query on
// the page: /api/tasks alone is ~2 MB, about five times a minute, per open tab.
//
// Tables that notify: tasks questions events projects epics task_blockers huddles users user_projects memories
//                     goals goal_tasks asks
// plus 'listen': the stream (re)connected, so anything may have changed meanwhile.
// Query keys the UI uses (the first element of each queryKey):
//   tasks task epics epic goals goal goal-preview questions asks events today me projects people users
//   memories huddles huddle sessions telegram whoami
//
// Note: nearly every write also inserts into cb.events (the tasks/questions history triggers), so one card edit
// arrives as 'tasks' AND 'events'. Whatever 'events' maps to is re-fetched on almost every change.

/** The query keys to re-fetch for a batch of changed tables, or 'all' to re-fetch everything. */
export function keysFor(tables: Set<string>): string[] | 'all' {
  // TODO(Ahmed): map tables to query keys. Until then: everything, as before.
  void tables
  return 'all'
}
