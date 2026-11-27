import { useState } from 'react'
import { Server } from 'lucide-react'
import { ago } from '@/lib/format'
import { capacity, modeWords, type Queue, type Runner } from '@/lib/runners'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/settings/bits'
import { ConfirmButton, Meter, useAct } from './bits'

const TONE = { ok: 'text-st-done', warn: 'text-lamp-ink', bad: 'text-destructive' }

/** One runner machine: whether it takes jobs, its slots and database lanes, and (Ahmed only) pause, drain and limits. */
export function RunnerCard({ r, q, owner, now }: { r: Runner; q: Queue; owner: boolean; now: number }) {
  const mode = modeWords(r)
  const slots = capacity(r.busy, r.slots, r.slots_set, 'slot', r.setting_refused)
  const lanes = capacity(r.busy_db, r.db_lanes, r.lanes_set, 'lane', r.setting_refused)
  const dbWaiting = q.waiting.filter((w) => w.why?.reason === 'lane').length
  const { act, busy } = useAct()
  return (
    <section aria-label={`Runner ${r.name}`} className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="inline-flex items-center gap-2 font-semibold"><Server className="size-4 text-muted-foreground" aria-hidden />{r.name}</h2>
        <span className={cn('text-sm font-medium', TONE[mode.tone])}>{mode.text}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {r.last_seen ? `seen ${ago(r.last_seen, now)}` : 'never seen'}
          {' · '}{q.supervisor ? 'supervisor running' : <span className="text-lamp-ink">supervisor not running: a stopped runner will not be restarted by itself</span>}
        </span>
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        <dt className="text-muted-foreground">Slots</dt>
        <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Meter used={r.busy} of={slots.of} label={slots.used} /><span className="tabular-nums">{slots.used}</span>
          {slots.plan && <span className="text-xs text-lamp-ink">{slots.plan}</span>}
        </dd>
        <dt className="text-muted-foreground">Database lanes</dt>
        <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Meter used={r.busy_db} of={lanes.of} label={lanes.used} /><span className="tabular-nums">{lanes.used}</span>
          {dbWaiting > 0 && <span className="text-xs text-muted-foreground">({dbWaiting} database {dbWaiting === 1 ? 'job is' : 'jobs are'} waiting for a lane)</span>}
          {lanes.plan && <span className="text-xs text-lamp-ink">{lanes.plan}</span>}
        </dd>
      </dl>
      {owner && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
          {r.mode === 'on' ? <>
            <ConfirmButton label="Pause" ask="Stop starting new jobs until you resume?" yes="Pause" disabled={busy}
              onYes={() => act('runner_set', { runner: r.name, mode: 'paused' }, 'Paused: running jobs carry on')} />
            <ConfirmButton label="Drain before restart" ask="Finish running jobs, start no new ones?" yes="Drain" disabled={busy}
              onYes={() => act('runner_set', { runner: r.name, mode: 'draining' }, 'Draining: it takes jobs again once restarted')} />
          </> : (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => act('runner_set', { runner: r.name, mode: 'on' }, 'Taking jobs again')}>
              {r.mode === 'paused' ? 'Resume' : 'Stop draining'}
            </Button>
          )}
          <Limits r={r} />
          {r.mode === 'paused' && <span className="text-xs text-muted-foreground">Sessions waiting on their jobs stay open while it is paused.</span>}
        </div>
      )}
    </section>
  )
}

/** Ahmed's slot and lane numbers (Q2984): any number, up or down. Empty = the runner's own file. */
function Limits({ r }: { r: Runner }) {
  const [open, setOpen] = useState(false)
  const [slots, setSlots] = useState('')
  const [lanes, setLanes] = useState('')
  const { act, busy } = useAct()
  if (!open) return (
    <Button size="xs" variant="outline" onClick={() => { setSlots(String(r.slots_set ?? r.slots ?? '')); setLanes(String(r.lanes_set ?? r.db_lanes ?? '')); setOpen(true) }}>
      Slots and lanes…
    </Button>
  )
  const n = (v: string) => (v.trim() === '' ? null : Number(v))
  const bad = [n(slots), n(lanes)].some((v) => v !== null && !Number.isInteger(v))
  // an empty field goes back to the runner's own file for that number (clear_*); a number replaces it
  const save = (s: number | null, l: number | null) =>
    act('runner_limits_set', { runner: r.name, slots: s, db_lanes: l, clear_slots: s === null, clear_lanes: l === null }, 'Saved').then(() => setOpen(false))
  return (
    <form className="flex w-full flex-wrap items-end gap-2 rounded-md bg-raised p-2 text-sm sm:w-auto"
      onSubmit={(e) => { e.preventDefault(); if (!bad) void save(n(slots), n(lanes)) }}>
      <label className="grid gap-0.5 text-xs text-muted-foreground">Slots
        <input className={cn(fieldClass, 'w-20 tabular-nums')} inputMode="numeric" value={slots} onChange={(e) => setSlots(e.target.value)} aria-label="Slots" />
      </label>
      <label className="grid gap-0.5 text-xs text-muted-foreground">Database lanes (1-9)
        <input className={cn(fieldClass, 'w-20 tabular-nums')} inputMode="numeric" value={lanes} onChange={(e) => setLanes(e.target.value)} aria-label="Database lanes" />
      </label>
      <Button size="sm" type="submit" disabled={busy || bad}>Save</Button>
      <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => void save(null, null)}>Use the runner's own file</Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button>
      <p className="basis-full text-xs text-muted-foreground">
        A lower number applies at once. A higher one takes effect when the runner restarts; a new slot's first job downloads the code fresh, and
        more slots use more memory on that machine.
      </p>
    </form>
  )
}
