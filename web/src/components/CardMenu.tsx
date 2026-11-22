import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ContextMenu as Menu } from 'radix-ui'
import { BellRing, Check, ChevronRight, Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { onProject, rpc, useUsers, type ListTask, type Status } from '@/lib/api'
import { STATUS } from '@/lib/format'
import { go } from '@/lib/route'
import { cn } from '@/lib/utils'
import { PRIORITIES, setPriority, StatusDot } from './Chips'

const PANEL = 'z-50 min-w-44 overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95'
const ITEM = 'relative flex cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0'
const STATUSES = Object.keys(STATUS) as Status[]
// the menu's portal bubbles through React to the card: its clicks and keys must not open the panel or pick the card up
const quiet = { onClick: (e: React.SyntheticEvent) => e.stopPropagation(), onPointerDown: (e: React.SyntheticEvent) => e.stopPropagation(), onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation() }

/** Right-click (or long-press) a card: move it, change priority or assignee, open it, ask why it is not moving. Every
 *  action is an rpc the card panel already uses, so the rules stay in SQL. */
export function CardMenu({ t, children }: { t: Pick<ListTask, 'id' | 'status' | 'priority' | 'assignee' | 'project' | 'ping'>; children: ReactElement }) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{children}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className={PANEL} {...quiet} collisionPadding={8}>
          <Body t={t} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}

function Sub({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Menu.Sub>
      <Menu.SubTrigger className={cn(ITEM, 'data-[state=open]:bg-accent')}>{label}<ChevronRight className="ml-auto" /></Menu.SubTrigger>
      <Menu.Portal><Menu.SubContent className={PANEL} {...quiet} sideOffset={4} collisionPadding={8}>{children}</Menu.SubContent></Menu.Portal>
    </Menu.Sub>
  )
}

// mounted only while the menu is open: a board of hundreds of cards must not each subscribe to the users list
function Body({ t }: { t: Pick<ListTask, 'id' | 'status' | 'priority' | 'assignee' | 'project' | 'ping'> }) {
  const qc = useQueryClient()
  const { data: users = [] } = useUsers()
  const closed = t.status === 'done' || t.status === 'cancelled'
  async function run(act: () => Promise<unknown>, ok: string) {
    try { await act(); toast(ok) } catch (e: any) { toast.error(`Could not change #${t.id}`, { description: e.message }) }
    await qc.invalidateQueries()
  }
  return (
    <>
      <Menu.Item className={ITEM} onSelect={() => go({ task: t.id })}><ExternalLink />Open #{t.id}</Menu.Item>
      <Menu.Separator className="-mx-1 my-1 h-px bg-border" />
      <Sub label="Move to">
        {STATUSES.map((s) => (
          <Menu.Item key={s} className={ITEM} disabled={s === t.status}
            onSelect={() => run(() => rpc('task_move', { id: t.id, status: s }), `#${t.id} moved to ${STATUS[s].label}`)}>
            <StatusDot status={s} />{STATUS[s].label}{s === t.status && <Check className="ml-auto" />}
          </Menu.Item>
        ))}
      </Sub>
      <Sub label="Priority">
        {PRIORITIES.map(({ p, label }) => (
          <Menu.Item key={p} className={ITEM} disabled={p === t.priority}
            onSelect={() => run(() => setPriority(t.id, p), `#${t.id} is now ${p}: ${label.toLowerCase()}`)}>
            <span className="callsign w-7 text-[12px]">{p}</span>{label}{p === t.priority && <Check className="ml-auto" />}
          </Menu.Item>
        ))}
      </Sub>
      <Sub label="Assign to">
        {onProject(users, t.project, t.assignee).map((u) => (
          <Menu.Item key={u.name} className={ITEM} disabled={u.name === t.assignee}
            onSelect={() => run(() => rpc('task_update', { id: t.id, fields: { assignee: u.name } }), `#${t.id} assigned to ${u.display || u.name}`)}>
            {u.display || u.name}{u.name === t.assignee && <Check className="ml-auto" />}
          </Menu.Item>
        ))}
        {t.assignee && (
          <Menu.Item className={ITEM} onSelect={() => run(() => rpc('task_update', { id: t.id, fields: { assignee: null } }), `#${t.id} is unassigned`)}>Nobody</Menu.Item>
        )}
      </Sub>
      {!closed && (
        <Menu.CheckboxItem className={ITEM} checked={!!t.ping}
          onSelect={() => run(() => rpc('task_ping_set', { id: t.id, enabled: !t.ping }), t.ping ? `#${t.id}: no more asks` : `#${t.id}: the board will ask why it is not moving`)}>
          <BellRing />Ask why it is not moving{t.ping && <Check className="ml-auto" />}
        </Menu.CheckboxItem>
      )}
      <Menu.Item className={ITEM} onSelect={() => { void navigator.clipboard?.writeText(`#${t.id}`); toast(`Copied #${t.id}`) }}><Copy />Copy #{t.id}</Menu.Item>
      {t.status !== 'cancelled' && (
        <>
          <Menu.Separator className="-mx-1 my-1 h-px bg-border" />
          <Menu.Item className={cn(ITEM, 'text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive')}
            onSelect={() => run(() => rpc('task_move', { id: t.id, status: 'cancelled' }), `#${t.id} cancelled`)}>Cancel card</Menu.Item>
        </>
      )}
    </>
  )
}
