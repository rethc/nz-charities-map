/**
 * Tests for netlify/functions/geocode.mts with Supabase, LINZ and Photon mocked.
 * Run: npm run test:functions
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import handler from '../netlify/functions/geocode.mts'

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>
const realFetch = globalThis.fetch
let route: Route
let linzCalls: string[] = []

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const point = (coordinates: number[], properties: Record<string, unknown>) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties,
})

// 12 Jackson Street, Petone — sent latitude-first, as WFS 2.0 sometimes does.
const PETONE_12 = point([-41.22502, 174.87501], {
  address_number: 12, full_road_name_ascii: 'Jackson Street', suburb_locality_ascii: 'Petone',
  town_city_ascii: 'Lower Hutt', full_address: '12 Jackson Street, Petone, Lower Hutt',
})
const TE_AWAMUTU_12 = point([175.3237, -38.0102], {
  address_number: 12, full_road_name_ascii: 'Jackson Street', suburb_locality_ascii: 'Te Awamutu',
  town_city_ascii: 'Te Awamutu', full_address: '12 Jackson Street, Te Awamutu',
})
const STREET = [174.8702, 174.8731, 174.8765].map((lon, i) =>
  point([lon, -41.2262], {
    address_number: 100 + i, full_road_name_ascii: 'Jackson Street', suburb_locality_ascii: 'Petone',
    town_city_ascii: 'Lower Hutt', full_address: `${100 + i} Jackson Street, Petone, Lower Hutt`,
  }),
)

const PHOTON = {
  features: [
    // Same house as LINZ's answer, ~8 m away: should be merged into it.
    { geometry: { coordinates: [174.87508, -41.22507] }, properties: { countrycode: 'NZ', type: 'house', housenumber: '12', street: 'Jackson Street', district: 'Petone', city: 'Lower Hutt' } },
    // A different country entirely: must never be offered.
    { geometry: { coordinates: [-113.49, 53.55] }, properties: { countrycode: 'CA', type: 'house', housenumber: '12', street: 'Jackson Street', city: 'Edmonton' } },
    { geometry: { coordinates: [174.8741, -41.2279] }, properties: { countrycode: 'NZ', type: 'district', name: 'Petone', city: 'Lower Hutt' } },
  ],
}

function defaultRoute(url: URL, init?: RequestInit): Response {
  if (url.pathname.endsWith('/rpc/is_admin')) {
    const auth = new Headers(init?.headers).get('authorization')
    if (auth === 'Bearer admin-token') return json(true)
    if (auth === 'Bearer user-token') return json(false)
    return json({ message: 'JWT expired' }, 401)
  }
  if (url.hostname === 'data.linz.govt.nz') {
    const filter = url.searchParams.get('cql_filter') ?? ''
    linzCalls.push(filter)
    if (filter.startsWith("address_number=12 AND full_road_name_ascii ILIKE 'Jackson Street'"))
      return json({ features: [PETONE_12, TE_AWAMUTU_12] })
    if (filter.startsWith("full_road_name_ascii ILIKE 'Jackson Street' AND")) return json({ features: STREET })
    return json({ features: [] })
  }
  if (url.hostname === 'photon.komoot.io') return json(PHOTON)
  throw new Error(`Unexpected request: ${url}`)
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://mock.supabase.co'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test'
  process.env.LINZ_API_KEY = 'linz-secret-key'
  linzCalls = []
  route = defaultRoute
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    route(new URL(input instanceof Request ? input.url : String(input)), init)) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const call = (q: string, token: string | null = 'admin-token', method = 'GET') =>
  handler(
    new Request(`https://site.test/api/geocode?q=${encodeURIComponent(q)}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  )

test('rejects non-GET requests and bad queries', async () => {
  assert.equal((await call('12 Jackson Street', 'admin-token', 'POST')).status, 405)
  assert.equal((await call('ab')).status, 400)
  assert.equal((await call('x'.repeat(201))).status, 400)
})

test('requires a signed-in admin', async () => {
  assert.equal((await call('12 Jackson Street', null)).status, 401)
  assert.equal((await call('12 Jackson Street', 'expired-token')).status, 401)
  assert.equal((await call('12 Jackson Street', 'user-token')).status, 403)
})

test('fails clearly when Supabase settings are missing', async () => {
  delete process.env.SUPABASE_URL
  const res = await call('12 Jackson Street')
  assert.equal(res.status, 500)
  assert.match((await res.json()).error, /SUPABASE_URL/)
})

test('ranks the LINZ match first, fixes axis order, drops overseas and duplicate results', async () => {
  const res = await call('12 Jackson St, Petone, Lower Hutt 5012')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'private, max-age=300')
  const { candidates, notice } = await res.json()
  assert.equal(notice, undefined)
  const [best] = candidates
  assert.equal(best.source, 'linz')
  assert.equal(best.precision, 'address')
  assert.deepEqual(best.lonLat, [174.87501, -41.22502])
  assert.ok(best.score >= 0.9, `score ${best.score}`)
  assert.ok(candidates.length <= 6)
  for (const c of candidates) {
    assert.ok(c.lonLat[1] < -30 && c.lonLat[0] > 160, `outside NZ: ${c.label}`)
    assert.ok(!c.label.includes('Edmonton'))
  }
  // The Photon copy of the same house was merged into the LINZ result.
  assert.equal(candidates.filter((c: { label: string }) => c.label.startsWith('12 Jackson Street, Petone')).length, 1)
  // Te Awamutu has the same street and number but the wrong town, so it ranks lower.
  const other = candidates.find((c: { label: string }) => c.label.includes('Te Awamutu'))
  assert.ok(other && other.score < best.score)
  assert.ok(candidates.some((c: { precision: string }) => c.precision === 'street'))
  // Road-type abbreviation expanded and the locality clause used for the street query.
  assert.ok(linzCalls.some((f) => f.includes("ILIKE 'Jackson Street' AND (suburb_locality_ascii ILIKE 'Petone'")))
})

test('falls back to OpenStreetMap when LINZ is not configured', async () => {
  delete process.env.LINZ_API_KEY
  const { candidates, notice } = await (await call('12 Jackson Street, Petone')).json()
  assert.equal(linzCalls.length, 0)
  assert.match(notice, /OpenStreetMap results only/)
  assert.ok(candidates.length > 0)
  assert.ok(candidates.every((c: { source: string }) => c.source === 'photon'))
})

test('reports a LINZ failure without leaking the key', async () => {
  route = (url, init) => {
    if (url.hostname === 'data.linz.govt.nz') throw new Error(`connect failed for key linz-secret-key`)
    return defaultRoute(url, init)
  }
  const res = await call('12 Jackson Street, Petone')
  const text = await res.text()
  assert.equal(res.status, 200)
  assert.ok(!text.includes('linz-secret-key'))
  assert.match(JSON.parse(text).notice, /LINZ lookup failed/)
})

test('explains a rejected LINZ key', async () => {
  route = (url, init) => (url.hostname === 'data.linz.govt.nz' ? json({}, 403) : defaultRoute(url, init))
  const { notice } = await (await call('12 Jackson Street, Petone')).json()
  assert.match(notice, /rejected the API key/)
})

test('returns 502 when every geocoder fails', async () => {
  route = (url, init) => {
    if (url.hostname === 'data.linz.govt.nz' || url.hostname === 'photon.komoot.io') return json({}, 500)
    return defaultRoute(url, init)
  }
  assert.equal((await call('12 Jackson Street, Petone')).status, 502)
})

test('flags PO Boxes and skips LINZ for them', async () => {
  const { notice } = await (await call('PO Box 1234, Wellington')).json()
  assert.equal(linzCalls.length, 0)
  assert.match(notice, /PO Boxes/)
})
