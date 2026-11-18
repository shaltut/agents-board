import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { keysFor } from './invalidate'

/** One SSE stream; a DB change re-fetches the visible queries it affects. The DB stays the only source of truth. */
export function useLive(): 'live' | 'reconnecting' {
  const qc = useQueryClient()
  const [state, setState] = useState<'live' | 'reconnecting'>('reconnecting')
  useEffect(() => {
    const es = new EventSource('/api/stream')
    let timer: ReturnType<typeof setTimeout> | undefined
    let changed = new Set<string>()
    es.addEventListener('hello', () => setState('live'))
    es.addEventListener('change', (e) => {
      changed.add((e as MessageEvent).data) // the table that changed
      clearTimeout(timer) // one write fires several notifications; refetch once, for all of them
      timer = setTimeout(() => {
        const keys = keysFor(changed)
        changed = new Set()
        if (keys === 'all') qc.invalidateQueries()
        else qc.invalidateQueries({ predicate: (q) => keys.includes(String(q.queryKey[0])) })
      }, 120)
    })
    es.onerror = () => setState('reconnecting')
    es.onopen = () => { setState('live'); qc.invalidateQueries() }
    return () => { clearTimeout(timer); es.close() }
  }, [qc])
  return state
}
