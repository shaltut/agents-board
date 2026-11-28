import { useProjects } from '@/lib/api'
import { href } from '@/lib/route'
import { bannerText } from '@/lib/projects'

/** On a chosen project's Board, Backlog and Sessions while it gets no work (#4559): what that means, and for the owner
 *  where to change it. Nothing while it is enabled or no project is chosen. */
export function StateBanner({ project, owner }: { project?: string; owner: boolean }) {
  const p = useProjects().data?.find((x) => x.slug === project)
  const text = p && bannerText(p)
  if (!p || !text) return null
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-lamp/40 bg-lamp-soft px-3 py-2 text-sm text-lamp-ink">
      <span className="min-w-0 flex-1 text-pretty">{text}</span>
      {owner && (
        <a href={href({ view: 'settings' })} className="font-medium underline underline-offset-4">
          {p.state === 'archived' ? 'Unarchive it on Projects' : 'Enable it on Projects'}
        </a>
      )}
    </div>
  )
}
