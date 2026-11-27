import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { rpc } from '@/lib/api'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ROLE_TEXT_CAP, actorLabel, roleTextLabel, roleTextState, saveError, type RoleTextPage } from '@/lib/squad'
import { Notice } from './bits'

const useRoleTexts = () => useQuery({ queryKey: ['role-texts'], queryFn: () => rpc<RoleTextPage>('role_text_page', {}) })

/** The eight board-wide texts (Q2969: the database owns them; the repo files only seed a missing one). Seats read a new
 *  text the next time they read their role. */
export function RoleTexts() {
  const { data, isLoading, isError, error } = useRoleTexts()
  if (isError) console.error('role texts did not load', error)
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading the role texts…</p>
  if (!data) return <Notice tone="error">The role texts did not load. Reload the page to try again.</Notice>
  return (
    <div className="space-y-6">
      <ul className="grid gap-3 lg:grid-cols-2">
        {data.roles.map((r) => <RoleText key={r.role} row={r} />)}
      </ul>
      <div>
        <h3 className="mb-2 font-medium">Last edits</h3>
        <Edits edits={data.edits} />
      </div>
    </div>
  )
}

function RoleText({ row }: { row: RoleTextPage['roles'][number] }) {
  const qc = useQueryClient()
  const [body, setBody] = useState<string | null>(null) // null: not editing
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const label = roleTextLabel(row.role)
  const st = roleTextState(body ?? row.body, row.body)

  async function save() {
    if (body === null || !st.canSave) return
    setBusy(true); setFailed(null)
    try {
      await rpc('role_text_set', { role: row.role, body })
      await qc.invalidateQueries({ queryKey: ['role-texts'] })
      setBody(null)
      toast.success(`Saved the text for ${label}`, { description: 'Seats read it the next time they read their role.' })
    } catch (e) {
      console.error('role text save failed', e)
      setFailed(saveError(e, 'The text was not saved. Nothing changed; try again.').text)
    } finally { setBusy(false) }
  }

  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="font-medium">{label}</h3>
        <span className="text-xs text-muted-foreground">
          {row.updated_by ? `changed by ${actorLabel(row.updated_by)} ${ago(row.updated_at)}` : 'as first installed'}
        </span>
        {body === null && <Button variant="outline" size="sm" className="ml-auto" onClick={() => setBody(row.body)}>Edit</Button>}
      </div>
      {body === null ? (
        <p className="line-clamp-3 text-[13px] whitespace-pre-line text-muted-foreground">{row.body}</p>
      ) : (
        <>
          <Textarea aria-label={`Text for ${label}`} value={body} onChange={(e) => setBody(e.target.value)} rows={14}
            className="max-h-[60vh] min-h-48 overflow-auto font-mono text-xs" spellCheck={false} />
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('text-xs tabular-nums', st.over ? 'font-medium text-destructive' : 'text-muted-foreground')} aria-live="polite">
              {st.count.toLocaleString()} of {ROLE_TEXT_CAP.toLocaleString()} characters
            </span>
            {st.over && <span className="text-xs text-destructive">Too long: every seat reads this when it starts. Cut it down.</span>}
            {st.empty && <span className="text-xs text-destructive">Write what this role does.</span>}
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => { setBody(null); setFailed(null) }}>Cancel</Button>
            <Button size="sm" disabled={!st.canSave || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
          {failed && <p className="text-[13px] text-destructive" role="alert">{failed}</p>}
        </>
      )}
    </li>
  )
}

function Edits({ edits }: { edits: RoleTextPage['edits'] }) {
  const [open, setOpen] = useState<number | null>(null)
  if (edits.length === 0) return <p className="text-sm text-muted-foreground">No edits yet: every text is as first installed.</p>
  return (
    <ol className="divide-y rounded-lg border bg-card">
      {edits.map((e) => (
        <li key={e.id} className="px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium">{roleTextLabel(e.role)}</span>
            <span className="text-muted-foreground" title={e.actor}>by {actorLabel(e.actor)}</span>
            <time dateTime={e.at} className="text-muted-foreground">{ago(e.at)}</time>
            <span className="text-xs text-muted-foreground tabular-nums">{(e.before ?? '').length.toLocaleString()} → {e.after.length.toLocaleString()} characters</span>
            <Button variant="ghost" size="xs" className="ml-auto" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
              {open === e.id ? 'Hide' : 'Before and after'}
            </Button>
          </div>
          {open === e.id && (
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <Pane title="Before" text={e.before ?? '(no text yet)'} />
              <Pane title="After" text={e.after} />
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}

const Pane = ({ title, text }: { title: string; text: string }) => (
  <div className="min-w-0">
    <div className="mb-1 text-xs text-muted-foreground">{title}</div>
    <pre className="max-h-80 overflow-auto rounded-md bg-raised p-2 font-mono text-xs whitespace-pre-wrap break-words">{text}</pre>
  </div>
)
