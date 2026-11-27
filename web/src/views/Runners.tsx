import { useQuery } from '@tanstack/react-query'
import { get, qs } from '@/lib/api'
import { useWho } from '@/components/Account'
import { isOwner, type Route } from '@/lib/route'
import { who, type Queue } from '@/lib/runners'
import { Button } from '@/components/ui/button'
import { RunnerCard } from '@/components/runners/RunnerCard'
import { FinishedList, Running, Waiting } from '@/components/runners/JobLists'
import { useAct, useNow } from '@/components/runners/bits'

/** The queue changes with every job: the live stream's queue event re-reads it (invalidate.ts: jobs → runners); the
 *  30 s poll catches the runner's beat, which sends no event. */
const useQueue = (project?: string) =>
  useQuery({ queryKey: ['runners', project], refetchInterval: 30_000, queryFn: () => get<Queue>(`/api/runners${qs({ project })}`) })

/** Runners (#4527): every runner's slots and lanes, what runs, what waits and why, and what ended lately. Every admin
 *  reads it (Q2978); Ahmed manages it here, a project's lead with cb job (Q2982). */
export function Runners({ route }: { route: Route }) {
  const { data: q, isLoading, isError } = useQueue(route.project)
  const { data: whoami } = useWho()
  const owner = isOwner(whoami)
  const now = useNow()
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading the runners…</p>
  if (isError || !q) return <p className="text-sm text-muted-foreground">The runners could not be read just now. The page tries again by itself.</p>
  const c = q.counts
  const others = route.project ? { waiting: c.waiting - c.waiting_here, running: c.running - c.running_here } : null
  const hold = route.project ? q.holds.find((h) => h.project === route.project) : undefined
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Runners</h1>
        <p className="mt-1 text-sm text-muted-foreground tabular-nums">
          Waiting {c.waiting_here} · Running {c.running_here} · Last hour: {c.passed_hour} passed, {c.failed_hour} failed or could not run
          {others && (others.waiting || others.running) ? <> · plus {others.waiting} waiting and {others.running} running for other projects on the same runners</> : null}
        </p>
        {!owner && <p className="mt-1 text-xs text-muted-foreground">Ahmed manages the queue here; a project's lead uses cb job move, hold and retry.</p>}
      </header>
      {q.holds.length > 0 && (
        <ul className="mb-4 space-y-1">
          {q.holds.map((h) => (
            <li key={h.project} className="flex flex-wrap items-center gap-2 rounded-md bg-lamp-soft px-3 py-2 text-sm text-lamp-ink">
              {h.project}'s waiting jobs are held by {who(h.held_by)}: they start once released. Running ones carry on.
              {owner && <HoldButton project={h.project} held />}
            </li>
          ))}
        </ul>
      )}
      {q.runners.length === 0
        ? <p className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">No runner has connected yet. Start it on the PC with cb runner.</p>
        : <div className="grid gap-3 xl:grid-cols-2">{q.runners.map((r) => <RunnerCard key={r.name} r={r} q={q} owner={owner} now={now} />)}</div>}
      <Running jobs={q.running} owner={owner} now={now} />
      <Waiting jobs={q.waiting} owner={owner} now={now} aside={owner && route.project && !hold ? <HoldButton project={route.project} /> : null} />
      <FinishedList jobs={q.finished} hours={q.hours} owner={owner} />
    </div>
  )
}

function HoldButton({ project, held }: { project: string; held?: boolean }) {
  const { act, busy } = useAct()
  return (
    <Button size="xs" variant="outline" disabled={busy}
      onClick={() => act('job_hold', { project, held: !held }, held ? `${project}'s jobs start again` : `${project}'s waiting jobs are held`)}>
      {held ? 'Release' : `Hold ${project}'s waiting jobs`}
    </Button>
  )
}
