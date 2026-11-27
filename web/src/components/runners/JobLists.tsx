import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp } from 'lucide-react'
import { clock } from '@/lib/format'
import { go } from '@/lib/route'
import {
  duration, FINISHED_FILTERS, finishedOf, logCommand, paramsLine, result, STATE_WORDS, waitWords, who, type Finished, type Job,
} from '@/lib/runners'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ProjectChip, TaskId } from '@/components/Chips'
import { ConfirmButton, CopyCommand, sha7, useAct, What } from './bits'

/** One job as a row: what and a status on top, where, commit and who below. Wraps to two lines on a phone. */
function Row({ j, right, children, actions }: { j: Job; right: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <li className="border-t px-3 py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {j.place != null && <span className="w-6 shrink-0 text-right text-sm text-muted-foreground tabular-nums" aria-label={`place ${j.place}`}>{j.place}</span>}
        <What j={j} className="max-w-full" />
        <span className="ml-auto text-sm tabular-nums">{right}</span>
      </div>
      <div className={cn('mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', j.place != null && 'sm:pl-9')}>
        <ProjectChip slug={j.project} />
        <code className="font-mono" translate="no" title={j.sha}>{sha7(j.sha)}</code>
        <span className="min-w-0 truncate" title={j.requester}>asked by {who(j.requester)}</span>
        {j.task_id && <button className="hover:text-foreground" onClick={() => go({ task: j.task_id! })} aria-label={`Open card ${j.task_id}`}><TaskId id={j.task_id} /></button>}
        <span className="text-muted-foreground/80">job #{j.id}</span>
        {j.retry_of && <span>run again from job #{j.retry_of}</span>}
      </div>
      {paramsLine(j.params) && <p className={cn('mt-1 truncate font-mono text-xs text-muted-foreground', j.place != null && 'sm:pl-9')} translate="no" title={paramsLine(j.params, 50)}>{paramsLine(j.params)}</p>}
      {children}
      {actions && <div className={cn('mt-2 flex flex-wrap items-center gap-1.5', j.place != null && 'sm:pl-9')}>{actions}</div>}
    </li>
  )
}

function List({ title, count, empty, children, aside }: { title: string; count: number; empty: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mt-8" aria-label={title}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h2 className="text-lg font-semibold tracking-[-0.01em]">{title} <span className="font-normal text-muted-foreground tabular-nums">({count})</span></h2>
        {aside}
      </div>
      {count === 0 ? <p className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">{empty}</p>
        : <ul className="rounded-lg border bg-card">{children}</ul>}
    </section>
  )
}

export function Running({ jobs, owner, now }: { jobs: Job[]; owner: boolean; now: number }) {
  const { act, busy } = useAct()
  return (
    <List title="Running now" count={jobs.length} empty="Nothing is running.">
      {jobs.map((j) => (
        <Row key={j.id} j={j} right={<>{j.started_at && <span className="text-muted-foreground">since {clock(j.started_at)} · </span>}{j.started_at ? duration(now - Date.parse(j.started_at)) : ''}</>}
          actions={owner && <ConfirmButton label="Stop" ask={`Stop job #${j.id}?`} yes="Stop it" disabled={busy}
            onYes={() => act('job_cancel', { id: j.id }, `Job #${j.id} stopped`)} />} />
      ))}
    </List>
  )
}

export function Waiting({ jobs, owner, now, aside }: { jobs: Job[]; owner: boolean; now: number; aside?: ReactNode }) {
  const { act, busy } = useAct()
  const move = (j: Job, place: string) => act('job_move', { id: j.id, place })
  return (
    <List title="Waiting, in the order they will start" count={jobs.length} empty="Nothing is waiting." aside={aside}>
      {jobs.map((j) => (
        <Row key={j.id} j={j} right={<span className="text-muted-foreground">waiting {duration(now - Date.parse(j.created_at))}</span>}
          actions={owner && <>
            <Button size="icon-xs" variant="ghost" disabled={busy} onClick={() => move(j, 'next')} aria-label={`Run job #${j.id} next`} title="Run next"><ChevronsUp /></Button>
            <Button size="icon-xs" variant="ghost" disabled={busy} onClick={() => move(j, 'up')} aria-label={`Move job #${j.id} up`} title="Up one"><ArrowUp /></Button>
            <Button size="icon-xs" variant="ghost" disabled={busy} onClick={() => move(j, 'down')} aria-label={`Move job #${j.id} down`} title="Down one"><ArrowDown /></Button>
            <Button size="icon-xs" variant="ghost" disabled={busy} onClick={() => move(j, 'back')} aria-label={`Move job #${j.id} to the back`} title="To the back"><ChevronsDown /></Button>
            <ConfirmButton label="Stop" ask={`Stop job #${j.id}?`} yes="Stop it" disabled={busy} onYes={() => act('job_cancel', { id: j.id }, `Job #${j.id} stopped`)} />
          </>}>
          <p className={cn('mt-1 text-sm', j.why?.reason === 'next' ? 'text-muted-foreground' : 'text-foreground', 'sm:pl-9')}>{waitWords(j.why)}</p>
        </Row>
      ))}
    </List>
  )
}

const RESULT_TONE: Record<string, string> = { passed: 'text-st-done', failed: 'text-destructive', error: 'text-lamp-ink', cancelled: 'text-muted-foreground' }

export function FinishedList({ jobs, hours, owner }: { jobs: Job[]; hours: number; owner: boolean }) {
  const [filter, setFilter] = useState<Finished>('all')
  const shown = finishedOf(jobs, filter)
  const { act, busy } = useAct()
  const chips = (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
      {FINISHED_FILTERS.map((f) => (
        <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
          className={cn('rounded-md px-2 py-0.5 text-xs', filter === f.key ? 'bg-foreground text-background' : 'bg-raised text-muted-foreground hover:text-foreground')}>
          {f.label} <span className="tabular-nums">{finishedOf(jobs, f.key).length}</span>
        </button>
      ))}
    </div>
  )
  return (
    <List title={`Finished, last ${hours} hours`} count={shown.length} empty="No job finished in that time." aside={chips}>
      {shown.map((j) => {
        const r = result(j), log = logCommand(j)
        const took = j.started_at && j.finished_at ? duration(Date.parse(j.finished_at) - Date.parse(j.started_at)) : null
        const waited = j.started_at ? duration(Date.parse(j.started_at) - Date.parse(j.created_at)) : null
        return (
          <Row key={j.id} j={j}
            right={<span className={cn('font-medium', RESULT_TONE[j.state])}>{STATE_WORDS[j.state]}</span>}
            actions={owner && <Button size="xs" variant="outline" disabled={busy} onClick={() => act('job_retry', { id: j.id }, 'Queued again')}>Run again</Button>}>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {j.finished_at && <>ended {clock(j.finished_at)}</>}{took && <> · took {took}</>}{waited && <> · waited {waited}</>}
            </p>
            {(r.said !== STATE_WORDS[j.state] + '.' || r.output || log) && (
              <details className="group mt-1.5 text-sm">
                <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>{r.said}
                </summary>
                {r.output && <>
                  <p className="mt-2 text-xs text-muted-foreground">Job output (from the run, not checked by the board):</p>
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-raised p-2 font-mono text-xs whitespace-pre-wrap break-words">{r.output}</pre>
                </>}
                {log && <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">Full log, on the PC or the MacBook: <CopyCommand text={log} /></p>}
              </details>
            )}
          </Row>
        )
      })}
    </List>
  )
}
