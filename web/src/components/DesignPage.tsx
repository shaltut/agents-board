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
export function DesignPage({ t }: { t: Pick<Task, 'id' | 'stage'> }) {
  const qc = useQueryClient()
  const { data: page } = usePage(t.id, true)
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState('')
  const [showApproved, setShowApproved] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { if (!edit) setText(page?.body ?? '') }, [page?.body, edit])
  if (!page && !t.stage) return null

  const changed = page && page.approved_version != null && page.approved_version !== page.version
  async function save() {
    try {
      await rpc('page_set', { task: String(t.id), body: text })
      setErr(''); setEdit(false)
      await qc.invalidateQueries()
    } catch (e: any) { setErr(e.message) }
  }

  return (
    <section className="border-b p-5">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">Design page</h3>
        {page && <span className="callsign text-xs text-muted-foreground">v{page.version}</span>}
        {page && <span className="text-xs text-muted-foreground">by <ActorChip actor={page.updated_by} /> {ago(page.updated_at)}</span>}
        {page && !edit && <button onClick={() => { setErr(''); setEdit(true) }} className="ml-auto rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-raised hover:text-foreground">Edit</button>}
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
      ) : page ? <Md>{showApproved && changed ? page.approved_body ?? '' : page.body}</Md>
        : <p className="text-sm text-muted-foreground">No design page yet.</p>}
    </section>
  )
}
