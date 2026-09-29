import type { CharityPoint } from './charities'

/** Lower-case and strip macrons/diacritics so "Ōtautahi" matches "otautahi". */
export function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

export interface SearchResult {
  /** Indexes of every matching point (drives the map filter). */
  matches: Set<number>
  /** Best few matches for the dropdown. */
  top: CharityPoint[]
}

export function searchCharities(points: CharityPoint[], query: string, limit = 8): SearchResult | null {
  const q = fold(query).trim().replace(/\s+/g, ' ')
  if (q.length < 2) return null

  const tokens = q.split(' ')
  const ccQuery = /^cc\s?\d+$/.test(q) ? q.replace(/\s/g, '') : null
  const matches = new Set<number>()
  const ranked: Array<[rank: number, point: CharityPoint]> = []

  for (const point of points) {
    if (ccQuery) {
      if (!point.ccKey.startsWith(ccQuery)) continue
    } else if (!tokens.every((t) => point.searchKey.includes(t))) {
      continue
    }
    matches.add(point.index)
    const rank =
      point.ccKey === ccQuery ? 0
      : point.nameKey.startsWith(q) ? 1
      : point.nameKey.split(' ').some((w) => w.startsWith(tokens[0]!)) ? 2
      : 3
    ranked.push([rank, point])
  }

  ranked.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length || a[1].name.localeCompare(b[1].name))
  return { matches, top: ranked.slice(0, limit).map(([, p]) => p) }
}
