import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { rpc, useProjects } from '@/lib/api'
import { ago } from '@/lib/format'
import { RX, actorLabel, saveError, type Watch } from '@/lib/squad'
import { useLeads } from '@/views/Sessions'
import { Notice } from './bits'

/** GitHub watches (#4523, Q2971): the repos whose pull requests come to this project, and the muted logins (board-wide).
 *  The settings table has no live trigger, so every write here re-reads the list itself. */
export function GitHub({ project }: { project: string }) {
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['github-watches', project],
    queryFn: () => rpc<{ watches: Watch[]; muted: string[] }>('github_watches', { project }),
  })
  const { data: projects = [] } = useProjects()
  const pname = (slug: string | null) => projects.find((p) => p.slug === slug)?.name ?? slug ?? 'no project'
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function act(fn: string, args: Record<string, unknown>, ok: string, plain: string) {
    setBusy(true); setFailed(null)
    try {
      await rpc(fn, args)
      await qc.invalidateQueries({ queryKey: ['github-watches'] })
      toast.success(ok)
      return true
    } catch (e) {
      console.error(`${fn} failed`, e)
      setFailed(saveError(e, plain).text)
      return false
    } finally { setBusy(false) }
  }

  if (isError) console.error('GitHub watches did not load', error)
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading the watches…</p>
  if (!data) return <Notice tone="error">The GitHub watches did not load. Reload the page to try again.</Notice>

  return (
    <div className="space-y-5">
      {failed && <Notice tone="error">{failed}</Notice>}
      {data.watches.length === 0 ? <p className="text-sm text-muted-foreground">No repo is watched for this project.</p> : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {data.watches.map((w) => <WatchRow key={w.repo} w={w} project={project} pname={pname} busy={busy}
            onRemove={() => act('github_watch_remove', { repo: w.repo }, `Stopped watching ${w.repo}`, 'The watch was not removed. Try again.')} />)}
        </ul>
      )}
      <AddWatch busy={busy} others={projects.filter((p) => p.slug !== project).map((p) => ({ slug: p.slug, name: p.name }))}
        onAdd={(repo, tell, cardsIn) => act('github_watch_add', { repo, project, tell: tell || null, cards_in: cardsIn.length ? cardsIn : null },
          `Watching ${repo}`, 'The watch was not added. Check the repo name, or name the session it tells, and try again.')} />
      <Muted muted={data.muted} busy={busy}
        onMute={(login, mute) => act('github_mute', { login, mute }, mute ? `Muted ${login}` : `Unmuted ${login}`,
          mute ? 'That login was not muted. Try again.' : 'That login was not unmuted. Try again.')} />
    </div>
  )
}

function WatchRow({ w, project, pname, busy, onRemove }: {
  w: Watch; project: string; pname: (s: string | null) => string; busy: boolean; onRemove: () => void
}) {
  const [sure, setSure] = useState(false)
  const leads = useLeads()
  const also = (w.card_projects ?? []).filter((p) => p !== w.project)
  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-medium">{w.repo}</span>
        {sure ? (
          <span className="ml-auto flex items-center gap-1">
            <Button variant="destructive" size="xs" disabled={busy} onClick={onRemove}>Stop watching</Button>
            <Button variant="ghost" size="xs" onClick={() => setSure(false)}>Keep</Button>
          </span>
        ) : <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label={`Stop watching ${w.repo}`} onClick={() => setSure(true)}><X /></Button>}
      </div>
      <div className="text-muted-foreground">
        Its pull requests become cards in {w.project === project ? 'this project' : pname(w.project)}
        {also.length > 0 && `, and may note cards in ${also.map(pname).join(', ')}`}.
      </div>
      {w.project !== project && <div className="text-[13px] text-muted-foreground">It logs on this project's cards, so it is listed here too.</div>}
      <div className="text-muted-foreground">Tells <span className="text-foreground" title={w.to ?? undefined}>{w.to ? actorLabel(w.to, leads) : 'nobody yet'}</span>
        {w.since && <> · watching since {new Date(w.since).toLocaleDateString([], { day: 'numeric', month: 'short' })}</>}
      </div>
      <div className="text-[13px]">
        {w.last_error ? <span className="text-destructive">The last check had a problem; the board keeps trying.</span>
          : w.last_ok ? <span className="text-muted-foreground">Last checked {ago(w.last_ok)}.</span>
            : <span className="text-muted-foreground">Not checked yet.</span>}
      </div>
    </li>
  )
}

function AddWatch({ others, busy, onAdd }: {
  others: { slug: string; name: string }[]; busy: boolean
  onAdd: (repo: string, tell: string, cardsIn: string[]) => Promise<boolean>
}) {
  const [repo, setRepo] = useState('')
  const [tell, setTell] = useState('')
  const [cardsIn, setCardsIn] = useState<string[]>([])
  const ok = RX.repo.test(repo) && !repo.split('/').some((p) => p.startsWith('.'))
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <h3 className="text-sm font-medium">Watch a repo for this project</h3>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Repo to watch, as owner/name" placeholder="owner/name, like acme/widgets" value={repo} spellCheck={false}
          onChange={(e) => setRepo(e.target.value.trim())} className="h-8 w-60 font-mono text-xs" />
        <Input aria-label="Session it tells (empty: the project's lead)" placeholder="tells: the lead" value={tell} spellCheck={false}
          onChange={(e) => setTell(e.target.value.trim())} className="h-8 w-48 font-mono text-xs" />
        <Button variant="outline" size="sm" disabled={!ok || busy} onClick={async () => { if (await onAdd(repo, tell, cardsIn)) { setRepo(''); setTell(''); setCardsIn([]) } }}>
          <Plus /> Watch
        </Button>
      </div>
      {repo && !ok && <p className="text-[13px] text-destructive">Give the repo as owner/name, like acme/widgets.</p>}
      {others.length > 0 && (
        <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <legend className="mb-1 text-xs text-muted-foreground">Its pull requests may also note cards in</legend>
          {others.map((p) => (
            <label key={p.slug} className="flex items-center gap-1.5">
              <input type="checkbox" className="size-4" checked={cardsIn.includes(p.slug)}
                onChange={(e) => setCardsIn(e.target.checked ? [...cardsIn, p.slug] : cardsIn.filter((x) => x !== p.slug))} />
              {p.name}
            </label>
          ))}
        </fieldset>
      )}
      <p className="text-[13px] text-muted-foreground">A watch starts now: older pull requests are not brought in. Adding a repo that is already watched changes only what you fill in: its next pull requests come to this project, and the cards it already made stay where they are.</p>
    </div>
  )
}

function Muted({ muted, busy, onMute }: { muted: string[]; busy: boolean; onMute: (login: string, mute: boolean) => Promise<boolean> }) {
  const [login, setLogin] = useState('')
  const ok = RX.login.test(login) && !muted.includes(login)
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Muted GitHub logins <span className="font-normal text-muted-foreground">(for every project)</span></h3>
      <p className="max-w-[80ch] text-[13px] text-muted-foreground">Pull requests, comments and reviews from these logins don't reach the board (failed checks still do). Mute the logins your own agents post as.</p>
      <div className="flex flex-wrap gap-2">
        {muted.length === 0 && <span className="text-sm text-muted-foreground">Nobody is muted.</span>}
        {muted.map((m) => (
          <span key={m} className="inline-flex items-center gap-1 rounded-md border bg-card py-0.5 pr-0.5 pl-2 font-mono text-xs">
            {m}
            <Button variant="ghost" size="icon-xs" aria-label={`Unmute ${m}`} disabled={busy} onClick={() => onMute(m, false)}><X /></Button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="GitHub login to mute" placeholder="login" value={login} spellCheck={false}
          onChange={(e) => setLogin(e.target.value.trim().toLowerCase())} className="h-8 w-48 font-mono text-xs" />
        <Button variant="outline" size="sm" disabled={!ok || busy} onClick={async () => { if (await onMute(login, true)) setLogin('') }}>Mute</Button>
      </div>
    </div>
  )
}
