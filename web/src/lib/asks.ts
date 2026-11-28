// Ahmed's asks (#936): the shape /api/asks returns (cb.asks_list) and the two choices the Today box makes.

export interface AskLine { id: number; at: string; actor: string; action: 'open' | 'say' | 'reply' | 'close' | 'reroute'; text: string; done: boolean }
export interface Ask {
  id: number; project: string | null; task_id: number | null; to_actor: string; body: string; status: 'open' | 'done'; from_terminal?: boolean
  created_at: string; delivered_at: string | null; closed_at: string | null
  state: 'sent' | 'seen' | 'replied' | 'done'; awaiting: boolean; late: boolean; live: boolean; lines: AskLine[]
}
type Session = { actor: string; project: string | null; live: boolean; lead?: boolean }

/** Who an ask goes to by default, and who a new huddle starts with: the project's lead, a live one first. The lead is
 *  the board's (sessions_overview's lead: by role, #3746), whatever its name (#3771: QO@ leads QHS, not orch@). No
 *  project picked, or no lead on it: nobody, so Ahmed picks rather than ask the wrong session. */
export function defaultRecipient(sessions: Session[], project?: string): string {
  if (!project) return ''
  const leads = sessions.filter((s) => s.lead && s.project === project)
  return (leads.find((s) => s.live) ?? leads[0])?.actor ?? ''
}

/** The sessions' replies (not Ahmed's lines): one joining the set rings (lib/ring.ts). */
export const replyIds = (asks: Ask[]) =>
  asks.flatMap((a) => a.lines.filter((l) => l.action === 'reply' && l.actor !== 'ahmed').map((l) => l.id))
