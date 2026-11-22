import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { rpc, usePage, type Task } from '@/lib/api'
import { ago } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ActorChip } from './Chips'
import { Md } from './Md'

/** A pipeline card's design page. Edit is Ahmed's: he corrects findings himself and the session re-reads the page.
 *  While the card waits for his approval the page is frozen: the refusal's words are shown as they are.
 *  ponytail: no diff view between the approved version and now; add one if Ahmed asks. */
export function DesignPage({ t }: { t: Pick<Task, 'id' | 'stage' | 'type'> }) {
  const qc = useQueryClient()
  const { data: page, isLoading, isError } = usePage(t.id, true)
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState('')
  const [showApproved, setShowApproved] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { if (!edit) setText(page?.body ?? '') }, [page?.body, edit])
  if (isLoading || (!page && !t.stage && !isError)) return null
  const title = t.type === 'research' ? 'Investigation page' : 'Design page'
  const locked = t.stage === 'approval'

  const changed = page && page.approved_version != null && page.approved_version !== page.version
  // the header follows what is shown: the approved version carries its own number, author and time
  const approvedOn = !!changed && showApproved
  const shown = page && (approvedOn
    ? { version: page.approved_version, by: page.approved_by ?? 'unknown', at: page.approved_at ?? page.updated_at }
    : { version: page.version, by: page.updated_by, at: page.updated_at })
  async function save() {
    try {
      await rpc('page_set', { task: String(t.id), body: text, base_version: page?.version })
      setErr(''); setEdit(false)
      await qc.invalidateQueries()
    } catch (e: any) { setErr(e.message) }
  }

  return (
    <section className="border-b p-5">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {page && <span className="callsign text-xs text-muted-foreground">v{shown?.version}</span>}
        {page && shown && <span className="text-xs text-muted-foreground">by <ActorChip actor={shown.by} /> {ago(shown.at)}</span>}
        {page && locked && <span className="ml-auto text-xs text-muted-foreground">Locked while it waits for your approval</span>}
        {page && !locked && !edit && <button onClick={() => { setErr(''); setEdit(true) }} className="ml-auto rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-raised hover:text-foreground">Edit</button>}
      </div>
      {changed && (
        <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-lamp-ink">
          <span>changed since you approved v{page.approved_version}</span>
          <button onClick={() => setShowApproved((v) => !v)} className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-raised hover:text-foreground">
            {showApproved ? 'Show the current page' : `Show v${page.approved_version}`}
          </button>
        </p>
      )}
      {edit ? (
        <div className="space-y-2">
          <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={12} className="font-mono text-xs" aria-label="Design page (markdown)" />
          {err && <p role="alert" className="text-sm text-st-blocked">{err}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={save}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEdit(false); setErr('') }}>Cancel</Button>
          </div>
        </div>
      ) : page ? approvedOn && !page.approved_body ? <p className="text-sm text-muted-foreground">The approved version is not available.</p>
        : <Md>{approvedOn ? page.approved_body! : page.body}</Md>
        : isError ? <p className="text-sm text-muted-foreground">The page could not be loaded. Reload to try again.</p>
        : <p className="text-sm text-muted-foreground">No page yet.</p>}
    </section>
  )
}
