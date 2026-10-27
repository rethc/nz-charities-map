/**
 * Tests for the static charity, town and sector pages (scripts/seo): town names and page
 * addresses, neighbours and groups, and that text from the register can't break the HTML.
 * Run: npm run test:pages
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { indexAreas, type AreasFile } from '../scripts/seo/areas.mts'
import { toCharity, type Charity, type Row } from '../scripts/seo/fetch.mts'
import { buildSite, regionName, SECTOR_PAGES_OVER, sectorPlural, slugify, townName } from '../scripts/seo/model.mts'
import {
  browsePage,
  charityPage,
  clip,
  districtPage,
  formatDistance,
  regionPage,
  townPage,
} from '../scripts/seo/render.mts'

const ctx = { siteUrl: 'https://example.test', analytics: '' }

let nextCc = 10000
function charity(over: Partial<Charity> = {}): Charity {
  return {
    cc: `CC${nextCc++}`,
    name: 'Test Trust',
    sector: 'Health',
    lon: 173.28,
    lat: -41.27,
    place: 'Nelson',
    street: '1 Trafalgar Street',
    suburb: null,
    city: 'Nelson',
    postcode: '7010',
    purpose: 'To help people.',
    activity: null,
    beneficiary: null,
    website: null,
    isGroup: false,
    groupCc: null,
    ...over,
  }
}

const siteOf = (charities: Charity[], groups: Record<string, string> = {}) =>
  buildSite({ charities, groupNames: new Map(Object.entries(groups)), syncedAt: null })

const row = (over: Partial<Row> = {}): Row => ({
  cc_number: 'CC12345',
  name: ' Test Trust ',
  sector: 'Other (please state)',
  street: null,
  suburb: 'Te Aro',
  city: '',
  postcode: null,
  coordinates: { coordinates: [174.77, -41.29] },
  last_synced_at: null,
  ...over,
})

test('page addresses fold macrons, case and punctuation', () => {
  assert.equal(slugify('Ōpōtiki'), 'opotiki')
  assert.equal(slugify('Porirua, New Zealand'), 'porirua')
  assert.equal(slugify('St. Arnaud'), 'st-arnaud')
  assert.equal(slugify("Arthur's Pass"), 'arthurs-pass')
  assert.equal(slugify('Education / training / research'), 'education-training-research')
})

test('a town is named by its best-written spelling', () => {
  assert.equal(townName(new Map([['AUCKLAND', 5], ['Auckland', 100], ['auckland', 2]])), 'Auckland')
  assert.equal(
    townName(new Map([['Great Barrier Island (aotea Island)', 9], ['Great Barrier Island (Aotea Island)', 1]])),
    'Great Barrier Island (Aotea Island)',
  )
  assert.equal(townName(new Map([['MANUKAU AUCKLAND', 1]])), 'Manukau Auckland')
  assert.equal(townName(new Map([["ARTHUR'S PASS", 1]])), "Arthur's Pass")
  assert.equal(townName(new Map([['Porirua, New Zealand', 1]])), 'Porirua')
})

test('sectors read naturally in headings', () => {
  assert.equal(sectorPlural('Health'), 'health charities')
  assert.equal(sectorPlural('Care / protection of animals'), 'animal welfare charities')
  assert.equal(sectorPlural('Something / new / here'), 'something, new and here charities')
})

test('register rows: only usable points, register-style numbers and web links get through', () => {
  const c = toCharity(row({ website: 'javascript:alert(1)' }))!
  assert.equal(c.name, 'Test Trust')
  assert.equal(c.sector, 'Other')
  assert.equal(c.place, 'Te Aro', 'no city: the suburb stands in, as on the map')
  assert.equal(c.website, null)
  assert.equal(toCharity(row({ website: 'https://example.org' }))!.website, 'https://example.org/')
  assert.equal(toCharity(row({ cc_number: '../../etc' })), null)
  assert.equal(toCharity(row({ coordinates: null })), null)
  assert.equal(toCharity(row({ cc_number: 'CC11026-0' }))!.cc, 'CC11026-0')
})

test('towns: spellings merge, small places get no page, every town lists all its charities', () => {
  const charities = [
    charity({ place: 'NELSON' }),
    charity({ place: 'Nelson' }),
    charity({ place: 'Nelson' }),
    charity({ place: 'Tiny', city: 'Tiny' }),
    charity({ place: 'Tiny', city: 'Tiny' }),
    ...Array.from({ length: SECTOR_PAGES_OVER + 1 }, () => charity({ place: 'Auckland', city: 'Auckland' })),
  ]
  const site = siteOf(charities)
  assert.deepEqual(
    site.towns.map((t) => [t.name, t.charities.length, t.sectorPages]),
    [
      ['Auckland', SECTOR_PAGES_OVER + 1, true],
      ['Nelson', 3, false],
    ],
  )
  assert.equal(site.townOf.get(charities[0]!.cc)?.slug, 'nelson')
  assert.equal(site.townOf.has(charities[3]!.cc), false)

  const auckland = townPage(ctx, site.towns[0]!)
  assert.equal(auckland.match(/href="\/charity\/cc\d+\/"/g)?.length, SECTOR_PAGES_OVER + 1, 'a big town lists them all')
  assert.match(auckland, /href="\/in\/auckland\/health\/"/, 'and links to its sector pages')
  const nelson = townPage(ctx, site.towns[1]!)
  assert.equal(nelson.match(/href="\/charity\/cc\d+\/"/g)?.length, 3)
  assert.doesNotMatch(nelson, /href="\/in\/nelson\/health\/"/, 'a small town has no sector pages')
})

test('towns: "CBD", "Central" and "City" join the town, but other towns with similar names stay apart', () => {
  const at = (place: string, count = 1) => Array.from({ length: count }, () => charity({ place, city: place }))
  const site = siteOf([
    ...at('Wellington', 3),
    ...at('Wellington CBD'),
    ...at('WELLINGTON CENTRAL'),
    ...at('Lower Hutt', 3),
    ...at('Hutt City'),
    ...at('Palmerston', 3),
    ...at('Palmerston North', 3),
    ...at('Havelock', 3),
    ...at('Havelock North', 3),
    ...at('Kansas City', 3), // no "Kansas" in the data: stays as it is
  ])
  assert.deepEqual(
    site.towns.map((t) => [t.name, t.charities.length]),
    [
      ['Havelock', 3],
      ['Havelock North', 3],
      ['Kansas City', 3],
      ['Lower Hutt', 4],
      ['Palmerston', 3],
      ['Palmerston North', 3],
      ['Wellington', 5],
    ],
  )
  assert.deepEqual(
    [...site.mergedTowns].map(([slug, town]) => [slug, town.slug]),
    [
      ['wellington-cbd', 'wellington'],
      ['wellington-central', 'wellington'],
      ['hutt-city', 'lower-hutt'],
    ],
  )
  const wellington = townPage(ctx, site.towns.find((t) => t.slug === 'wellington')!)
  assert.match(wellington, /<span class="sub">Wellington CBD<\/span>/, 'the list still says which part of town')
})

test('neighbours: the same address is listed apart, and nearby ones go closest first', () => {
  const here = charity({ name: 'Here' })
  const sameSpot = charity({ name: 'Same Spot' })
  const far = charity({ name: 'Far', lon: 173.3 })
  const near = charity({ name: 'Near', lon: 173.281 })
  const site = siteOf([here, sameSpot, far, near])
  assert.deepEqual(site.sameSpot.get(here.cc)?.map((c) => c.name), ['Same Spot'])
  const nearby = site.nearby.get(here.cc)!
  assert.deepEqual(nearby.map((n) => n.charity.name), ['Near', 'Far'])
  assert.ok(Math.abs(nearby[0]!.metres - 84) < 2, `about 84 m, got ${nearby[0]!.metres}`)
})

test('groups: a member names its group, and a group lists its members', () => {
  const group = charity({ name: 'Big Group', isGroup: true })
  const member = charity({ name: 'Little Member', groupCc: group.cc, lon: 174 })
  const site = siteOf([group, member], { [group.cc]: 'Big Group' })
  assert.match(
    charityPage(site, ctx, member),
    new RegExp(`Part of</dt><dd><a href="/charity/${group.cc.toLowerCase()}/">Big Group`),
  )
  assert.match(charityPage(site, ctx, group), /Member charities on the map/)
  assert.match(charityPage(site, ctx, group), /Little Member/)
})

test('text from the register cannot break out of the page', () => {
  const nasty = charity({
    name: '<script>alert(1)</script> & "Friends"',
    purpose: '</script><img src=x onerror=alert(1)>',
    website: 'https://example.org/?a=1&b="2"',
  })
  const html = charityPage(siteOf([nasty]), ctx, nasty)
  assert.doesNotMatch(html, /<script>alert/)
  assert.doesNotMatch(html, /<img/)
  assert.equal(html.match(/<script/g)?.length, 1, 'only the structured data block')
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;Friends&quot;/)
  const data = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]!
  const parsed = JSON.parse(data) as { '@graph': Array<{ name?: string; description?: string }> }
  assert.equal(parsed['@graph'][0]!.description, '</script><img src=x onerror=alert(1)>')
})

test('every page has its own canonical address and a description', () => {
  const c = charity({ cc: 'CC77777' })
  const site = siteOf([c, charity(), charity()])
  const page = charityPage(site, ctx, c)
  // Lower case: Netlify redirects addresses with capitals, and a redirecting address isn't indexed.
  assert.match(page, /<link rel="canonical" href="https:\/\/example\.test\/charity\/cc77777\/">/)
  assert.doesNotMatch(page, /href="\/charity\/CC/)
  assert.match(page, /<title>Test Trust – Nelson \| NZ Charities Map<\/title>/)
  assert.match(page, /<meta name="description" content="Registered charity in Nelson \(CC77777\)\. To help people\.">/)
  assert.match(browsePage(site, ctx), /<link rel="canonical" href="https:\/\/example\.test\/browse\/">/)
})

test('helpers: distances and short descriptions', () => {
  assert.equal(formatDistance(4), '10 m')
  assert.equal(formatDistance(347), '350 m')
  assert.equal(formatDistance(1449), '1.4 km')
  assert.equal(formatDistance(23_400), '23 km')
  assert.equal(clip('short', 20), 'short')
  assert.equal(clip('one two three four five six', 16), 'one two three…')
})

// Areas: squares standing in for Stats NZ's outlines, stored the way refresh-areas.mts writes them.
function encodeRing(ring: Array<[number, number]>, scale = 100_000): number[] {
  let px = 0
  let py = 0
  return ring.flatMap(([lon, lat]) => {
    const x = Math.round(lon * scale)
    const y = Math.round(lat * scale)
    const step = [x - px, y - py]
    px = x
    py = y
    return step
  })
}
const square = (x0: number, y0: number, x1: number, y1: number) =>
  encodeRing([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]])

const testAreas: AreasFile = {
  source: 'test',
  licence: 'test',
  fetched: '2026-01-01',
  scale: 100_000,
  regions: [
    { code: '09', name: 'Wellington Region' },
    { code: '02', name: 'Auckland' },
  ],
  districts: [
    { code: '04700', name: 'Wellington City', region: '09', polygons: [[square(174.7, -41.4, 174.8, -41.2)]] },
    { code: '04600', name: 'Lower Hutt City', region: '09', polygons: [[square(174.8, -41.4, 175.0, -41.1)]] },
    // A district with a large hole in it, like a lake.
    { code: '04800', name: 'Masterton District', region: '09', polygons: [[square(175.5, -41.1, 175.9, -40.7), square(175.6, -41.0, 175.8, -40.8)]] },
    { code: '07610', name: 'Waitematā Local Board Area', region: '02', polygons: [[square(174.7, -36.9, 174.8, -36.8)]] },
  ],
}

test('areas: a pin goes to the district it is in, or the nearest one just outside', () => {
  const areas = indexAreas(testAreas)
  assert.equal(areas.locate(174.75, -41.3)?.official, 'Wellington City')
  assert.equal(areas.locate(174.9, -41.3)?.official, 'Lower Hutt City')
  assert.equal(areas.locate(175.005, -41.3)?.official, 'Lower Hutt City', 'just off the coast')
  assert.equal(areas.locate(175.7, -40.9), null, 'in the middle of the hole')
  assert.equal(areas.locate(175.55, -40.9)?.official, 'Masterton District')
  assert.equal(areas.locate(170, -45), null, 'nowhere near')
  assert.equal(areas.locate(174.75, -41.3)?.region.official, 'Wellington Region')
})

test('areas: region names', () => {
  assert.equal(regionName('Wellington Region'), 'Wellington Region')
  assert.equal(regionName('Auckland'), 'Auckland Region')
  assert.equal(regionName('Area Outside Region'), 'Chatham Islands')
})

test('regions: charities sit in regions and districts, towns and pages follow', () => {
  const inWellington = Array.from({ length: 3 }, () => charity({ place: 'Wellington', city: 'Wellington', lon: 174.75, lat: -41.3 }))
  const inPetone = charity({ place: 'Lower Hutt', city: 'Lower Hutt', suburb: 'Petone', lon: 174.88, lat: -41.22 })
  const inAuckland = charity({ name: 'Ponsonby Trust', place: 'Auckland', city: 'Auckland', lon: 174.75, lat: -36.85 })
  const lost = charity({ lon: 170, lat: -45 })
  const site = buildSite(
    { charities: [...inWellington, inPetone, inAuckland, lost], groupNames: new Map(), syncedAt: null },
    indexAreas(testAreas),
  )

  assert.deepEqual(
    site.regions.map((r) => [r.name, r.slug, r.charities.length, r.districts.map((d) => d.name)]),
    [
      ['Auckland Region', 'auckland', 1, ['Waitematā']],
      ['Wellington Region', 'wellington', 4, ['Lower Hutt City', 'Wellington City']],
    ],
  )
  const waitemata = site.regions[0]!.districts[0]!
  assert.equal(waitemata.localBoard, true)
  assert.equal(waitemata.slug, 'waitemata')
  assert.equal(site.districtOf.has(lost.cc), false)

  const wellington = site.towns.find((t) => t.slug === 'wellington')!
  assert.equal(wellington.home?.district?.name, 'Wellington City')

  const browse = browsePage(site, ctx)
  assert.match(browse, /href="\/region\/wellington\/"/)
  const region = regionPage(site, ctx, site.regions[1]!)
  assert.match(region, /<h1>Charities in the Wellington Region<\/h1>/)
  assert.match(region, /href="\/region\/wellington\/lower-hutt-city\/"/)
  assert.match(region, /in 2 districts and cities/)
  const lowerHutt = districtPage(site, ctx, site.regions[1]!.districts[0]!)
  assert.match(lowerHutt, /<span class="sub">Petone, Lower Hutt<\/span>/)
  assert.match(regionPage(site, ctx, site.regions[0]!), /in 1 local board area\./)
  assert.match(
    districtPage(site, ctx, waitemata),
    /<title>Charities in the Waitematā local board area \| NZ Charities Map<\/title>/,
    'a local board page is told apart from a town of the same name',
  )

  const page = charityPage(site, ctx, inPetone)
  assert.match(page, /<li><a href="\/region\/wellington\/">Wellington Region<\/a><\/li><li><a href="\/region\/wellington\/lower-hutt-city\/">Lower Hutt City<\/a><\/li>/)
  assert.match(page, /"addressRegion":"Wellington"/)
})
