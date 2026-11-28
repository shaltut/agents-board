import { useQuery } from '@tanstack/react-query'
import type { Ask } from './asks'

export type Status = 'backlog' | 'next' | 'in_progress' | 'blocked' | 'review' | 'done' | 'cancelled'

export interface Project { slug: string; name: string; color: string | null; repo_path: string | null; pipeline: boolean; open_count: number; question_count: number
  state: 'enabled' | 'disabled' | 'archived'; state_by: string | null; state_at: string | null // #4559
  in_progress_count: number; seats_live: number; cards_count: number } // the Projects page's row counts (#4559 slice 2)
export type Stage = 'design' | 'approval' | 'build' | 'review' | 'merge' | 'qa'
export const TASK_TYPES = ['task', 'bug', 'feature', 'change', 'chore', 'research'] as const
export interface Task {
  id: number; project: string; title: string; body: string; status: Status; priority: 'P0' | 'P1' | 'P2' | 'P3'; type: (typeof TASK_TYPES)[number]
  rank: number; assignee: string | null; labels: string[]; links: Record<string, string | string[]>
  blocked_on: number | null; created_by: string; created_at: string; updated_at: string; done_at: string | null
  epic_id: number | null; epic_rank: number
  stage: Stage | null; crew: Record<string, string>; approved_version: number | null // the squad pipeline (#3598)
  ping?: boolean // Ahmed asked the board to chase it (task_pings), from /api/tasks
  goal_rank?: number | null; goal_id?: number | null // the active goal that lifts it in Next (#663), from /api/tasks
  waits_on?: number[] // open blockers (not done or cancelled): "waits on #12"
}
/** A task as the panel lists its blockers and what it blocks. */
export type TaskRef = Pick<Task, 'id' | 'title' | 'status' | 'assignee'>
export interface Epic {
  id: number; project: string; title: string; goal: string; created_by: string; created_at: string; closed_at: string | null
  closed: boolean; status: 'open' | 'done'; total: number; done: number; cancelled: number; finished: number
}
/** Goals (#663): total = cards in, closed = done or cancelled among them, new = joined since Ahmed last opened it. */
export interface GoalRules { labels: string[]; words: string[]; epics: number[] }
export interface Goal {
  id: number; title: string; description: string; project: string | null; rules: GoalRules; status: 'active' | 'paused' | 'done'
  rank: number; created_by: string; created_at: string; closed_at: string | null; total: number; closed: number; new: number
}
export type GoalCard = Task & { state: 'in' | 'out'; via: 'match' | 'ahmed'; new: boolean; added_at: string }
export interface QOption { label: string; description: string | null }
export interface Question {
  id: number; project: string; task_id: number | null; asked_by: string; body: string; context: string | null
  options: QOption[] | null; multi: boolean; blocking: boolean; status: 'open' | 'answered' | 'delivered' | 'withdrawn' | 'dormant' | 'sent_back'
  answer: string | null; answered_at: string | null; delivered_at: string | null; delivered_to: string | null
  // a delivered answer changed (#1346): the answers the session was told before, oldest first
  answer_history?: { answer: string; answered_by: string | null; delivered_to: string | null; changed_at: string }[] | null
  reply_to: { machine?: string; pane?: string } | null; created_at: string
  assigned_to: string | null; answered_by: string | null
  ruled_by: number | null // answered "Already ruled" with this memory entry (#553)
  // follow-ups (#472): a dormant question waits for parent_id's answer (if_answer: one label, null = any)
  parent_id: number | null; if_answer: string | null; parent_answer?: string | null
  branches?: { id: number; if_answer: string | null; body: string }[] | null // this question's dormant follow-ups
  images?: { id: number; caption: string | null }[] | null // pictures (cb ask --image), in order; bytes at /api/questions/:id/images/:image
  // send back (#616): while sent_back, why and by whom; versions: earlier texts, oldest first, with the send-back that asked for the rewrite
  sent_back: { reason: BackReason; note: string | null; by: string; at: string; delivered_at?: string } | null
  versions: { body: string; options: QOption[] | null; context: string | null; reason: BackReason | null; note: string | null; rewritten_at: string }[] | null
}
export type BackReason = 'details' | 'clarify' | 'simplify' | 'reask' | 'visual'
/** Why a question goes back to its asker: the picker's label, the quiet row's word, the rewritten card's word. */
export const BACK_REASONS: { key: BackReason; label: string; short: string; past: string }[] = [
  { key: 'details', label: 'More details', short: 'more details', past: 'more details' },
  { key: 'clarify', label: 'Ask a question', short: 'a question', past: 'clarified' },
  { key: 'simplify', label: 'Simplify', short: 'simplify', past: 'simplified' },
  { key: 'reask', label: 'Options are wrong', short: 'new options', past: 'new options' },
  { key: 'visual', label: 'Show me', short: 'show me', past: 'with pictures' },
]
export interface User { name: string; display: string; projects?: string[] } // projects: only from /api/users, not on a guest's whoami
/** People who can take work on a project (they're on it), plus whoever already holds the item. */
export const onProject = (users: User[], project: string, holder?: string | null) =>
  users.filter((u) => u.projects?.includes(project) || u.name === holder)
export interface CbEvent {
  id: number; at: string; actor: string; project: string | null; task_id: number | null; question_id: number | null
  kind: 'task_created' | 'moved' | 'updated' | 'done' | 'note' | 'asked' | 'answered' | 'delivered' | 'withdrawn' | 'broadcast' | 'message' | 'huddle' | 'user' | 'epic' | 'memory' | 'sent_back' | 'rewritten' | 'goal' | 'ask'
  summary: string; data: Record<string, any>
}
export const MEM_KINDS = ['rule', 'ruling', 'fact', 'gotcha', 'runbook'] as const
/** Shared memory (#167). authority 'ahmed' = he added or confirmed it; 'team' = a session's note. expired = past review_after. */
export interface Memory {
  id: number; project: string | null; machine: string | null; kind: (typeof MEM_KINDS)[number]; title: string; body: string
  status: 'proposed' | 'active' | 'superseded' | 'retired'; authority: 'ahmed' | 'team'
  source: { question_id?: number; task_id?: number; supersedes?: number; flagged?: boolean }
  links: Record<string, string>; tags: string[]; created_by: string; confirmed_by: string | null; confirmed_at: string | null
  review_after: string | null; superseded_by: number | null; created_at: string; updated_at: string; expired: boolean
}

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`${r.status} ${path}`)
  return r.json()
}

/** Functions without an actor argument: rpc() must not add one (Postgres then finds no function by that name and
 *  arguments). test/settings-web.test.ts checks the list against db/schema.sql. */
export const NO_ACTOR = new Set(['page_get', 'digest', 'seen', 'goal_opened', 'goal_preview', 'goal_propose',
  'squad_page', 'squad_options', 'role_text_page', 'github_watches', 'project_role_page', 'project_state_preview'])

/** Every write goes through the same cb.* SQL functions the agents use. The UI acts as "ahmed". */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(`/api/rpc/${fn}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(NO_ACTOR.has(fn) ? args : { actor: 'ahmed', ...args }),
  })
  const j = await r.json()
  if (!j.ok) throw new Error(j.error)
  return j.result
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => get<User[]>('/api/users') })
export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => get<Project[]>('/api/projects') })
/** The projects that get work (#4559): every "pick a project" list. Name, state and pipeline lookups use useProjects,
 *  which has every project, so a link to a disabled one still finds its name. */
export const useLiveProjects = () => liveOnly(useProjects().data ?? [])
export const liveOnly = <P extends Pick<Project, 'state'>>(ps: readonly P[]) => ps.filter((p) => p.state === 'enabled')
/** Is the squad pipeline on for this project? A card's stage chip and design page show only then (a switched-off project looks as before). */
export const usePipeline = (slug: string) => !!useProjects().data?.find((p) => p.slug === slug)?.pipeline
/** A card from the list: no description (the server leaves it off; useTask has it). */
export type ListTask = Omit<Task, 'body'>
/** live: leave out a disabled or archived project when none is chosen: only Backlog asks (#4559). The Board leaves them
 *  out in the browser, so that it shares card search's request (#4720). Card search and a seat's page read every card. */
export const useTasks = (project?: string, status?: Status, live?: boolean) =>
  useQuery({ queryKey: ['tasks', project, status, !!live], queryFn: () => get<ListTask[]>(`/api/tasks${qs({ project, status, live: live ? '1' : undefined })}`) })
export const useQuestions = (project?: string, status?: string) =>
  useQuery({ queryKey: ['questions', project, status], queryFn: () => get<Question[]>(`/api/questions${qs({ project, status })}`) })
export const useTask = (id: number | null) =>
  useQuery({
    queryKey: ['task', id], enabled: id != null,
    queryFn: () => get<{ task: Task; events: CbEvent[]; questions: Question[]; blockers: TaskRef[]; blocks: TaskRef[]; epic: { id: number; title: string } | null; ping: boolean }>(`/api/tasks/${id}`),
  })
export const useEpics = (project?: string) =>
  useQuery({ queryKey: ['epics', project], queryFn: () => get<Epic[]>(`/api/epics${qs({ project })}`) })
export const useEpic = (id: number) =>
  useQuery({ queryKey: ['epic', id], queryFn: () => get<{ epic: Epic; steps: Task[] }>(`/api/epics/${id}`) })
export const useGoals = (project?: string) =>
  useQuery({ queryKey: ['goals', project], queryFn: () => get<Goal[]>(`/api/goals${qs({ project })}`) })
export const useGoal = (id: number) =>
  useQuery({ queryKey: ['goal', id], queryFn: () => get<{ goal: Goal; cards: GoalCard[] }>(`/api/goals/${id}`) })
export const useMemories = (project?: string, all?: boolean) =>
  useQuery({ queryKey: ['memories', project, !!all], queryFn: () => get<Memory[]>(`/api/memories${qs({ project, all: all ? '1' : undefined })}`) })
/** The weekly memory metric (last 7 days) and the Today card's counts (#553). stale_pct: null when nothing is live. */
export interface MemStats { proposed: number; past_review: number; live_facts: number; stale_pct: number | null; already_ruled: number; corrections: number }
export const useMemStats = (project?: string) =>
  useQuery({ queryKey: ['memories', 'stats', project], queryFn: () => get<MemStats>(`/api/memory/stats${qs({ project })}`) })
/** Live entries not past review matching words (full text, best first), for the "Already ruled" picker. */
export const useMemFind = (term: string, project?: string) =>
  useQuery({ queryKey: ['memories', 'find', project, term], enabled: term.trim().length > 1,
    queryFn: () => get<Memory[]>(`/api/memories${qs({ project, q: term.trim(), live: '1' })}`) })
/** Ahmed's asks (#936): open threads and those closed in the last day. */
export const useAsks = (project?: string) =>
  useQuery({ queryKey: ['asks', project], queryFn: () => get<Ask[]>(`/api/asks${qs({ project })}`) })
export { qs }

/** A card's design page (cb.page_get): null until someone writes it. approved_* is what Ahmed approved. */
export interface DesignPage { version: number; body: string; updated_by: string; updated_at: string; approved_version: number | null; approved_body: string | null; approved_by: string | null; approved_at: string | null }
export const usePage = (task: number, on: boolean) =>
  useQuery({ queryKey: ['page', task], enabled: on, queryFn: () => rpc<DesignPage | null>('page_get', { task: String(task) }) })
export const useDigest = (project: string | undefined, on: boolean) =>
  useQuery({ queryKey: ['digest', project], enabled: on && !!project, refetchInterval: 60_000, queryFn: () => rpc<string[]>('digest', { project }) })
