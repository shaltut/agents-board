import { useState } from 'react'
import { Check, ChevronsUpDown, Layers, Settings } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { liveOnly, useProjects } from '@/lib/api'
import { go, href } from '@/lib/route'
import { ProjectDot } from './Chips'
import { StatePill } from './projects/ProjectsList'

/** settings: the viewer gets Project settings (the owner): a gear beside the switcher opens the shown project's
 *  settings, or the project chooser on All projects (#4332). Not on a phone: it would squeeze the project name, and the
 *  nav's Settings menu has the page there. */
export function ProjectSwitcher({ project, settings }: { project?: string; settings?: boolean }) {
  const [open, setOpen] = useState(false)
  const { data: all = [] } = useProjects()
  const current = all.find((p) => p.slug === project) // any state: a link to a disabled project still shows its name
  const projects = liveOnly(all) // the list: enabled projects only (#4559); the others are on the Projects page
  const pick = (slug?: string) => { go({ project: slug, task: undefined }); setOpen(false) }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="inline-flex h-8 max-w-56 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors hover:bg-raised aria-expanded:bg-raised sm:flex-none lg:min-w-40">
          {current ? <ProjectDot slug={current.slug} /> : <Layers className="size-3.5 text-muted-foreground" />}
          <span className="truncate">{current?.name ?? 'All projects'}</span>
          {current && current.state !== 'enabled' && <StatePill state={current.state} />}
          <ChevronsUpDown className="ml-auto size-3.5 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder="Find a project" />
            <CommandList>
              <CommandEmpty>No project with that name.</CommandEmpty>
              <CommandGroup>
                <CommandItem value="__all" onSelect={() => pick(undefined)}>
                  <Layers className="size-3.5" /> All projects
                  {!project && <Check className="ml-auto size-3.5" />}
                </CommandItem>
                {projects.map((p) => (
                  <CommandItem key={p.slug} value={`${p.slug} ${p.name}`} onSelect={() => pick(p.slug)}>
                    <ProjectDot slug={p.slug} />
                    <span className="truncate">{p.name}</span>
                    <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                      {p.question_count > 0 && <span className="flex items-center gap-1 font-semibold text-lamp tabular-nums" title={`${p.question_count} waiting on you`}><span className="lamp size-1.5" />{p.question_count}</span>}
                      <span className="tabular-nums" title={`${p.open_count} open tasks`}>
                      {p.open_count}</span>
                      {project === p.slug && <Check className="size-3.5 text-foreground" />}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              {settings && all.length > projects.length && ( /* the owner's page: another admin does not get it */
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">Disabled and archived projects: on the Projects page.</p>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {settings && (
        <a href={settingsHref(current?.slug)} aria-label={current ? `Settings of ${current.name}` : 'Projects'} title={current ? `Settings of ${current.name}` : 'Projects'}
          className="-ml-2 hidden size-8 shrink-0 sm:grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-raised hover:text-foreground">
          <Settings className="size-3.5" />
        </a>
      )}
    </>
  )
}

/** The settings page of a project, or the chooser; no task, session, huddle, epic or goal carried over. */
const settingsHref = (project?: string) => href({ view: 'settings', project })
