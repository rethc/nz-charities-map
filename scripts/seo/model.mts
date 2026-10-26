/**
 * Turns the list of charities into what the pages need: towns, sectors, registered groups and
 * each charity's neighbours. Everything is sorted, so the same data always gives the same
 * pages, and a rebuild only uploads the pages whose content changed.
 */
import { OTHER_SECTOR, sectorColour } from '../../src/lib/sectors.ts'
import type { Charity, SourceData } from './fetch.mts'

/** A town gets a page of its own from this many charities; fewer would make a near-empty page. */
export const MIN_TOWN = 3
/** A sector needs this many charities for a page of its own. */
export const MIN_SECTOR = 3
/** Up to this many charities, a town's page lists them all. Above it, it links to one page per sector. */
export const LIST_LIMIT = 400
export const NEARBY = 8

export interface Town {
  key: string
  slug: string
  name: string
  charities: Charity[]
  /** Its charities by sector, biggest sector first. */
  sectors: Array<{ sector: Sector; charities: Charity[] }>
  /** Too many to list on one page: each sector gets a page of its own. */
  split: boolean
}

export interface Sector {
  name: string
  slug: string
  colour: string
  /** "health charities", "marae on reservation land": for headings such as "Health charities in Nelson". */
  plural: string
  charities: Charity[]
  /** Has a page of its own. */
  page: boolean
}

export interface Near {
  charity: Charity
  metres: number
}

export interface Site {
  charities: Charity[]
  byCc: Map<string, Charity>
  towns: Town[]
  /** Town page for a charity's place, if that place has one. */
  townOf: Map<string, Town>
  sectors: Sector[]
  sectorByName: Map<string, Sector>
  groupNames: Map<string, string>
  /** A registered group's member charities that are on the map. */
  members: Map<string, Charity[]>
  /** Other charities at exactly the same spot. */
  sameSpot: Map<string, Charity[]>
  /** The nearest charities elsewhere, closest first. */
  nearby: Map<string, Near[]>
  syncedAt: Date | null
}

const collator = new Intl.Collator('en-NZ', { sensitivity: 'base', numeric: true })
export const byName = (a: Charity, b: Charity) => collator.compare(a.name, b.name) || (a.cc < b.cc ? -1 : 1)

/** "Ōpōtiki" → "opotiki", "Porirua, New Zealand" → "porirua", "Arthur's Pass" → "arthurs pass". */
export function foldKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/,?\s*new zealand\s*$/, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export const slugify = (text: string) => foldKey(text).replace(/ /g, '-')

const SMALL_WORDS = new Set(['of', 'the', 'and', 'on', 'at', 'in', 'by', 'upon'])

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[\s\-(])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase())
}

/**
 * The register spells some places several ways ("AUCKLAND", "Auckland", "auckland"). The page
 * uses the best-written one: not all capitals or all lower case, words capitalised, and then the
 * most common.
 */
export function townName(spellings: Map<string, number>): string {
  const flat = (s: string) => s === s.toUpperCase() || s === s.toLowerCase()
  const lowerWords = (s: string) =>
    s.split(/[\s(),-]+/).filter((w) => /^\p{Ll}/u.test(w) && !SMALL_WORDS.has(w)).length
  const [best] = [...spellings]
    .map(([s, n]) => [s.replace(/,?\s*new zealand\s*$/i, '').trim(), n] as const)
    .sort(
      ([a, n], [b, m]) =>
        Number(flat(a)) - Number(flat(b)) || lowerWords(a) - lowerWords(b) || m - n || collator.compare(a, b),
    )
  const name = best?.[0] ?? ''
  return flat(name) ? titleCase(name) : name
}

/** Headings read "Health charities in Nelson", so each sector needs a natural plural. */
const PLURALS: Record<string, string> = {
  'religious activities': 'religious charities',
  'education / training / research': 'education, training and research charities',
  'arts / culture / heritage': 'arts, culture and heritage charities',
  'sport / recreation': 'sport and recreation charities',
  'environment / conservation': 'environment and conservation charities',
  'fund-raising': 'fundraising charities',
  'people with disabilities': 'disability charities',
  'emergency / disaster relief': 'emergency and disaster relief charities',
  'accommodation / housing': 'housing charities',
  'marae on reservation land': 'marae on reservation land',
  'care / protection of animals': 'animal welfare charities',
  'international activities': 'international charities',
  'promotion of volunteering': 'volunteering charities',
  other: 'other charities',
}

export function sectorPlural(name: string): string {
  const known = PLURALS[name.toLowerCase()]
  if (known) return known
  const parts = name.toLowerCase().split(/\s*\/\s*/)
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]!
  return `${joined} charities`
}

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Ground distance in metres; flat-earth maths is plenty at these distances. */
export function metresBetween(a: Charity, b: Charity): number {
  const rad = Math.PI / 180
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return Math.hypot(x, y) * 6_371_000
}

/** The cells exactly `ring` steps out from the centre: the edge of a square. */
function* ringCells(ring: number): Generator<[number, number]> {
  if (ring === 0) {
    yield [0, 0]
    return
  }
  for (let d = -ring; d <= ring; d++) {
    yield [d, -ring]
    yield [d, ring]
  }
  for (let d = -ring + 1; d <= ring - 1; d++) {
    yield [-ring, d]
    yield [ring, d]
  }
}

/** The nearest few charities at other addresses, found through a grid so it isn't 28,000². */
function findNearby(charities: Charity[], spotOf: (c: Charity) => string, count: number): Map<string, Near[]> {
  const CELL = 0.01 // degrees: about 1.1 km north–south, 0.8 km east–west in New Zealand
  const MAX_RINGS = 60
  const cellMetres = CELL * (Math.PI / 180) * 6_371_000 * Math.cos(48 * (Math.PI / 180)) // the narrowest a cell gets
  const cellKey = (x: number, y: number) => `${x},${y}`
  const grid = new Map<string, Charity[]>()
  for (const c of charities) {
    const key = cellKey(Math.floor(c.lon / CELL), Math.floor(c.lat / CELL))
    const list = grid.get(key)
    if (list) list.push(c)
    else grid.set(key, [c])
  }

  const result = new Map<string, Near[]>()
  for (const c of charities) {
    const cx = Math.floor(c.lon / CELL)
    const cy = Math.floor(c.lat / CELL)
    const spot = spotOf(c)
    const best: Near[] = []
    for (let ring = 0; ring <= MAX_RINGS; ring++) {
      for (const [dx, dy] of ringCells(ring)) {
        for (const other of grid.get(cellKey(cx + dx, cy + dy)) ?? []) {
          if (spotOf(other) === spot) continue
          best.push({ charity: other, metres: metresBetween(c, other) })
        }
      }
      best.sort((a, b) => a.metres - b.metres || byName(a.charity, b.charity))
      best.length = Math.min(best.length, count)
      // Anything in the next ring is at least `ring` whole cells away.
      if (best.length === count && best[count - 1]!.metres <= ring * cellMetres) break
    }
    result.set(c.cc, best)
  }
  return result
}

/** Sectors go biggest first, with the catch-all "Other" always last, as in the map's legend. */
const bySize = (a: string, aCount: number, b: string, bCount: number) =>
  Number(a === OTHER_SECTOR) - Number(b === OTHER_SECTOR) || bCount - aCount || collator.compare(a, b)

export function buildSite({ charities, groupNames, syncedAt }: SourceData): Site {
  const byCc = new Map(charities.map((c) => [c.cc, c]))

  // Sectors
  const sectorLists = new Map<string, Charity[]>()
  for (const c of charities) {
    const list = sectorLists.get(c.sector)
    if (list) list.push(c)
    else sectorLists.set(c.sector, [c])
  }
  const sectors: Sector[] = [...sectorLists]
    .map(([name, list]) => ({
      name,
      slug: slugify(name),
      colour: sectorColour(name),
      plural: sectorPlural(name),
      charities: list.sort(byName),
      page: list.length >= MIN_SECTOR,
    }))
    .sort((a, b) => bySize(a.name, a.charities.length, b.name, b.charities.length))
  const sectorByName = new Map(sectors.map((s) => [s.name, s]))

  // Towns: spellings that fold to the same key are one town.
  const townLists = new Map<string, { spellings: Map<string, number>; charities: Charity[] }>()
  for (const c of charities) {
    const key = c.place ? foldKey(c.place) : ''
    if (!key) continue
    let entry = townLists.get(key)
    if (!entry) townLists.set(key, (entry = { spellings: new Map(), charities: [] }))
    entry.spellings.set(c.place!, (entry.spellings.get(c.place!) ?? 0) + 1)
    entry.charities.push(c)
  }
  const towns: Town[] = []
  const townOf = new Map<string, Town>()
  for (const [key, { spellings, charities: list }] of townLists) {
    if (list.length < MIN_TOWN) continue
    list.sort(byName)
    const groups = new Map<Sector, Charity[]>()
    for (const c of list) {
      const s = sectorByName.get(c.sector)!
      const g = groups.get(s)
      if (g) g.push(c)
      else groups.set(s, [c])
    }
    const town: Town = {
      key,
      slug: key.replace(/ /g, '-'),
      name: townName(spellings),
      charities: list,
      sectors: [...groups]
        .map(([sector, cs]) => ({ sector, charities: cs }))
        .sort((a, b) => bySize(a.sector.name, a.charities.length, b.sector.name, b.charities.length)),
      split: list.length > LIST_LIMIT,
    }
    towns.push(town)
    for (const c of list) townOf.set(c.cc, town)
  }
  towns.sort((a, b) => collator.compare(a.name, b.name))

  // Registered groups
  const members = new Map<string, Charity[]>()
  for (const c of charities) {
    if (!c.groupCc || c.groupCc === c.cc || !groupNames.has(c.groupCc)) continue
    const list = members.get(c.groupCc)
    if (list) list.push(c)
    else members.set(c.groupCc, [c])
  }
  for (const list of members.values()) list.sort(byName)

  // Neighbours
  const spotOf = (c: Charity) => `${c.lon},${c.lat}`
  const spots = new Map<string, Charity[]>()
  for (const c of charities) {
    const list = spots.get(spotOf(c))
    if (list) list.push(c)
    else spots.set(spotOf(c), [c])
  }
  const sameSpot = new Map<string, Charity[]>()
  for (const list of spots.values()) {
    if (list.length < 2) continue
    list.sort(byName)
    for (const c of list) sameSpot.set(c.cc, list.filter((o) => o !== c))
  }
  const nearby = findNearby(charities, spotOf, NEARBY)

  return { charities, byCc, towns, townOf, sectors, sectorByName, groupNames, members, sameSpot, nearby, syncedAt }
}
