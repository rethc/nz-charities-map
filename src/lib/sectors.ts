/**
 * Point colours by sector. Based on the Okabe–Ito palette, which stays distinguishable
 * for the common forms of colour-blindness; the busiest sectors get a colour and the
 * long tail shares a neutral grey. The pills double as the legend.
 */
const PALETTE = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#B8860B', '#56B4E9', '#6A4C93', '#E69F00']
export const OTHER_COLOUR = '#7A8589'

/**
 * The catch-all sector. The register's feed has no main sector for charities that chose
 * "Other (please state)" (their typed description isn't published), so blanks land here too.
 */
export const OTHER_SECTOR = 'Other'

export interface SectorInfo {
  name: string
  total: number
  colour: string
}

/** "Other (please state)" → "Other"; a missing sector also counts as Other. */
export function cleanSectorName(name: string | null | undefined): string {
  const cleaned = (name ?? '').replace(/\s*\(please state\)\s*$/i, '').trim()
  return !cleaned || cleaned.toLowerCase() === 'other' ? OTHER_SECTOR : cleaned
}

/** Real sectors by size, each with a colour; "Other" always last and grey, however big it is. */
export function buildSectors(counts: Map<string, number>): SectorInfo[] {
  const named = [...counts.entries()]
    .filter(([name]) => name !== OTHER_SECTOR)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, total], i): SectorInfo => ({ name, total, colour: PALETTE[i] ?? OTHER_COLOUR }))
  const other = counts.get(OTHER_SECTOR)
  return other ? [...named, { name: OTHER_SECTOR, total: other, colour: OTHER_COLOUR }] : named
}
