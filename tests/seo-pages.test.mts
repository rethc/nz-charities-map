/**
 * Tests for the static charity, town and sector pages (scripts/seo): town names and page
 * addresses, neighbours and groups, and that text from the register can't break the HTML.
 * Run: npm run test:pages
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toCharity, type Charity, type Row } from '../scripts/seo/fetch.mts'
import { buildSite, SECTOR_PAGES_OVER, sectorPlural, slugify, townName } from '../scripts/seo/model.mts'
import { browsePage, charityPage, clip, formatDistance, townPage } from '../scripts/seo/render.mts'

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
  assert.equal(auckland.match(/href="\/charity\/CC\d+\/"/g)?.length, SECTOR_PAGES_OVER + 1, 'a big town lists them all')
  assert.match(auckland, /href="\/in\/auckland\/health\/"/, 'and links to its sector pages')
  const nelson = townPage(ctx, site.towns[1]!)
  assert.equal(nelson.match(/href="\/charity\/CC\d+\/"/g)?.length, 3)
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
  assert.match(charityPage(site, ctx, member), new RegExp(`Part of</dt><dd><a href="/charity/${group.cc}/">Big Group`))
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
  assert.match(page, /<link rel="canonical" href="https:\/\/example\.test\/charity\/CC77777\/">/)
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
