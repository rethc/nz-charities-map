import { useCallback, useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}

/*
 * Layout breakpoints. The first matches the `card:` variant in index.css.
 */
/** The header floats as a card at the top left, leaving map beside it. */
export const CARD_QUERY = '(min-width: 768px), (min-width: 600px) and (orientation: landscape)'
/** Wide enough for the details to open as a popup beside the pin, between the header card and the map controls. */
export const POPUP_QUERY = '(min-width: 1024px) and (min-height: 501px)'
/** Too short for a sheet under the header (a phone on its side): the details take the left edge. */
export const SHORT_QUERY = '(max-height: 500px)'
export const PORTRAIT_QUERY = '(orientation: portrait)'
