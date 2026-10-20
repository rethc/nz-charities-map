import { useCallback, useEffect, useState } from 'react'
import { loadCharities, type CharityDataset } from '../lib/charities'
import { whenFirstPainted } from '../lib/dom'

export type CharitiesState =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: CharityDataset; error: null }
  | { status: 'error'; data: null; error: string }

const LOADING: CharitiesState = { status: 'loading', data: null, error: null }

/** Loads the national dataset once; `retry()` fetches again after a failure. */
export function useCharities() {
  const [state, setState] = useState<CharitiesState>(LOADING)
  const loading = state.status === 'loading'

  useEffect(() => {
    if (!loading) return
    const controller = new AbortController()
    // The large download starts once the header and map are on screen.
    whenFirstPainted()
      .then(() => loadCharities(controller.signal))
      .then(
        (data) => setState({ status: 'ready', data, error: null }),
        (err: unknown) => {
          if (controller.signal.aborted) return
          setState({ status: 'error', data: null, error: err instanceof Error ? err.message : String(err) })
        },
      )
    return () => controller.abort()
  }, [loading])

  const retry = useCallback(() => setState(LOADING), [])
  return { ...state, retry }
}
