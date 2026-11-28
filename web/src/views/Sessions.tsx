import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeft } from 'lucide-react'
import { get, qs, rpc, useDigest, useProjects, useQuestions, useTasks, type CbEvent, type Task } from '@/lib/api'
import { ago, splitActor, STATUS } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { liveRows } from '@/lib/projects'
import { cn } from '@/lib/utils'
import { ActorChip, Priority, ProjectChip, StatusDot, TaskId } from '@/components/Chips'
import { Timeline } from '@/components/Timeline'
import { Md } from '@/components/Md'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export interface SessionRow {
  actor: string; project: string | null; machine: string | null; pane: string | null; last_seen: string | null; live: boolean
  lead?: boolean // leads its project (by role, #3746, #3771)
  doing: { id: number; title: string; priority: Task['priority']; status: Task['status'] }[]
  queued: number; done_24h: number; open_questions: number
  last: { at: string; kind: string; summary: string; task_id: number | null } | null
}

// last_seen moves every time the session's relay checks in, so poll to keep the live dots honest.
export const useSessions = (project?: string) =>
  useQuery({ queryKey: ['sessions', project], queryFn: () => get<SessionRow[]>(`/api/sessions${qs({ project })}`), refetchInterval: 30_000 })

/** The names that lead their project (sessions_overview's lead, by role: #3746, #3779), for actorLabel. undefined until read. */
export function useLeads(): ReadonlySet<string> | undefined {
  const { data } = useSessions()
  return useMemo(() => data && new Set(data.filter((s) => s.lead).map((s) => s.actor)), [data])
}

export function Sessions({ route }: { route: Route }) {
  const { data: rows = [], isLoading } = useSessions(route.project)
  const projects = useProjects().data
  const pipeline = !!projects?.find((p) => p.slug === route.project)?.pipeline
  const { data: digest = [] } = useDigest(route.project, pipeline)
  if (route.actor) return <SessionDetail route={route} row={rows.find((s) => s.actor === route.actor)} />
  const data = route.project ? rows : liveRows(rows, projects ?? [])
  const live = data.filter((s) => s.live).length
  const asking = data.filter((s) => s.open_questions > 0).length

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Sessions</h1>
        {data.length > 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            {data.length} known, {live} with a live relay{asking > 0 && <>; <span className="font-medium text-lamp">{asking} asking you</span></>}.
          </p>
        )}
        {digest.length > 0 && (
          <div className="mt-3 text-sm" aria-label="Digest">
            <p className="font-medium">Digest</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">{digest.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </div>
        )}
      </header>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading sessions…</p>
        : data.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <p className="font-medium">No sessions yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">A session appears once it runs <code className="font-mono text-xs">cb iam &lt;name&gt; &lt;project&gt;</code> or does work on the board.</p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {data.filter((s) => !quiet(s)).map((s) => <SessionCard key={s.actor} s={s} showProject={!route.project} />)}
            </div>
            {data.some(quiet) && (
              <details className="group mt-8 text-sm">
                <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
                  {data.filter(quiet).length} quiet sessions: no relay, nothing open
                </summary>
                <div className="mt-3 flex flex-wrap gap-2">
                  {data.filter(quiet).map((s) => (
                    <button key={s.actor} onClick={() => go({ actor: s.actor })}
                      className="flex items-baseline gap-2 rounded-md border bg-card px-2.5 py-1.5 text-muted-foreground hover:border-input hover:text-foreground">
                      <ActorChip actor={s.actor} />{s.last && <span className="text-xs tabular-nums">{ago(s.last.at)}</span>}
                    </button>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
    </div>
  )
}

/** Relay state: a steady green light when answers reach the session by themselves. */
export function LiveDot({ s }: { s: SessionRow }) {
  const title = s.live ? 'Relay live: answers and changes reach this session by themselves'
    : s.last_seen ? `Relay last checked in ${ago(s.last_seen)}` : 'No relay: this session only sees the board when it runs cb'
  return (
    <span title={title} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn('size-2 shrink-0 rounded-full', s.live ? 'bg-clear shadow-[0_0_8px_var(--clear)]' : 'border border-muted-foreground/60')} />
      {s.live ? 'relay live' : s.last_seen ? `relay seen ${ago(s.last_seen)}` : 'no relay'}
    </span>
  )
}

/** A callsign plate: who, where, what it's doing, and a lit lamp while it is asking you something. */
function SessionCard({ s, showProject }: { s: SessionRow; showProject: boolean }) {
  const { who, where } = splitActor(s.actor)
  const asking = s.open_questions > 0
  return (
    <button onClick={() => go({ actor: s.actor })}
      className={cn('group flex flex-col gap-3 rounded-lg border bg-card p-4 text-left outline-none transition-colors duration-150 hover:border-input focus-visible:ring-2 focus-visible:ring-ring',
        asking && 'shadow-[inset_3px_0_0_var(--lamp)]')}>
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1" translate="no">
            <span className="callsign text-[26px] leading-none">{who}</span>
            {where && <span className="text-sm text-muted-foreground">@{where}</span>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <LiveDot s={s} />
            {showProject && s.project && <ProjectChip slug={s.project} />}
          </div>
        </div>
        {asking && (
          <span className="ml-auto flex shrink-0 items-center gap-2 rounded-full bg-lamp-soft py-1 pr-2.5 pl-2 text-xs font-medium text-lamp-ink">
            <span className="lamp size-2" />asking you{s.open_questions > 1 && ` (${s.open_questions})`}
          </span>
        )}
      </div>

      {s.doing.length > 0 ? (
        <ul className="space-y-1.5 border-t pt-3">
          {s.doing.slice(0, 3).map((t) => (
            <li key={t.id} className="flex items-center gap-2 text-sm">
              <StatusDot status={t.status} />
              <TaskId id={t.id} />
              <span className="line-clamp-1">{t.title}</span>
            </li>
          ))}
          {s.doing.length > 3 && <li className="pl-5.5 text-xs text-muted-foreground">and {s.doing.length - 3} more</li>}
        </ul>
      ) : <p className="border-t pt-3 text-sm text-muted-foreground">Nothing in progress.</p>}

      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span><b className="callsign text-[14px] text-foreground">{s.queued}</b> queued</span>
        <span><b className="callsign text-[14px] text-foreground">{s.done_24h}</b> done today</span>
        {s.last && <span className="ml-auto truncate tabular-nums" title={s.last.summary}>active {ago(s.last.at)}</span>}
      </div>
    </button>
  )
}

const quiet = (s: SessionRow) => !s.live && s.doing.length === 0 && s.queued === 0 && s.open_questions === 0

const OPEN: Task['status'][] = ['in_progress', 'blocked', 'review', 'next', 'backlog']

/** Type into the session as if at its terminal: the relay hands it over as an ordinary prompt, exactly this text. */
function TypeBox({ actor, live }: { actor: string; live: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  async function send() {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      await rpc('type_to', { to_actor: actor, message: text })
      setText('')
      toast.success(live ? 'Sent: it arrives in the session within seconds' : 'Queued: it arrives when the session\'s relay is back (held 24 h)')
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }
  return (
    <section aria-labelledby="type" className="mb-8">
      <h2 id="type" className="mb-2 text-sm font-semibold">Type to this session</h2>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} disabled={busy}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() } }}
        placeholder="Sent as a normal prompt, as if you typed it in its terminal. Ctrl+Enter to send." />
      <div className="mt-2 flex items-center gap-3">
        <Button onClick={send} disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</Button>
        <span className="text-xs text-muted-foreground">Plain text only: no slash commands, no permission dialogs.</span>
      </div>
    </section>
  )
}

function SessionDetail({ route, row }: { route: Route; row?: SessionRow }) {
  const actor = route.actor!
  const { who, where } = splitActor(actor)
  const { data: tasks = [] } = useTasks(route.project)
  const { data: questions = [] } = useQuestions(route.project)
  const { data: events = [] } = useQuery({
    queryKey: ['events', 'actor', actor, route.project],
    queryFn: () => get<CbEvent[]>(`/api/events${qs({ actor, project: route.project, limit: '100' })}`),
  })
  const mine = tasks.filter((t) => t.assignee === actor && OPEN.includes(t.status)).sort((a, b) => OPEN.indexOf(a.status) - OPEN.indexOf(b.status))
  const asked = questions.filter((q) => q.asked_by === actor && q.status !== 'withdrawn').slice(0, 20)

  return (
    <div>
      <a href="#/sessions" onClick={(e) => { e.preventDefault(); go({ actor: undefined }) }}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> All sessions
      </a>
      <header className="mb-8">
        <h1 className="flex items-baseline gap-1" translate="no">
          <span className="callsign text-[40px] leading-none">{who}</span>
          {where && <span className="text-lg text-muted-foreground">@{where}</span>}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {row && <LiveDot s={row} />}
          {row?.project && <ProjectChip slug={row.project} />}
          {row?.pane && <span className="text-xs">pane <span className="font-mono">{row.pane}</span> on {row.machine}</span>}
        </div>
      </header>

      {row && <TypeBox actor={actor} live={row.live} />}

      <div className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-0">
        <div className="space-y-10 lg:pr-10">
          <section aria-labelledby="work">
            <h2 id="work" className="mb-2 text-sm font-semibold">Assigned work <span className="font-normal text-muted-foreground tabular-nums">{mine.length}</span></h2>
            {mine.length === 0 ? <p className="text-sm text-muted-foreground">Nothing assigned.</p> : (
              <ul className="divide-y overflow-hidden rounded-lg border bg-card">
                {mine.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => go({ task: t.id })} className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-raised/60">
                      <StatusDot status={t.status} /><span className="w-20 shrink-0 text-xs text-muted-foreground">{STATUS[t.status].label}</span>
                      <TaskId id={t.id} /><Priority p={t.priority} /><span className="line-clamp-1 font-medium">{t.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="asked">
            <h2 id="asked" className="mb-2 text-sm font-semibold">Questions it asked <span className="font-normal text-muted-foreground tabular-nums">{asked.length}</span></h2>
            {asked.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
              <ul className="space-y-2">
                {asked.map((q) => {
                  const waiting = q.status === 'open' && !q.assigned_to
                  return (
                    <li key={q.id} className={cn('rounded-lg border bg-card p-3 text-sm', waiting && 'shadow-[inset_3px_0_0_var(--lamp)]')}>
                      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="callsign text-[12px]">Q{q.id}</span><span className="tabular-nums">{ago(q.created_at)}</span>
                        <span className={cn('ml-auto flex items-center gap-1.5', waiting && 'font-medium text-lamp')}>
                          {waiting ? <><span className="lamp size-1.5" />waiting on you</> : <span className="capitalize">{q.status}</span>}
                        </span>
                      </div>
                      <Md>{q.body}</Md>
                      {q.answer && <p className="mt-1.5 font-medium text-pretty">{q.answer}</p>}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
        <section aria-labelledby="activity" className="lg:border-l lg:pl-10">
          <h2 id="activity" className="mb-3 text-sm font-semibold">What it did</h2>
          {events.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p>
            : <Timeline events={events} showProject={!route.project} />}
        </section>
      </div>
    </div>
  )
}
