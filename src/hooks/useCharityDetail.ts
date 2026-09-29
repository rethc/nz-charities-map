import { useEffect, useState } from 'react'
import { fetchCharityDetail } from '../lib/charities'
import type { CharityDetail } from '../lib/database.types'

export type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; detail: CharityDetail | null }
  | { status: 'error'; message: string }

// Details rarely change within a visit, so keep what we've fetched.
const cache = new Map<string, CharityDetail | null>()

export function useCharityDetail(cc: string): DetailState {
  const [result, setResult] = useState<{ cc: string; state: DetailState } | null>(null)

  useEffect(() => {
    if (cache.has(cc)) return
    const controller = new AbortController()
    fetchCharityDetail(cc, controller.signal).then(
      (detail) => {
        cache.set(cc, detail)
        setResult({ cc, state: { status: 'ready', detail } })
      },
      (err: unknown) => {
        if (controller.signal.aborted) return
        setResult({ cc, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } })
      },
    )
    return () => controller.abort()
  }, [cc])

  if (cache.has(cc)) return { status: 'ready', detail: cache.get(cc) ?? null }
  if (result?.cc === cc) return result.state
  return { status: 'loading' }
}
