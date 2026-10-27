/**
 * Official areas for the browse pages: Stats NZ's regions, and their districts and cities (with
 * Auckland split into its 21 local board areas, as Stats NZ does). The outlines live in
 * areas.json, made by refresh-areas.mts; this file finds which area a charity's pin is in.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const AREAS_FILE = fileURLToPath(new URL('areas.json', import.meta.url))

/** areas.json as written by refresh-areas.mts. */
export interface AreasFile {
  source: string
  licence: string
  fetched: string
  /** Coordinates are whole numbers: degrees × scale. */
  scale: number
  regions: Array<{ code: string; name: string }>
  districts: Array<{
    code: string
    name: string
    region: string
    /** Polygons, each a list of rings; a ring is [x0, y0, dx1, dy1, dx2, dy2, …]. */
    polygons: number[][][]
  }>
}

export interface AreaRegion {
  code: string
  /** As Stats NZ names it: "Wellington Region", "Auckland", "Area Outside Region". */
  official: string
}

export interface AreaDistrict {
  code: string
  /** As Stats NZ names it: "Lower Hutt City", "Waitematā Local Board Area". */
  official: string
  region: AreaRegion
}

type Ring = Float64Array // x0, y0, x1, y1, …
interface Shape {
  district: AreaDistrict
  rings: Ring[]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface AreaIndex {
  regions: AreaRegion[]
  districts: AreaDistrict[]
  /** The district a point is in; a point just outside every outline goes to the nearest within ~2 km. */
  locate(lon: number, lat: number): AreaDistrict | null
}

/** Ray casting over every ring at once: inside an odd number of rings means inside (holes work too). */
function contains(rings: Ring[], x: number, y: number): boolean {
  let inside = false
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i]!, yi = r[i + 1]!, xj = r[j]!, yj = r[j + 1]!
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** Squared distance from a point to a shape's outline, in degrees (fine for picking the nearest). */
function distanceSq(rings: Ring[], x: number, y: number): number {
  let best = Infinity
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const ax = r[j]!, ay = r[j + 1]!, bx = r[i]!, by = r[i + 1]!
      const dx = bx - ax, dy = by - ay
      const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0
      const ex = ax + t * dx - x, ey = ay + t * dy - y
      best = Math.min(best, ex * ex + ey * ey)
    }
  }
  return best
}

const NEAR = 0.02 // degrees, about 2 km

export function indexAreas(file: AreasFile): AreaIndex {
  const regions = file.regions.map((r) => ({ code: r.code, official: r.name }))
  const regionByCode = new Map(regions.map((r) => [r.code, r]))
  const districts: AreaDistrict[] = []
  const shapes: Shape[] = []
  for (const d of file.districts) {
    const region = regionByCode.get(d.region)
    if (!region) throw new Error(`areas.json: ${d.name} names an unknown region ${d.region}`)
    const district: AreaDistrict = { code: d.code, official: d.name, region }
    districts.push(district)
    for (const polygon of d.polygons) {
      const rings = polygon.map((encoded) => {
        const ring = new Float64Array(encoded.length)
        let x = 0
        let y = 0
        for (let i = 0; i < encoded.length; i += 2) {
          x += encoded[i]!
          y += encoded[i + 1]!
          ring[i] = x / file.scale
          ring[i + 1] = y / file.scale
        }
        return ring
      })
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      const outer = rings[0]!
      for (let i = 0; i < outer.length; i += 2) {
        minX = Math.min(minX, outer[i]!)
        maxX = Math.max(maxX, outer[i]!)
        minY = Math.min(minY, outer[i + 1]!)
        maxY = Math.max(maxY, outer[i + 1]!)
      }
      shapes.push({ district, rings, minX, minY, maxX, maxY })
    }
  }

  function locate(lon: number, lat: number): AreaDistrict | null {
    for (const s of shapes) {
      if (lon < s.minX || lon > s.maxX || lat < s.minY || lat > s.maxY) continue
      if (contains(s.rings, lon, lat)) return s.district
    }
    // Simplified outlines leave slivers along borders and coasts: take the nearest close by.
    let best: AreaDistrict | null = null
    let bestSq = NEAR * NEAR
    for (const s of shapes) {
      if (lon < s.minX - NEAR || lon > s.maxX + NEAR || lat < s.minY - NEAR || lat > s.maxY + NEAR) continue
      const d = distanceSq(s.rings, lon, lat)
      if (d < bestSq) {
        bestSq = d
        best = s.district
      }
    }
    return best
  }

  return { regions, districts, locate }
}

/** The committed areas, or null when the file is missing (the pages are then built without regions). */
export function loadAreas(): AreaIndex | null {
  if (!fs.existsSync(AREAS_FILE)) return null
  return indexAreas(JSON.parse(fs.readFileSync(AREAS_FILE, 'utf8')) as AreasFile)
}
