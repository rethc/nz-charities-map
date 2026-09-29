/**
 * Point colours by sector. Based on the Okabe–Ito palette, which stays distinguishable
 * for the common forms of colour-blindness; the busiest sectors get a colour and the
 * long tail shares a neutral grey. The pills double as the legend.
 */
const PALETTE = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#B8860B', '#56B4E9', '#6A4C93', '#E69F00']
export const OTHER_COLOUR = '#7A8589'
export const UNCATEGORISED = 'Uncategorised'

export interface SectorInfo {
  name: string
  total: number
  colour: string
}

export function buildSectors(counts: Map<string, number>): SectorInfo[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, total], i) => ({
      name,
      total,
      colour: name !== UNCATEGORISED && i < PALETTE.length ? PALETTE[i]! : OTHER_COLOUR,
    }))
}
