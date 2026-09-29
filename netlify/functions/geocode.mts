/**
 * GET /api/geocode?q=<address>      (public/_redirects routes /api/* here)
 *
 * Admin-only address lookup for the triage screen's "Test geocode" button. It keeps
 * the LINZ key on the server, asks LINZ NZ Addresses (layer 123113) and Photon
 * (OpenStreetMap) in parallel, and ranks the results with the same weights as
 * scripts/sync_charities.py: road name 0.45, house number 0.20 (+0.05 for the
 * suffix), suburb or town 0.30.
 *
 * Environment variables (Netlify: Site configuration > Environment variables, scope
 * "Functions". Values in netlify.toml do not reach functions):
 *   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY   the VITE_-prefixed names work too
 *   LINZ_API_KEY                             optional; without it, Photon only
 *   GEOCODER_CONTACT                         email address sent to Photon
 *   LINZ_ADDRESS_LAYER                       defaults to 123113
 */

type LonLat = [lon: number, lat: number]
type Precision = 'address' | 'street' | 'locality'

interface Candidate {
  lonLat: LonLat
  label: string
  source: 'linz' | 'photon'
  precision: Precision
  score: number
  number: number | null
  suffix: string | null
  road: string | null
  suburb: string | null
  city: string | null
}

interface ParsedAddress {
  number: number | null
  suffix: string | null
  numberHigh: number | null
  road: string | null
  localities: string[]
  poBox: boolean
}

interface LinzFeature {
  geometry?: { type?: string; coordinates?: unknown } | null
  properties?: Record<string, unknown> | null
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] }
  properties?: Record<string, string | number | undefined>
}

const TIMEOUT_MS = 8000
const MAX_RESULTS = 6
const DUPLICATE_METRES = 25
const PRECISION_RANK: Record<Precision, number> = { address: 0, street: 1, locality: 2 }

const ROAD_TYPES: Record<string, string> = {
  st: 'Street', str: 'Street', rd: 'Road', ave: 'Avenue', av: 'Avenue', dr: 'Drive', drv: 'Drive',
  pl: 'Place', cres: 'Crescent', cr: 'Crescent', tce: 'Terrace', terr: 'Terrace', hwy: 'Highway',
  ln: 'Lane', pde: 'Parade', blvd: 'Boulevard', ct: 'Court', crt: 'Court', gr: 'Grove',
  gdns: 'Gardens', cl: 'Close', sq: 'Square', esp: 'Esplanade', qy: 'Quay', wy: 'Way',
}
const GENERIC_ROAD_WORDS = new Set([
  ...Object.values(ROAD_TYPES).map((w) => w.toLowerCase()),
  'the', 'north', 'south', 'east', 'west', 'upper', 'lower', 'state', 'old', 'new', 'saint', 'mount',
])

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

function json(body: unknown, status = 200, cacheControl = 'private, no-store'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl },
  })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'Use GET.' }, 405)
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim()
  if (q.length < 3 || q.length > 200) return json({ error: 'Send an address of 3 to 200 characters as ?q=' }, 400)

  const denied = await requireAdmin(req.headers.get('authorization'))
  if (denied) return denied

  const parsed = parseAddress(q)
  const notices: string[] = []
  if (parsed.poBox) {
    notices.push("PO Boxes and private bags aren't street addresses. Check the register profile for a street address.")
  }

  const linzKey = env('LINZ_API_KEY')
  if (!linzKey) notices.push('LINZ_API_KEY is not set, so these are OpenStreetMap results only.')

  const [linz, photon] = await Promise.all([
    linzKey && parsed.road && !parsed.poBox
      ? searchLinz(parsed, linzKey).catch((err: unknown) => {
          notices.push(`The LINZ lookup failed (${describe(err, linzKey)}), so these are OpenStreetMap results only.`)
          return null
        })
      : Promise.resolve<Candidate[]>([]),
    searchPhoton(q).catch((err: unknown) => {
      notices.push(`The OpenStreetMap lookup failed (${describe(err)}).`)
      return null
    }),
  ])
  if (linz === null && photon === null) return json({ error: notices.join(' ') }, 502)

  const all = [...(linz ?? []), ...(photon ?? [])].filter((c) => inNz(c.lonLat))
  for (const c of all) c.score = scoreCandidate(parsed, c)
  all.sort(
    (a, b) =>
      b.score - a.score ||
      PRECISION_RANK[a.precision] - PRECISION_RANK[b.precision] ||
      (a.source === b.source ? 0 : a.source === 'linz' ? -1 : 1),
  )

  // Best first; drop anything within 25 m of a better result (LINZ and OSM often agree).
  const kept: Candidate[] = []
  for (const c of all) {
    if (kept.length >= MAX_RESULTS) break
    if (!kept.some((k) => distanceMetres(k.lonLat, c.lonLat) < DUPLICATE_METRES)) kept.push(c)
  }

  return json(
    {
      candidates: kept.map(({ lonLat, label, source, precision, score }) => ({ lonLat, label, source, precision, score })),
      ...(notices.length ? { notice: notices.join(' ') } : {}),
    },
    200,
    'private, max-age=300',
  )
}

/** Returns an error response unless the bearer token belongs to an admin (checked by the database). */
async function requireAdmin(authorization: string | null): Promise<Response | null> {
  const url = env('SUPABASE_URL', 'VITE_SUPABASE_URL')?.replace(/\/+$/, '')
  const key = env('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_ANON_KEY')
  if (!url || !key) {
    return json({ error: 'The geocoder is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY for Functions.' }, 500)
  }
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1]
  if (!token) return json({ error: 'Sign in as an admin to use the geocoder.' }, 401)

  let res: Response
  try {
    res = await fetch(`${url}/rest/v1/rpc/is_admin`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    return json({ error: "Couldn't reach Supabase to check your access." }, 502)
  }
  if (res.status === 401 || res.status === 403) return json({ error: 'Your session has expired. Sign in again.' }, 401)
  if (!res.ok) return json({ error: `The access check failed (HTTP ${res.status}).` }, 502)
  return (await res.json()) === true ? null : json({ error: 'Only admins can use the geocoder.' }, 403)
}

// ---------------------------------------------------------------------------
// Parsing and scoring
// ---------------------------------------------------------------------------

function parseAddress(input: string): ParsedAddress {
  const poBox = /\b(p\.?\s?o\.?\s?box|private bag)\b/i.test(input)
  const parts = input.split(',').map((p) => p.trim()).filter(Boolean)
  let street = parts.shift() ?? ''
  // "Level 2, 5 Queen Street": the building part comes first, the street second.
  if (/^(unit|flat|apartment|apt|suite|level|lvl|floor|shop)\b/i.test(street) && parts[0] && /\d/.test(parts[0])) {
    street = parts.shift() ?? street
  }
  const localities = parts
    .map((p) => p.replace(/\b\d{4}\b/g, '').trim())
    .filter((p) => p && !/^(new zealand|nz|aotearoa)$/i.test(p))

  // [unit/]number[suffix][-high] road — e.g. "3/12A-14 Main St"
  const m = /^(?:[a-z]?\d+[a-z]?\s*\/\s*)?(\d+)\s*([a-z])?(?:\s*-\s*(\d+)[a-z]?)?\s+(.+)$/i.exec(street)
  if (!m) return { number: null, suffix: null, numberHigh: null, road: expandRoad(street) || null, localities, poBox }
  return {
    number: Number(m[1]),
    suffix: m[2]?.toUpperCase() ?? null,
    numberHigh: m[3] ? Number(m[3]) : null,
    road: expandRoad(m[4] ?? '') || null,
    localities,
    poBox,
  }
}

function expandRoad(road: string): string {
  const words = road.replace(/\./g, '').trim().split(/\s+/).filter(Boolean)
  const last = words.at(-1)
  const full = last && words.length > 1 ? ROAD_TYPES[last.toLowerCase()] : undefined
  if (full) words[words.length - 1] = full
  return words.join(' ')
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '')
const norm = (s: string) =>
  fold(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const normPlace = (s: string) => norm(s).replace(/^mt /, 'mount ').replace(/^st /, 'saint ')
const normRoad = (s: string | null) => normPlace(expandRoad(s ?? ''))

/** Dice coefficient on character bigrams: 1 for identical strings, 0 for nothing in common. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = (s: string) => {
    const out = new Map<string, number>()
    const padded = ` ${s} `
    for (let i = 0; i < padded.length - 1; i++) {
      const g = padded.slice(i, i + 2)
      out.set(g, (out.get(g) ?? 0) + 1)
    }
    return out
  }
  const ga = grams(a)
  const gb = grams(b)
  let overlap = 0
  let total = 0
  for (const [g, n] of ga) {
    overlap += Math.min(n, gb.get(g) ?? 0)
    total += n
  }
  for (const n of gb.values()) total += n
  return (2 * overlap) / total
}

function localityScore(wanted: string[], suburb: string | null, city: string | null): number {
  if (!wanted.length) return 0.5 // nothing to confirm or contradict
  let best = 0
  for (const w of wanted) {
    for (const c of [suburb, city]) if (c) best = Math.max(best, similarity(normPlace(w), normPlace(c)))
  }
  return best >= 0.9 ? 1 : best >= 0.75 ? 0.6 : 0
}

function scoreCandidate(p: ParsedAddress, c: Candidate): number {
  let score = 0.45 * similarity(normRoad(p.road), normRoad(c.road))
  if (p.number !== null && c.number !== null) {
    const inRange = p.numberHigh !== null && c.number >= p.number && c.number <= p.numberHigh
    if (c.number === p.number || inRange) {
      score += 0.2
      if ((p.suffix ?? '') === (c.suffix ?? '').toUpperCase()) score += 0.05
    }
  }
  score += 0.3 * localityScore(p.localities, c.suburb, c.city)
  return Math.round(score * 1000) / 1000
}

// ---------------------------------------------------------------------------
// LINZ NZ Addresses (WFS, GeoServer CQL)
// ---------------------------------------------------------------------------

const cql = (value: string) => `'${value.replace(/'/g, "''")}'`

async function searchLinz(p: ParsedAddress, key: string): Promise<Candidate[]> {
  const road = fold(p.road ?? '')
  const locality = p.localities.length
    ? `(${p.localities
        .flatMap((l) => [`suburb_locality_ascii ILIKE ${cql(fold(l))}`, `town_city_ascii ILIKE ${cql(fold(l))}`])
        .join(' OR ')})`
    : null
  // The most distinctive word, for a fuzzy match within the locality ("St Johns" vs "Saint Johns").
  const core = road
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC_ROAD_WORDS.has(w.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0]

  const none = Promise.resolve<Candidate[]>([])
  const [exact, fuzzy, street] = await Promise.all([
    p.number !== null ? linzQuery(key, `address_number=${p.number} AND full_road_name_ascii ILIKE ${cql(road)}`, 30) : none,
    p.number !== null && core && locality
      ? linzQuery(key, `address_number=${p.number} AND full_road_name_ascii ILIKE ${cql(`%${core}%`)} AND ${locality}`, 30)
      : none,
    locality ? linzQuery(key, `full_road_name_ascii ILIKE ${cql(road)} AND ${locality}`, 200) : none,
  ])

  const out = [...exact, ...fuzzy]
  if (street.length) {
    // One pin in the middle of the street, for when the number isn't in the address register.
    const mid: LonLat = [median(street.map((c) => c.lonLat[0])), median(street.map((c) => c.lonLat[1]))]
    const nearest = street.reduce((best, c) => (distanceMetres(c.lonLat, mid) < distanceMetres(best.lonLat, mid) ? c : best))
    const where = [nearest.suburb, nearest.city].filter(Boolean).join(', ')
    out.push({
      ...nearest,
      precision: 'street',
      number: null,
      suffix: null,
      label: `${nearest.road ?? p.road}${where ? `, ${where}` : ''} (middle of the street)`,
    })
  }
  return out
}

async function linzQuery(key: string, filter: string, count: number): Promise<Candidate[]> {
  const layer = env('LINZ_ADDRESS_LAYER') ?? '123113'
  const params = [
    'service=WFS',
    'version=2.0.0',
    'request=GetFeature',
    `typeNames=layer-${encodeURIComponent(layer)}`,
    'outputFormat=application%2Fjson',
    'srsName=EPSG%3A4326',
    `count=${count}`,
    `cql_filter=${encodeURIComponent(filter)}`,
  ].join('&')
  const res = await fetch(`https://data.linz.govt.nz/services;key=${encodeURIComponent(key)}/wfs?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (res.status === 401 || res.status === 403) throw new Error('LINZ rejected the API key')
  if (!res.ok) throw new Error(`LINZ HTTP ${res.status}`)
  const body = (await res.json()) as { features?: LinzFeature[] }
  return (body.features ?? []).flatMap((f) => {
    const c = parseLinzFeature(f)
    return c ? [c] : []
  })
}

function parseLinzFeature(f: LinzFeature): Candidate | null {
  let coords = f.geometry?.coordinates
  if (f.geometry?.type === 'MultiPoint' && Array.isArray(coords)) coords = coords[0]
  if (!Array.isArray(coords) || coords.length < 2) return null
  const lonLat = fixAxisOrder(Number(coords[0]), Number(coords[1]))
  if (!lonLat) return null
  const p = f.properties ?? {}
  const str = (k: string): string | null => {
    const v = p[k]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const n = p.address_number
  return {
    lonLat,
    label: str('full_address') ?? str('full_address_ascii') ?? '',
    source: 'linz',
    precision: 'address',
    score: 0,
    number: typeof n === 'number' ? n : /^\d+$/.test(String(n ?? '')) ? Number(n) : null,
    suffix: str('address_number_suffix'),
    road: str('full_road_name_ascii') ?? str('full_road_name'),
    suburb: str('suburb_locality_ascii') ?? str('suburb_locality'),
    city: str('town_city_ascii') ?? str('town_city'),
  }
}

/** WFS 2.0 with EPSG:4326 may answer latitude first; NZ latitudes are negative and longitudes large. */
function fixAxisOrder(a: number, b: number): LonLat | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return a < 0 && a > -90 && Math.abs(b) > 90 ? [b, a] : [a, b]
}

// ---------------------------------------------------------------------------
// Photon (OpenStreetMap) — keyless, fair use
// ---------------------------------------------------------------------------

async function searchPhoton(q: string): Promise<Candidate[]> {
  const params = new URLSearchParams({ q, limit: '8', lang: 'en', bbox: '165.8,-47.4,178.9,-34.0' })
  const contact = env('GEOCODER_CONTACT')
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': `nz-charities-map/1.0${contact ? ` (${contact})` : ''}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`)
  const body = (await res.json()) as { features?: PhotonFeature[] }
  return (body.features ?? []).flatMap((f): Candidate[] => {
    const p = f.properties ?? {}
    const s = (k: string): string | null => {
      const v = p[k]
      return v === undefined || v === '' ? null : String(v)
    }
    const coords = f.geometry?.coordinates
    if (!coords || (s('countrycode') ?? '').toUpperCase() !== 'NZ') return []
    const house = s('housenumber')
    const hm = house ? /^(\d+)\s*([a-z])?/i.exec(house) : null
    const type = s('type')
    const street = s('street') ?? (type === 'street' ? s('name') : null)
    const first = house ? `${house} ${street ?? ''}`.trim() : (street ?? s('name'))
    const suburb = s('district') ?? s('locality')
    const city = s('city') ?? s('county')
    return [
      {
        lonLat: [Number(coords[0]), Number(coords[1])],
        label: [...new Set([first, suburb, city].filter((x): x is string => Boolean(x)))].join(', '),
        source: 'photon',
        precision: type === 'house' ? 'address' : type === 'street' ? 'street' : 'locality',
        score: 0,
        number: hm ? Number(hm[1]) : null,
        suffix: hm?.[2]?.toUpperCase() ?? null,
        road: street,
        suburb,
        city,
      },
    ]
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** NZ including the Chatham Islands (east of 180°) and the subantarctic islands. */
const inNz = ([lon, lat]: LonLat) =>
  lat >= -53 && lat <= -28 && ((lon >= 160 && lon <= 180) || (lon >= -180 && lon <= -170))

function distanceMetres([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number {
  const r = Math.PI / 180
  const dLat = (lat2 - lat1) * r
  const dLon = (lon2 - lon1) * r
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2
  return 12_742_000 * Math.asin(Math.sqrt(a))
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Short error text for notices; never echoes the LINZ key. */
function describe(err: unknown, secret?: string): string {
  const text =
    err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : err instanceof Error ? err.message : String(err)
  return secret ? text.replaceAll(secret, '***') : text
}
