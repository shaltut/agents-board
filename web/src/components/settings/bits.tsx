import type { ReactNode } from 'react'
import { Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

/** One section of the settings page, with who may change what is in it (the server's OWNER_ONLY list, #4332). */
export function Section({ id, title, who, intro, children, aside }: {
  id: string; title: string; who: 'owner' | 'any'; intro?: ReactNode; children: ReactNode; aside?: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-28 border-t pt-6">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${id}-h`} className="text-lg font-semibold tracking-[-0.01em]">{title}</h2>
        <span className={cn('rounded-full px-2 py-0.5 text-xs', who === 'owner' ? 'bg-lamp-soft text-lamp-ink' : 'bg-raised text-muted-foreground')}>
          {who === 'owner' ? 'Only Ahmed changes this' : 'Any admin can change this'}
        </span>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {intro && <p className="mb-4 max-w-[80ch] text-sm text-muted-foreground text-pretty">{intro}</p>}
      {children}
    </section>
  )
}

export const fieldClass = 'h-8 min-w-0 rounded-md border border-input bg-card px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'

export function NativeSelect({ label, value, onChange, children, className, disabled }: {
  label: string; value: string; onChange: (v: string) => void; children: ReactNode; className?: string; disabled?: boolean
}) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cn(fieldClass, className)}>
      {children}
    </select>
  )
}

/** A count from min to max with − and + buttons (the number is also typed). */
export function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const set = (n: number) => onChange(Math.max(min, Math.min(max, n)))
  return (
    <span className="inline-flex items-center rounded-md border border-input bg-card" role="group" aria-label={label}>
      <button type="button" className="grid size-8 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40"
        aria-label={`One fewer: ${label}`} disabled={value <= min} onClick={() => set(value - 1)}><Minus className="size-3.5" /></button>
      <span className="w-6 text-center text-sm tabular-nums" aria-live="polite">{value}</span>
      <button type="button" className="grid size-8 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40"
        aria-label={`One more: ${label}`} disabled={value >= max} onClick={() => set(value + 1)}><Plus className="size-3.5" /></button>
    </span>
  )
}

/** Problems the form found, in plain words, under the part they are about. */
export function Problems({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <ul className="mt-2 space-y-1 text-[13px] text-destructive" role="alert">
      {items.map((t, i) => <li key={i}>{t}</li>)}
    </ul>
  )
}

/** A plain sentence after a failed save or load; the details went to the console. */
export function Notice({ tone = 'warn', children, action }: { tone?: 'warn' | 'error'; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className={cn('mb-4 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm',
      tone === 'warn' ? 'border-lamp/40 bg-lamp-soft text-lamp-ink' : 'border-destructive/40 bg-destructive/10 text-destructive')}>
      <span className="min-w-0 flex-1 text-pretty">{children}</span>
      {action}
    </div>
  )
}
