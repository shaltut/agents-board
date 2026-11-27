import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { rpc } from '@/lib/api'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  ADDITION_CAP, actorLabel, additionState, askFirstLabel, askFirstOf, askFirstOk, askFirstValue, saveError, type AskFirst, type ProjectRolePage,
} from '@/lib/squad'
import { NativeSelect, Notice, fieldClass } from './bits'

/** One project's addition to the role texts (Q2992) and who its stuck seats ask first (Q2994), #4525. Seats read both
 *  after the shared texts, the next time they read their role. */
export function ProjectRoleText({ project, name }: { project: string; name: string }) {
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['project-role', project], queryFn: () => rpc<ProjectRolePage>('project_role_page', { project }) })
  const [addition, setAddition] = useState<string | null>(null) // null: as saved
  const [ask, setAsk] = useState<AskFirst | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  if (isError) console.error('project role text did not load', error)
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading this project's additions…</p>
  if (!data) return <Notice tone="error">This project's additions did not load. Reload the page to try again.</Notice>

  const st = additionState(addition ?? data.addition, data.addition)
  const who = ask ?? askFirstOf(data.ask_first)
  const whoChanged = askFirstValue(who) !== data.ask_first
  const whoOk = askFirstOk(who)
  const dirty = st.changed || whoChanged
  const reset = () => { setAddition(null); setAsk(null); setFailed(null) }

  async function save() {
    if (!dirty || st.over || !whoOk) return
    setBusy(true); setFailed(null)
    try {
      await rpc('project_role_set', { project, addition: addition ?? data!.addition, ask_first: askFirstValue(who) })
      await qc.invalidateQueries({ queryKey: ['project-role', project] })
      reset()
      toast.success(`Saved for ${name}`, { description: 'Its seats read it the next time they read their role.' })
    } catch (e) {
      console.error('project role text save failed', e)
      setFailed(saveError(e, 'Nothing was saved. Check the text and the name, then try again.').text)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="font-medium">For {name} only</h3>
        <span className="text-xs text-muted-foreground">
          {data.updated_by ? `changed by ${actorLabel(data.updated_by)} ${ago(data.updated_at!)}` : 'not set yet: no extra rules, and seats ask the lead first'}
        </span>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">This project's own rules</span>
        <span className="block text-[13px] text-muted-foreground">Shown to every seat of this project after the texts below. Leave it empty for none.</span>
        <Textarea value={addition ?? data.addition} onChange={(e) => setAddition(e.target.value)} rows={6}
          className="max-h-[50vh] min-h-28 overflow-auto font-mono text-xs" spellCheck={false} />
      </label>
      <span className={cn('block text-xs tabular-nums', st.over ? 'font-medium text-destructive' : 'text-muted-foreground')} aria-live="polite">
        {st.count.toLocaleString()} of {ADDITION_CAP.toLocaleString()} characters{st.over && ': too long, every seat reads this when it starts. Cut it down.'}
      </span>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Who stuck seats ask first</span>
        <NativeSelect label="Who stuck seats ask first" value={who.kind}
          onChange={(v) => setAsk({ kind: v as AskFirst['kind'], name: v === 'session' ? (who.kind === 'session' ? who.name : '') : '' })}>
          <option value="lead">The lead</option>
          <option value="ahmed">Ahmed</option>
          <option value="session">A session I name</option>
        </NativeSelect>
        {who.kind === 'session' && (
          <>
            <input aria-label="Session name" list={`sessions-${project}`} value={who.name} placeholder="a session name"
              onChange={(e) => setAsk({ kind: 'session', name: e.target.value })} className={cn(fieldClass, 'w-56')} spellCheck={false} />
            <datalist id={`sessions-${project}`}>{data.sessions.map((s) => <option key={s} value={s} />)}</datalist>
          </>
        )}
      </div>
      {!whoOk && <p className="text-[13px] text-destructive">Name one session: letters, digits and @ . _ - only, at most 64.</p>}
      <p className="text-[13px] text-muted-foreground">
        {whoChanged ? `After saving, seats ask ${askFirstLabel(askFirstValue(who)) || 'that session'} first.` : `Now: seats ask ${askFirstLabel(data.ask_first)} first.`}
      </p>
      {dirty && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={reset}>Cancel</Button>
          <Button size="sm" disabled={busy || st.over || !whoOk} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
      {failed && <p className="text-[13px] text-destructive" role="alert">{failed}</p>}
    </div>
  )
}
