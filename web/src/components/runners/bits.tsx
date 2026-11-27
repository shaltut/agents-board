import { useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy } from 'lucide-react'
import { rpc } from '@/lib/api'
import { actionError, recipeLabel, type Job } from '@/lib/runners'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** The clock the page's timers read: one tick a second, so elapsed and waiting times move without a re-fetch. */
export function useNow(every = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t) }, [every])
  return now
}

/** A queue action: the cb.* function, then the page re-reads the queue. A refusal shows in words, never raw. */
export function useAct() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const act = async (fn: string, args: Record<string, unknown>, done?: string) => {
    setBusy(true)
    try {
      await rpc(fn, args)
      if (done) toast.success(done)
    } catch (e) {
      toast.error(actionError(e))
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: ['runners'] })
    }
  }
  return { act, busy }
}

/** A button that asks once more before it does something that cannot be undone from here (stop, pause, drain). */
export function ConfirmButton({ label, ask, yes, onYes, disabled, variant = 'outline' }: {
  label: ReactNode; ask: string; yes: string; onYes: () => void; disabled?: boolean; variant?: 'outline' | 'destructive' | 'ghost'
}) {
  const [asking, setAsking] = useState(false)
  if (!asking) return <Button size="xs" variant={variant} disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label={ask}>
      <span className="text-muted-foreground">{ask}</span>
      <Button size="xs" variant="destructive" disabled={disabled} onClick={() => { setAsking(false); onYes() }}>{yes}</Button>
      <Button size="xs" variant="ghost" onClick={() => setAsking(false)}>Keep</Button>
    </span>
  )
}

/** A command to run on the PC, with a copy button (logs stay there, Q2981). */
export function CopyCommand({ text }: { text: string }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast.success('Copied') } catch { toast.error('Copy did not work here: select the text instead.') }
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <code className="min-w-0 truncate rounded bg-raised px-1.5 py-0.5 font-mono text-xs" translate="no">{text}</code>
      <Button size="icon-xs" variant="ghost" onClick={copy} aria-label={`Copy ${text}`}><Copy /></Button>
    </span>
  )
}

/** What a job runs: the recipe's plain label (an unknown one in command style), its repo when not the only one. */
export function What({ j, className }: { j: Pick<Job, 'recipe' | 'repo' | 'db'>; className?: string }) {
  const r = recipeLabel(j.recipe)
  return (
    <span className={cn('min-w-0 truncate font-medium', className)}>
      {r.command ? <code className="font-mono text-[13px]" translate="no">{r.text}</code> : r.text}
      {j.repo && j.repo !== 'main' && <span className="font-normal text-muted-foreground"> · {j.repo}</span>}
    </span>
  )
}

/** "7 of 10 in use" as a row of cells: filled = in use. Past 16 it is a bar. */
export function Meter({ used, of, label }: { used: number; of: number | null; label: string }) {
  if (of == null || of <= 0) return null
  const cells = Math.min(of, 16)
  const filled = of > 16 ? Math.round((Math.min(used, of) / of) * cells) : Math.min(used, of)
  return (
    <span role="img" aria-label={label} className="inline-flex gap-0.5 align-middle">
      {Array.from({ length: cells }, (_, i) => (
        <span key={i} className={cn('h-3 w-2.5 rounded-[2px] border', i < filled ? 'border-foreground/60 bg-foreground/70' : 'border-input bg-card')} />
      ))}
    </span>
  )
}

export const sha7 = (sha: string) => sha.slice(0, 7)
