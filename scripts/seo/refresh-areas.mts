/**
 * Downloads Stats NZ's official region and district outlines and saves a simplified, compact copy
 * as scripts/seo/areas.json, which the page build uses to put each charity in its region and
 * district (or, in Auckland, its local board area). Stats NZ updates the boundaries once a year;
 * run this then and commit the new file: `npm run seo:areas`.
 *
 * Source: Stats NZ – Tatauranga Aotearoa, Territorial Authority Local Board 2026 and Regional
 * Council 2025, from its public ArcGIS services. Licensed CC BY 4.0.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { AREAS_FILE, type AreasFile } from './areas.mts'

const SERVICES = 'https://services2.arcgis.com/vKb0s8tBIA3bdocZ/ArcGIS/rest/services'
const DISTRICTS = { service: 'Territorial_Authority_Local_Board_2026', code: 'TALB2026_V1_00', name: 'TALB2026_V1_00_NAME' }
const REGIONS = { service: 'Regional_Council_2025', code: 'REGC2025_V1_00', name: 'REGC2025_V1_00_NAME' }
/** Outlines are simplified to within about 20 m. */
const SIMPLIFY = 0.0002
const SCALE = 100_000
/** Offshore islands with no council of their own: nothing to list. */
const SKIP = new Set(['99900'])

type Position = [number, number]
interface Feature {
  properties: Record<string, string>
  geometry: { type: 'Polygon'; coordinates: Position[][] } | { type: 'MultiPolygon'; coordinates: Position[][][] }
}

async function download(layer: { service: string; code: string; name: string }, simplify: number): Promise<Feature[]> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: `${layer.code},${layer.name}`,
    outSR: '4326',
    maxAllowableOffset: String(simplify),
    geometryPrecision: '5',
    f: 'geojson',
  })
  const res = await fetch(`${SERVICES}/${layer.service}/FeatureServer/0/query?${params}`)
  if (!res.ok) throw new Error(`${layer.service}: HTTP ${res.status}`)
  const json = (await res.json()) as { features?: Feature[]; exceededTransferLimit?: boolean }
  if (!json.features?.length || json.exceededTransferLimit) throw new Error(`${layer.service}: incomplete download`)
  return json.features
}

const polygonsOf = (f: Feature): Position[][][] =>
  f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates

function inside(polygons: Position[][][], [x, y]: Position): boolean {
  let hit = false
  for (const rings of polygons) {
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!
        const [xj, yj] = ring[j]!
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
      }
    }
  }
  return hit
}

/** [x0, y0, dx1, dy1, …] in whole units of 1/SCALE degree: about a third of the size of GeoJSON. */
function encode(ring: Position[]): number[] {
  const out: number[] = []
  let px = 0
  let py = 0
  for (const [lon, lat] of ring) {
    const x = Math.round(lon * SCALE)
    const y = Math.round(lat * SCALE)
    out.push(x - px, y - py)
    px = x
    py = y
  }
  return out
}

const [districtFeatures, regionFeatures] = await Promise.all([download(DISTRICTS, SIMPLIFY), download(REGIONS, 0.0005)])
const regions = regionFeatures
  .map((f) => ({ code: f.properties[REGIONS.code]!, name: f.properties[REGIONS.name]!, polygons: polygonsOf(f) }))
  .sort((a, b) => a.code.localeCompare(b.code))

/** The map's charities, to see where people are: a district that crosses a regional boundary goes where most of them are. */
async function charityPoints(): Promise<Position[]> {
  const env = loadEnv('production', fileURLToPath(new URL('../..', import.meta.url)), 'VITE_')
  const url = env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, '')
  if (!url) return []
  const res = await fetch(`${url}/storage/v1/object/public/public-data/charities.json`)
  if (!res.ok) return []
  const json = (await res.json()) as { rows: Array<[string, string, string, number, number]> }
  return json.rows.map((r) => [r[3], r[4]])
}

const withBox = <T extends { polygons: Position[][][] }>(item: T) => {
  const xs = item.polygons.flatMap((p) => p[0]!.map((c) => c[0]))
  const ys = item.polygons.flatMap((p) => p[0]!.map((c) => c[1]))
  return { ...item, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const }
}
const within = (item: { box: readonly number[]; polygons: Position[][][] }, [x, y]: Position) =>
  x >= item.box[0]! && x <= item.box[2]! && y >= item.box[1]! && y <= item.box[3]! && inside(item.polygons, [x, y])

const boxedRegions = regions.map(withBox)
const boxedDistricts = districtFeatures
  .filter((f) => !SKIP.has(f.properties[DISTRICTS.code]!))
  .map((f) => withBox({ code: f.properties[DISTRICTS.code]!, name: f.properties[DISTRICTS.name]!, polygons: polygonsOf(f) }))

// A district's region: most districts lie in one, but a few (Taupō, Rotorua, Waitaki and others)
// cross a regional boundary. Those go where most of their charities are, which is where most of
// their people live. With no charity data to hand, it's where most of the outline lies.
const votes = new Map<string, Map<string, number>>()
const vote = (district: string, region: string, weight: number) => {
  const tally = votes.get(district) ?? new Map<string, number>()
  tally.set(region, (tally.get(region) ?? 0) + weight)
  votes.set(district, tally)
}
const points = await charityPoints()
if (points.length === 0) console.warn('No charity data (VITE_SUPABASE_URL not set): districts are placed by their outlines.')
for (const point of points) {
  const district = boxedDistricts.find((d) => within(d, point))
  const region = district && boxedRegions.find((r) => within(r, point))
  if (district && region) vote(district.code, region.code, 1000) // a charity outweighs any number of outline points
}
for (const d of boxedDistricts) {
  for (const rings of d.polygons) {
    for (const point of rings[0]!) {
      const region = boxedRegions.find((r) => within(r, point))
      if (region) vote(d.code, region.code, 1)
    }
  }
}

const districts: AreasFile['districts'] = []
for (const f of districtFeatures) {
  const code = f.properties[DISTRICTS.code]!
  if (SKIP.has(code)) continue
  const polygons = polygonsOf(f)
  const [region] = [...(votes.get(code) ?? [])].sort((a, b) => b[1] - a[1])
  if (!region) throw new Error(`No region found for ${f.properties[DISTRICTS.name]}`)
  districts.push({
    code,
    name: f.properties[DISTRICTS.name]!,
    region: region[0],
    polygons: polygons.map((rings) => rings.map(encode)),
  })
}
districts.sort((a, b) => a.code.localeCompare(b.code))

const file: AreasFile = {
  source: `Stats NZ ${DISTRICTS.service} and ${REGIONS.service}, simplified to about 20 m`,
  licence: 'CC BY 4.0, Stats NZ – Tatauranga Aotearoa',
  fetched: new Date().toISOString().slice(0, 10),
  scale: SCALE,
  regions: regions.map(({ code, name }) => ({ code, name })),
  districts,
}
fs.writeFileSync(AREAS_FILE, `${JSON.stringify(file)}\n`)

for (const r of regions) {
  const names = districts.filter((d) => d.region === r.code).map((d) => d.name)
  console.log(`${r.name}: ${names.join(', ')}`)
}
console.log(`\nSaved ${districts.length} districts in ${regions.length} regions to ${AREAS_FILE} (${Math.round(fs.statSync(AREAS_FILE).size / 1024)} KB).`)
