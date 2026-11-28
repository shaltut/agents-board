import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { get, rpc } from '@/lib/api'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLeads } from '@/views/Sessions'
import { ROLE_TEXT_CAP, actorLabel, charCount, handEdited, plural, roleTextLabel, roleTextState, saveError, seedChanges, type RoleTextPage } from '@/lib/squad'
import { Notice } from './bits'

const useRoleTexts = () => useQuery({ queryKey: ['role-texts'], queryFn: () => rpc<RoleTextPage>('role_text_page', {}) })
const useSeeds = () => useQuery({ queryKey: ['role-text-seeds'], queryFn: () => get<Record<string, string>>('/api/role-text-seeds') })

/** #4525: setup never replaces a stored text (Q2969), so a release's new texts wait here until Ahmed loads them. All at
 *  once (cb.role_text_import: one transaction), each change kept under Last edits with the text before. */
function LoadNewTexts({ roles }: { roles: RoleTextPage['roles'] }) {
  const qc = useQueryClient()
  const seeds = useSeeds()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  if (seeds.isError) console.error('release role texts did not load', seeds.error)
  const changes = seeds.data ? seedChanges(seeds.data, roles) : []
  if (changes.length === 0) return null
  // a text changed on this page also differs from the release's: say so, so loading never overwrites an edit unseen
  const edited = handEdited(changes, roles)
  async function load() {
    setBusy(true); setFailed(null)
    try {
      const r = await rpc<{ changed: string[] }>('role_text_import', { texts: seeds.data })
      await qc.invalidateQueries({ queryKey: ['role-texts'] })
      setAsking(false)
      toast.success(`Loaded ${plural(r.changed.length, 'new text')}`, { description: 'Seats read them the next time they read their role.' })
    } catch (e) {
      console.error('loading the release role texts failed', e)
      setFailed(saveError(e, 'The new texts were not loaded. Nothing changed; try again.').text)
    } finally { setBusy(false) }
  }
  return (
    <Notice action={asking ? (
      <span className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => { setAsking(false); setFailed(null) }}>Cancel</Button>
        <Button size="sm" disabled={busy} onClick={load}>{busy ? 'Loading…' : `Replace ${plural(changes.length, 'text')}`}</Button>
      </span>
    ) : <Button size="sm" variant="outline" onClick={() => setAsking(true)}>Load the new texts</Button>}>
      {plural(changes.length, 'saved text')} {changes.length === 1 ? 'differs' : 'differ'} from the ones this version of the board ships: {changes.map(roleTextLabel).join(', ')}.
      {edited.length > 0 && ` Changed on this page since: ${edited.map(roleTextLabel).join(', ')}.`}
      {asking ? ' Loading replaces what is saved below with the shipped texts, your edits included; each old text stays under Last edits.' : ' Nothing changes until you load them.'}
      {failed && <span className="mt-1 block text-destructive" role="alert">{failed}</span>}
    </Notice>
  )
}

/** The eight board-wide texts (Q2969: the database owns them; the repo files only seed a missing one). Seats read a new
 *  text the next time they read their role. */
export function RoleTexts() {
  const { data, isLoading, isError, error } = useRoleTexts()
  if (isError) console.error('role texts did not load', error)
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading the role texts…</p>
  if (!data) return <Notice tone="error">The role texts did not load. Reload the page to try again.</Notice>
  return (
    <div className="space-y-6">
      <LoadNewTexts roles={data.roles} />
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
  const leads = useLeads()
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
          {row.updated_by ? `changed by ${actorLabel(row.updated_by, leads)} ${ago(row.updated_at)}` : 'as first installed'}
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
  const leads = useLeads()
  if (edits.length === 0) return <p className="text-sm text-muted-foreground">No edits yet: every text is as first installed.</p>
  return (
    <ol className="divide-y rounded-lg border bg-card">
      {edits.map((e) => (
        <li key={e.id} className="px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium">{roleTextLabel(e.role)}</span>
            <span className="text-muted-foreground" title={e.actor}>by {actorLabel(e.actor, leads)}</span>
            <time dateTime={e.at} className="text-muted-foreground">{ago(e.at)}</time>
            <span className="text-xs text-muted-foreground tabular-nums">{charCount(e.before ?? '').toLocaleString()} → {charCount(e.after).toLocaleString()} characters</span>
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
