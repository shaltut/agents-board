import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ago } from '@/lib/format'
import { actorLabel as who, historyLines, summarizeSquad, type SquadPage } from '@/lib/squad'

const stamp = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/** The last 20 squad saves, newest first: who, when, from where, what changed, and the whole squad as it was saved. */
export function SquadHistory({ history }: { history: SquadPage['history'] }) {
  const [open, setOpen] = useState<number | null>(null)
  if (history.length === 0) return <p className="text-sm text-muted-foreground">No saves yet.</p>
  return (
    <ol className="divide-y rounded-lg border bg-card">
      {history.map((h, i) => (
        <li key={h.id} className="px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="font-medium" title={h.actor}>{who(h.actor)}</span>
            <time dateTime={h.at} title={ago(h.at)} className="text-muted-foreground tabular-nums">{stamp(h.at)}</time>
            {h.via && <span className="text-xs text-muted-foreground">{h.via === 'page' ? 'on this page' : 'from the command line'}</span>}
            {h.version != null && <span className="text-xs text-muted-foreground">version {h.version}</span>}
            <Button variant="ghost" size="xs" className="ml-auto" aria-expanded={open === h.id} onClick={() => setOpen(open === h.id ? null : h.id)}>
              {open === h.id ? 'Hide the squad' : 'View the squad'}
            </Button>
          </div>
          <ul className="mt-1 space-y-0.5 text-[13px] text-pretty">
            {historyLines(history, i).map((l, j) => <li key={j}>{l}</li>)}
          </ul>
          {open === h.id && (
            <ul className="mt-2 space-y-0.5 rounded-md bg-raised px-3 py-2 text-[13px] text-pretty">
              {summarizeSquad(h.squad).map((l, j) => <li key={j}>{l}</li>)}
            </ul>
          )}
        </li>
      ))}
    </ol>
  )
}
