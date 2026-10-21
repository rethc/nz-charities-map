/**
 * Point colours by sector. The eight biggest sectors each have a colour fixed by name, so a
 * sync that changes their order by size never swaps colours; the long tail shares a neutral
 * grey. The set was checked as a whole, because every pair can sit side by side on the map:
 * each pair stays apart under simulated red-green and blue-yellow colour blindness, and each
 * colour stays apart from the grey. Swap one and the set needs checking again.
 * The pills double as the legend.
 */
const SECTOR_COLOURS: Record<string, string> = {
  'religious activities': '#0072B2',
  'education / training / research': '#D55E00',
  'arts / culture / heritage': '#F275C1',
  'community development': '#C4A618',
  health: '#9F0934',
  'sport / recreation': '#4CAFFC',
  'social services': '#9566F5',
  'environment / conservation': '#52A27A',
}
export const OTHER_COLOUR = '#6F6A64'

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

/** A sector's own colour, or the shared grey. Matching ignores case and spacing. */
export function sectorColour(name: string): string {
  return SECTOR_COLOURS[name.toLowerCase().replace(/\s+/g, ' ').trim()] ?? OTHER_COLOUR
}

/**
 * Sectors with a colour first, then the grey ones, each by size; "Other" always last. The first
 * eight pills are always on show, so the legend keeps every colour even if a grey sector grows.
 */
export function buildSectors(counts: Map<string, number>): SectorInfo[] {
  const named = [...counts.entries()]
    .filter(([name]) => name !== OTHER_SECTOR)
    .map(([name, total]): SectorInfo => ({ name, total, colour: sectorColour(name) }))
    .sort(
      (a, b) =>
        Number(b.colour !== OTHER_COLOUR) - Number(a.colour !== OTHER_COLOUR) ||
        b.total - a.total ||
        a.name.localeCompare(b.name),
    )
  const other = counts.get(OTHER_SECTOR)
  return other ? [...named, { name: OTHER_SECTOR, total: other, colour: OTHER_COLOUR }] : named
}
