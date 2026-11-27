import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { rpc, useProjects, type Project } from '@/lib/api'
import { href } from '@/lib/route'
import { saveError } from '@/lib/squad'
import { STATE_LABEL, actions, confirmText, countsLine, doneText, groups, stateLine, type Action, type Preview, type State } from '@/lib/projects'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ProjectDot } from '@/components/Chips'

/** The Projects page (#4559 slice 2), in place of the old settings chooser: every project with its state, and Ahmed's
 *  Enable, Disable, Archive and Unarchive. Disable and Archive ask first, with the counts cb.project_state_preview
 *  reads. Owner only: App.tsx keeps other admins off the page, and the server refuses their change (OWNER_ONLY). */
export function ProjectsList() {
  const { data: projects = [], isLoading } = useProjects()
  const [asking, setAsking] = useState<{ p: Project; to: 'disabled' | 'archived'; pv: Preview } | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // the slug being changed
  const qc = useQueryClient()
  const { shown, archived } = groups(projects)

  async function change(p: Project, to: State) {
    setBusy(p.slug)
    try {
      await rpc('project_state', { project: p.slug, state: to })
      setAsking(null)
      toast.success(doneText(p.name, p.state, to))
      await qc.invalidateQueries() // the pickers, the lamp, the All projects views and the banner all read the state
    } catch (e) {
      console.error('project_state failed', e)
      toast.error(saveError(e, `${p.name} did not change. Reload the page and try again.`).text)
    } finally { setBusy(null) }
  }

  async function act(p: Project, a: Action) {
    if (!a.confirm) return change(p, a.to)
    setBusy(p.slug)
    try {
      const pv = await rpc<Preview>('project_state_preview', { project: p.slug })
      setAsking({ p, to: a.to as 'disabled' | 'archived', pv })
    } catch (e) {
      console.error('project_state_preview failed', e)
      toast.error(`Could not read what this touches in ${p.name}. Reload the page and try again.`)
    } finally { setBusy(null) }
  }

  const ask = asking && confirmText(asking.to, asking.pv)
  return (
    <div>
      <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Projects</h1>
      <p className="mt-1 mb-5 max-w-[80ch] text-sm text-muted-foreground text-pretty">
        Only enabled projects show in the header and get work. Disable one to stop new work there; nothing is deleted, and
        Enable brings it all back. Archive a disabled one to put it away.
      </p>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading projects…</p> : (
        <>
          <ul className="divide-y rounded-lg border bg-card">
            {shown.map((p) => <Row key={p.slug} p={p} busy={busy === p.slug} onAct={(a) => act(p, a)} />)}
            {shown.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No project is enabled or disabled.</li>}
          </ul>
          {archived.length > 0 && (
            <details className="mt-4 rounded-lg border bg-card">
              <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium">Archived ({archived.length})</summary>
              <ul className="divide-y border-t">
                {archived.map((p) => <Row key={p.slug} p={p} busy={busy === p.slug} onAct={(a) => act(p, a)} />)}
              </ul>
            </details>
          )}
        </>
      )}
      <Dialog open={!!asking} onOpenChange={(o) => { if (!o) setAsking(null) }}>
        {asking && ask && (
          <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{ask.title}</DialogTitle>
              <DialogDescription>{ask.lead}</DialogDescription>
            </DialogHeader>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-pretty">{ask.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
              <Button type="button" variant={asking.to === 'disabled' ? 'destructive' : 'default'} disabled={busy === asking.p.slug}
                onClick={() => change(asking.p, asking.to)}>{busy === asking.p.slug ? 'Changing…' : ask.button}</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

const PILL: Record<State, string> = {
  enabled: 'bg-raised text-foreground',
  disabled: 'bg-lamp-soft text-lamp-ink',
  archived: 'bg-raised text-muted-foreground',
}

/** One project: name and state, the counts, then Settings and the state buttons. On a phone the three stack. */
function Row({ p, busy, onAct }: { p: Project; busy: boolean; onAct: (a: Action) => void }) {
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <ProjectDot slug={p.slug} />
          <span className="truncate font-medium">{p.name}</span>
          <StatePill state={p.state} />
        </div>
        <p className="mt-0.5 text-[13px] text-muted-foreground text-pretty">
          {p.state !== 'enabled' && <>{stateLine(p)} · </>}{countsLine(p)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {p.state !== 'archived' && (
          <Button variant="ghost" size="sm" asChild><a href={href({ view: 'settings', project: p.slug })}>Settings</a></Button>
        )}
        {actions(p.state).map((a) => (
          <Button key={a.to} variant="outline" size="sm" disabled={busy} onClick={() => onAct(a)}>{a.label}</Button>
        ))}
      </div>
    </li>
  )
}

export function StatePill({ state, className }: { state: State; className?: string }) {
  return <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs', PILL[state], className)}>{STATE_LABEL[state]}</span>
}
