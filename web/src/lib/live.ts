import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { refresher } from './invalidate'

/** One SSE stream; a DB change re-fetches the visible queries it affects (invalidate.ts: which, and how often).
 *  The DB stays the only source of truth. */
export function useLive(): 'live' | 'reconnecting' {
  const qc = useQueryClient()
  const [state, setState] = useState<'live' | 'reconnecting'>('reconnecting')
  useEffect(() => {
    const es = new EventSource('/api/stream')
    const r = refresher({
      hidden: () => document.hidden,
      invalidate: (keys) => keys === 'all'
        ? qc.invalidateQueries()
        : qc.invalidateQueries({ predicate: (q) => keys.includes(String(q.queryKey[0])) }),
    })
    const onVisible = () => { if (!document.hidden) r.visible() }
    document.addEventListener('visibilitychange', onVisible)
    es.addEventListener('hello', () => setState('live'))
    es.addEventListener('change', (e) => r.change((e as MessageEvent).data)) // data: the table that changed
    es.onerror = () => setState('reconnecting')
    es.onopen = () => { setState('live'); r.change('listen') } // what changed while disconnected: everything
    return () => { r.stop(); document.removeEventListener('visibilitychange', onVisible); es.close() }
  }, [qc])
  return state
}
