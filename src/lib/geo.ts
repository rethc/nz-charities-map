import type { LngLatBounds } from 'maplibre-gl'

export type LonLat = [lon: number, lat: number]

/** Spec default: Wellington-centred view of the whole country. */
export const DEFAULT_VIEW = { center: [174.76, -41.28] as LonLat, zoom: 6 }
/** Narrow screens can't fit NZ at zoom 6 (~4° of longitude on a phone), so pull back. */
export const MOBILE_ZOOM = 4.6

/**
 * Everything the public map shows. 165°E → 175°W crosses the antimeridian so the
 * Chatham Islands (≈176.5°W) are included; the RPC splits it into two boxes.
 */
export const NZ_EXTENT = { min_lon: 165, min_lat: -53, max_lon: -175, max_lat: -28 } as const

export function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

/** MapLibre bounds can run past ±180 when the map is panned across the date line. */
export function boundsToRpcArgs(bounds: LngLatBounds) {
  const west = bounds.getWest()
  const east = bounds.getEast()
  const wholeWorld = east - west >= 360
  return {
    min_lon: wholeWorld ? -180 : normalizeLon(west),
    max_lon: wholeWorld ? 180 : normalizeLon(east),
    min_lat: Math.max(-90, bounds.getSouth()),
    max_lat: Math.min(90, bounds.getNorth()),
  }
}

/** Mirrors verify_charity_location(): NZ incl. Chathams and the subantarctic islands. */
export function inNz([lon, lat]: LonLat): boolean {
  return lat >= -53 && lat <= -28 && ((lon >= 160 && lon <= 180) || (lon >= -180 && lon <= -170))
}

/** Shift Chatham Islands longitudes east of 180° so NZ bounds are contiguous. */
export function unwrapNz([lon, lat]: LonLat): LonLat {
  return [lon < 0 ? lon + 360 : lon, lat]
}

export function boundsOf(points: LonLat[]): [LonLat, LonLat] | null {
  if (!points.length) return null
  let [minX, minY] = unwrapNz(points[0]!)
  let [maxX, maxY] = [minX, minY]
  for (const p of points) {
    const [x, y] = unwrapNz(p)
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  return [[minX, minY], [maxX, maxY]]
}

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
