import type { Feature, FeatureCollection, Point } from 'geojson'
import type { CharitiesInViewCompact, CharityDetail } from './database.types'
import { env, snapshotUrl } from './env'
import { NZ_EXTENT, type LonLat } from './geo'
import { rpcGet, selectCharity } from './publicApi'
import { fold } from './search'
import { buildSectors, cleanSectorName, OTHER_COLOUR, type SectorInfo } from './sectors'

export interface CharityPoint {
  index: number
  cc: string
  name: string
  sector: string
  place: string | null
  lonLat: LonLat
  nameKey: string
  ccKey: string
  searchKey: string
}

export interface CharityDataset {
  points: CharityPoint[]
  byCc: Map<string, CharityPoint>
  sectors: SectorInfo[]
  colourBySector: Map<string, string>
  generatedAt: string
  source: 'rpc' | 'snapshot'
}

export interface MapFeatureProps {
  cc: string
  name: string
  colour: string
}
export type CharityFeatureCollection = FeatureCollection<Point, MapFeatureProps>

function isCompact(value: unknown): value is CharitiesInViewCompact {
  return typeof value === 'object' && value !== null && Array.isArray((value as CharitiesInViewCompact).rows)
}

async function fetchSnapshot(signal?: AbortSignal): Promise<CharitiesInViewCompact> {
  const res = await fetch(snapshotUrl, { signal })
  if (!res.ok) throw new Error(`Snapshot request failed (HTTP ${res.status})`)
  const json: unknown = await res.json()
  if (!isCompact(json)) throw new Error('Snapshot has an unexpected shape')
  return json
}

async function fetchFromRpc(signal?: AbortSignal): Promise<CharitiesInViewCompact> {
  // GET (not POST) so the browser can reuse the response — the RPC sends Cache-Control.
  const data = await rpcGet<unknown>('get_charities_in_view', { ...NZ_EXTENT }, signal)
  if (!isCompact(data)) throw new Error('Unexpected response from get_charities_in_view')
  return data
}

/** Loads every mappable charity in one request (≈28k rows, ~0.5–0.8 MB compressed). */
export async function loadCharities(signal?: AbortSignal): Promise<CharityDataset> {
  if (env.dataSource === 'snapshot') {
    try {
      return buildDataset(await fetchSnapshot(signal), 'snapshot')
    } catch (err) {
      if (signal?.aborted) throw err
      console.warn('Snapshot unavailable — falling back to the live RPC.', err)
    }
  }
  return buildDataset(await fetchFromRpc(signal), 'rpc')
}

export function buildDataset(data: CharitiesInViewCompact, source: CharityDataset['source']): CharityDataset {
  const counts = new Map<string, number>()
  const points = data.rows.map(([cc, name, sector, lon, lat, place], index): CharityPoint => {
    const sectorName = cleanSectorName(sector)
    counts.set(sectorName, (counts.get(sectorName) ?? 0) + 1)
    const nameKey = fold(name)
    const ccKey = cc.toLowerCase()
    return {
      index, cc, name, place,
      sector: sectorName,
      lonLat: [lon, lat],
      nameKey, ccKey,
      searchKey: `${nameKey} ${ccKey} ${place ? fold(place) : ''}`,
    }
  })
  const sectors = buildSectors(counts)
  return {
    points,
    byCc: new Map(points.map((p) => [p.cc, p])),
    sectors,
    colourBySector: new Map(sectors.map((s) => [s.name, s.colour])),
    generatedAt: data.generated_at,
    source,
  }
}

export function toFeatureCollection(
  points: Iterable<CharityPoint>,
  colourBySector: Map<string, string>,
): CharityFeatureCollection {
  const features: Array<Feature<Point, MapFeatureProps>> = []
  for (const p of points) {
    features.push({
      type: 'Feature',
      id: p.index,
      geometry: { type: 'Point', coordinates: p.lonLat },
      properties: { cc: p.cc, name: p.name, colour: colourBySector.get(p.sector) ?? OTHER_COLOUR },
    })
  }
  return { type: 'FeatureCollection', features }
}

export function fetchCharityDetail(cc: string, signal?: AbortSignal): Promise<CharityDetail | null> {
  return selectCharity(cc, signal)
}

export const registerUrl = (cc: string) => `https://register.charities.govt.nz/Charity/${encodeURIComponent(cc)}`

export function formatAddress(d: Pick<CharityDetail, 'street' | 'suburb' | 'city' | 'postcode'>): string | null {
  const suburb = d.suburb && d.suburb !== d.city ? d.suburb : null
  const cityLine = [d.city, d.postcode].filter(Boolean).join(' ')
  return [d.street, suburb, cityLine].filter(Boolean).join(', ') || null
}
