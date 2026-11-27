import { Plus, Layers, Milestone } from 'lucide-react'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { liveOnly, useEpics, useProjects, useTasks } from '@/lib/api'
import { STATE_LABEL } from '@/lib/projects'
import { go, GROUPS, openPage, type Page } from '@/lib/route'
import { ProjectDot, StatusDot, TaskId } from './Chips'
import { PageKeys } from './NavMenus'

export function CommandMenu({ open, onOpenChange, onNewTask, pages }: { open: boolean; onOpenChange: (o: boolean) => void; onNewTask: () => void; pages: readonly Page[] }) {
  const { data: all = [] } = useProjects()
  const projects = liveOnly(all) // the project list: enabled ones only (#4559)
  // card search finds every card, a disabled or archived project's too, and says so in words (#4559)
  const off = new Map(all.filter((p) => p.state !== 'enabled').map((p) => [p.slug, STATE_LABEL[p.state]]))
  const { data: tasks = [] } = useTasks()
  const { data: epics = [] } = useEpics()
  const run = (fn: () => void) => { onOpenChange(false); fn() }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Jump to" description="Find a task, project or view" className="sm:max-w-xl">
      <Command>
        <CommandInput placeholder="Task title or #id, project, view…" />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>Nothing matches. Try a task number like #12.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => run(onNewTask)}><Plus /> New task<CommandShortcut>C</CommandShortcut></CommandItem>
          </CommandGroup>
          <CommandGroup heading="Tasks">
            {tasks.map((t) => (
              <CommandItem key={t.id} value={`#${t.id} ${t.title} ${t.project}`} onSelect={() => run(() => go({ task: t.id }))}>
                <StatusDot status={t.status} />
                <TaskId id={t.id} className="w-9 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{t.project}{off.has(t.project) && ` · ${off.get(t.project)}`}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          {epics.length > 0 && (
            <CommandGroup heading="Epics">
              {epics.map((e) => (
                <CommandItem key={e.id} value={`epic E${e.id} ${e.title} ${e.project}`} onSelect={() => run(() => go({ view: 'epics', epic: e.id, task: undefined }))}>
                  <Milestone />
                  <span className="callsign w-9 shrink-0 text-[13px] text-muted-foreground">E{e.id}</span>
                  <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">{e.finished} of {e.total}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Projects">
            <CommandItem value="all projects" onSelect={() => run(() => go({ project: undefined }))}><Layers /> All projects</CommandItem>
            {projects.map((p) => (
              <CommandItem key={p.slug} value={`project ${p.slug} ${p.name}`} onSelect={() => run(() => go({ project: p.slug }))}>
                <ProjectDot slug={p.slug} /> {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Go to">
            {/* the header's order: Today, Board, then each group's pages (only the ones this viewer gets) */}
            {pages.filter((p) => !p.group).concat(GROUPS.flatMap((g) => pages.filter((p) => p.group === g.id))).map((p) => {
              const group = GROUPS.find((g) => g.id === p.group)
              return (
                <CommandItem key={p.view} value={`go ${p.label} ${group?.label ?? ''}`} onSelect={() => run(() => openPage(p.view))}>
                  <p.icon /> {p.label}
                  {group && <span className="text-xs text-muted-foreground">{group.label}</span>}
                  <CommandShortcut className="tracking-normal"><PageKeys page={p} className="ml-0 pl-0" /></CommandShortcut>
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
