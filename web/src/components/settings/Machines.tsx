import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RX, ROLES, areaName, homeRepo, isMulti, machineLabel, pruneSeats, setAreas, type Area, type Squad, type SquadOptions } from '@/lib/squad'
import { NativeSelect, Problems } from './bits'

const copy = (s: Squad): Squad => JSON.parse(JSON.stringify(s)) as Squad

/** The machines seats start on, and (Q2971) their folders: board, repo (one-repo squads) and herdr workspace. */
export function Machines({ squad, options, problems, edit }: {
  squad: Squad; options: SquadOptions; problems: string[]; edit: (f: (s: Squad) => Squad) => void
}) {
  const [key, setKey] = useState('')
  const multi = isMulti(squad)
  const used = (k: string) => ROLES.some((r) => squad.roles[r]?.machine === k) || Object.values(squad.repos ?? {}).some((r) => k in r.paths)
  const others = options.machines_used.filter((m) => !squad.machines[m.key])
  const field = (k: string, f: 'board' | 'repo' | 'workspace', v: string) => edit((s) => {
    const n = copy(s), m = n.machines[k]!
    if (f === 'workspace' && v === '') delete m.workspace; else m[f] = v
    return n
  })
  const addMachine = (k: string, from?: (typeof others)[number]) => edit((s) => {
    const n = copy(s)
    n.machines[k] = {
      herdr: from ? from.herdr : 'macbook', board: from?.board ?? '',
      ...(multi ? {} : { repo: from?.repo ?? '' }), ...(from?.workspace ? { workspace: from.workspace } : {}),
    }
    return n
  })
  const keyOk = RX.slug.test(key) && !squad.machines[key]

  return (
    <div className="space-y-3">
      <ul className="grid gap-3 lg:grid-cols-2">
        {Object.entries(squad.machines).map(([k, m]) => (
          <li key={k} className="space-y-2 rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{machineLabel(m, k)}</span>
              <span className="text-xs text-muted-foreground">({k})</span>
              <Button variant="ghost" size="icon-xs" className="ml-auto" disabled={used(k)} aria-label={`Remove machine ${k}`}
                title={used(k) ? 'A role or a repo still uses it' : undefined}
                onClick={() => edit((s) => { const n = copy(s); delete n.machines[k]; return n })}><X /></Button>
            </div>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-24 text-xs text-muted-foreground">Where</span>
              <NativeSelect label={`Where machine ${k} is`} value={m.herdr === null ? 'pc' : 'other'}
                onChange={(v) => edit((s) => { const n = copy(s); n.machines[k]!.herdr = v === 'pc' ? null : 'macbook'; return n })}>
                <option value="pc">This PC</option>
                <option value="other">Another machine</option>
              </NativeSelect>
              {m.herdr !== null && (
                <Input aria-label={`herdr name of machine ${k}`} value={m.herdr} spellCheck={false} className="h-8 w-32 font-mono text-xs"
                  onChange={(e) => edit((s) => { const n = copy(s); n.machines[k]!.herdr = e.target.value.trim(); return n })} />
              )}
            </label>
            <PathRow label="Board folder" value={m.board} onChange={(v) => field(k, 'board', v)} name={`board folder on ${k}`} />
            {!multi && <PathRow label="Repo folder" value={m.repo ?? ''} onChange={(v) => field(k, 'repo', v)} name={`repo folder on ${k}`} />}
            <PathRow label="Workspace" value={m.workspace ?? ''} onChange={(v) => field(k, 'workspace', v)} name={`herdr workspace on ${k}`} placeholder="optional" />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Input aria-label="New machine's short name" placeholder="short name, like mac" value={key} spellCheck={false}
          onChange={(e) => setKey(e.target.value.trim().toLowerCase())} className="h-8 w-48 font-mono text-xs" />
        <Button variant="outline" size="sm" disabled={!keyOk} onClick={() => { addMachine(key); setKey('') }}><Plus /> Add a machine</Button>
        {others.length > 0 && (
          <NativeSelect label="Add a machine another project uses" value="" onChange={(v) => { const m = others.find((o) => o.key === v); if (m) addMachine(m.key, m) }}>
            <option value="">Or one another project uses…</option>
            {others.map((m) => <option key={m.key} value={m.key}>{machineLabel(m, m.key)} ({m.key})</option>)}
          </NativeSelect>
        )}
      </div>
      <Problems items={problems} />
    </div>
  )
}

function PathRow({ label, value, onChange, name, placeholder }: { label: string; value: string; onChange: (v: string) => void; name: string; placeholder?: string }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-24 text-xs text-muted-foreground">{label}</span>
      <Input aria-label={name} value={value} placeholder={placeholder ?? 'full path'} spellCheck={false} onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-0 flex-1 basis-48 font-mono text-xs" />
    </label>
  )
}

/** A project of several repos (Q2971): each repo's folder per machine, and which one is home. */
export function Repos({ squad, problems, edit }: { squad: Squad; problems: string[]; edit: (f: (s: Squad) => Squad) => void }) {
  const [name, setName] = useState('')
  if (!isMulti(squad)) {
    return <p className="text-sm text-muted-foreground">One repo: its folder is set on each machine above.</p>
  }
  const home = homeRepo(squad)
  const machines = Object.entries(squad.machines)
  const remove = (r: string) => edit((s) => {
    const n = copy(s)
    delete n.repos![r]
    for (const role of ['builder', 'reviewer'] as const) {
      const c = n.roles[role]?.count
      if (c && typeof c === 'object') delete c[r]
    }
    n.areas = (n.areas ?? []).filter((a) => typeof a === 'string' || a.repo !== r)
    if (n.areas.length === 0) delete n.roles.owner
    pruneSeats(n)
    return n
  })
  return (
    <div className="space-y-3">
      <ul className="grid gap-3 lg:grid-cols-2">
        {Object.entries(squad.repos!).map(([r, spec]) => (
          <li key={r} className="space-y-2 rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{r}</span>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="radio" name="home-repo" className="size-4" checked={home === r}
                  onChange={() => edit((s) => { const n = copy(s); for (const [k, v] of Object.entries(n.repos!)) v.home = k === r; return n })} />
                Home
              </label>
              <Button variant="ghost" size="icon-xs" className="ml-auto" disabled={home === r} aria-label={`Remove repo ${r}`}
                title={home === r ? 'Make another repo home first' : undefined} onClick={() => remove(r)}><X /></Button>
            </div>
            {machines.map(([k, m]) => (
              <PathRow key={k} label={machineLabel(m, k)} name={`folder of ${r} on ${k}`} value={spec.paths[k] ?? ''} placeholder="not on this machine"
                onChange={(v) => edit((s) => { const n = copy(s), p = n.repos![r]!.paths; if (v === '') delete p[k]; else p[k] = v; return n })} />
            ))}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="New repo's short name" placeholder="short name, like web" value={name} spellCheck={false}
          onChange={(e) => setName(e.target.value.trim().toLowerCase())} className="h-8 w-48 font-mono text-xs" />
        <Button variant="outline" size="sm" disabled={!RX.slug.test(name) || !!squad.repos![name]}
          onClick={() => { edit((s) => { const n = copy(s); n.repos![name] = { home: false, paths: {} }; return n }); setName('') }}><Plus /> Add a repo</Button>
      </div>
      <Problems items={problems} />
    </div>
  )
}

/** The areas area owners hold, one owner each (with several repos an area names its repo). */
export function Areas({ squad, ownerModel, problems, edit }: {
  squad: Squad; ownerModel: string; problems: string[]; edit: (f: (s: Squad) => Squad) => void
}) {
  const [name, setName] = useState('')
  const multi = isMulti(squad)
  const [repo, setRepo] = useState(homeRepo(squad) ?? '')
  const areas = squad.areas ?? []
  const ok = RX.area.test(name) && !areas.some((a) => areaName(a) === name) && (!multi || !!squad.repos?.[repo])
  const add = () => {
    const a: Area = multi ? { name, repo } : name
    edit((s) => {
      const n = setAreas(s, [...(s.areas ?? []), a])
      if (!n.roles.owner) n.roles.owner = { model: ownerModel, machine: Object.keys(n.machines)[0] ?? '' }
      return n
    })
    setName('')
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {areas.length === 0 && <span className="text-sm text-muted-foreground">No areas. Adding one turns area owners on.</span>}
        {areas.map((a) => (
          <span key={areaName(a)} className="inline-flex items-center gap-1 rounded-md border bg-card py-0.5 pr-0.5 pl-2 text-sm">
            {areaName(a)}{typeof a !== 'string' && <span className="text-muted-foreground"> · {a.repo}</span>}
            <Button variant="ghost" size="icon-xs" aria-label={`Remove area ${areaName(a)}`}
              onClick={() => edit((s) => setAreas(s, (s.areas ?? []).filter((x) => areaName(x) !== areaName(a))))}><X /></Button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="New area" placeholder="area, like payments" value={name} spellCheck={false}
          onChange={(e) => setName(e.target.value.trim().toLowerCase())} className="h-8 w-48 font-mono text-xs" />
        {multi && (
          <NativeSelect label="Repo of the new area" value={repo} onChange={setRepo}>
            {Object.keys(squad.repos ?? {}).map((r) => <option key={r} value={r}>{r}</option>)}
          </NativeSelect>
        )}
        <Button variant="outline" size="sm" disabled={!ok} onClick={add}><Plus /> Add an area</Button>
      </div>
      <Problems items={problems} />
    </div>
  )
}
