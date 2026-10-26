/**
 * The static pages' HTML. Every value from the register goes through esc() (or JSON.stringify
 * for structured data), because names and purposes are free text typed in by charities.
 * Styles live in browse.css; the pages run no JavaScript of their own.
 */
import type { Charity } from './fetch.mts'
import { byName, capitalise, foldKey, townName, type Near, type Sector, type Site, type Town } from './model.mts'

export interface PageContext {
  /** The live site's address, e.g. https://charities.co.nz, for canonical links and the sitemap. */
  siteUrl: string
  /** The analytics <script> tag copied from the map's own index.html, or ''. */
  analytics: string
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: string) => value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!)

export const paths = {
  browse: '/browse/',
  charity: (cc: string) => `/charity/${cc}/`,
  town: (town: Town) => `/in/${town.slug}/`,
  townSector: (town: Town, sector: Sector) => `/in/${town.slug}/${sector.slug}/`,
  sector: (sector: Sector) => `/sector/${sector.slug}/`,
}

/** Where a town's charities in one sector are listed: their own page in a big town, a section otherwise. */
const townSectorHref = (town: Town, sector: Sector) =>
  town.split ? paths.townSector(town, sector) : `${paths.town(town)}#${sector.slug}`

const mapHref = (params: Record<string, string>) => `/?${new URLSearchParams(params)}`
const registerUrl = (cc: string) => `https://register.charities.govt.nz/Charity/${encodeURIComponent(cc)}`
const directionsUrl = (c: Charity) => `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}`

const numberFormat = new Intl.NumberFormat('en-NZ')
const n = (value: number) => numberFormat.format(value)
const dateFormat = new Intl.DateTimeFormat('en-NZ', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Pacific/Auckland',
})

export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.max(10, Math.round(metres / 10) * 10)} m`
  if (metres < 10_000) return `${(metres / 1000).toFixed(1)} km`
  return `${n(Math.round(metres / 1000))} km`
}

/** Shortens text to `max` characters at a word break, for meta descriptions. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, '')}…`
}

/** Same rules as the map's popup (src/lib/charities.ts): the suburb only when it isn't the city. */
function formatAddress(c: Charity): string | null {
  const suburb = c.suburb && c.suburb !== c.city ? c.suburb : null
  const cityLine = [c.city, c.postcode].filter(Boolean).join(' ')
  return [c.street, suburb, cityLine].filter(Boolean).join(', ') || null
}

/** A place with no town page of its own, written as tidily as a town's name would be. */
const placeLabel = (site: Site, c: Charity) =>
  site.townOf.get(c.cc)?.name ?? (c.place ? townName(new Map([[c.place, 1]])) || null : null)

// Icons: the same line drawings as src/components/Icons.tsx.
const icon = (body: string, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
const PIN = icon('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>')
const EXTERNAL = icon('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', 16)
const DIRECTIONS = icon('<path d="m3 11 18-8-8 18-2-8-8-2z"/>', 16)
const BRAND =
  '<svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle cx="32" cy="32" r="30" fill="#12333a"/><circle cx="32" cy="32" r="17" fill="none" stroke="#f2b705" stroke-width="5"/><circle cx="32" cy="32" r="7" fill="#fff"/></svg>'

const dot = (colour: string) => `<span class="dot" style="background:${esc(colour)}" aria-hidden="true"></span>`

interface Crumb {
  name: string
  path?: string
}

function layout(
  ctx: PageContext,
  page: { path: string; title: string; description: string; crumbs: Crumb[]; main: string; data?: object[] },
): string {
  const url = ctx.siteUrl + page.path
  const title = `${page.title} | NZ Charities Map`
  const breadcrumbData = {
    '@type': 'BreadcrumbList',
    itemListElement: page.crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: ctx.siteUrl + (c.path ?? page.path),
    })),
  }
  // A trail of one (the browse page itself) says nothing, so it's left out.
  const trail = page.crumbs.length > 1
  const graph = [...(page.data ?? []), ...(trail ? [breadcrumbData] : [])]
  // "<" is escaped so no value can close the script element early.
  const data = graph.length
    ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>\n`
    : ''
  const crumbs = trail
    ? `<nav class="crumbs" aria-label="Breadcrumb"><ol>${page.crumbs
        .map((c, i) =>
          i === page.crumbs.length - 1
            ? `<li aria-current="page">${esc(c.name)}</li>`
            : `<li><a href="${esc(c.path!)}">${esc(c.name)}</a></li>`,
        )
        .join('')}</ol></nav>\n`
    : ''

  return `<!doctype html>
<html lang="en-NZ">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="theme-color" content="#12333a">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="NZ Charities Map">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(ctx.siteUrl)}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/browse.css">
${data}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar">
<div class="bar-in">
<a class="brand" href="/">${BRAND}<span>NZ Charities Map</span></a>
<nav class="bar-nav" aria-label="Site"><a href="${paths.browse}">Browse</a><a class="bar-map" href="/">${PIN}<span class="wide">Open the map</span><span class="narrow">Map</span></a></nav>
</div>
</header>
<main id="main" class="wrap">
${crumbs}${page.main}
</main>
<footer class="foot">
<div class="foot-in">
<p>Charity details come from the <a href="https://register.charities.govt.nz/">Charities Register</a>, © Charities Services, licensed under <a href="https://creativecommons.org/licenses/by/3.0/nz/">CC BY 3.0 NZ</a>. Locations are matched to address points from <a href="https://www.linz.govt.nz/">LINZ</a> (CC BY 4.0). NZ Charities Map is an independent site, not part of Charities Services.</p>
<p><a href="/">Map</a> · <a href="${paths.browse}">Browse by town and sector</a></p>
</div>
</footer>
${ctx.analytics}
</body>
</html>
`
}

const charityLink = (c: Charity) => `<a href="${paths.charity(c.cc)}">${esc(c.name)}</a>`

/** A plain list entry, with an optional second line (a suburb, a place). */
const listItem = (c: Charity, sub?: string | null) =>
  `<li>${charityLink(c)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</li>`

/** An entry with its sector's colour, for the short lists on a charity's page. */
function dotItem(site: Site, c: Charity, extra?: string): string {
  const sector = site.sectorByName.get(c.sector)!
  const sub = [c.sector, extra].filter(Boolean).join(' · ')
  return `<li class="with-dot">${dot(sector.colour)}<div>${charityLink(c)}<span class="sub">${esc(sub)}</span></div></li>`
}

/**
 * A suburb worth showing beside a name in a town's list: not the town itself, and not a street
 * address that ended up in the suburb field ("110 Customs Street West").
 */
const suburbIn = (town: Town, c: Charity) =>
  c.suburb && foldKey(c.suburb) !== town.key && !/^\d/.test(c.suburb) ? c.suburb : null

const sectorChip = (sector: Sector, href: string, count: number) =>
  `<li><a href="${esc(href)}">${dot(sector.colour)}${esc(sector.name)}<span class="n">${n(count)}</span></a></li>`

// ── Charity ──────────────────────────────────────────────────────────────────

const SAME_SPOT_SHOWN = 24

export function charityPage(site: Site, ctx: PageContext, c: Charity): string {
  const town = site.townOf.get(c.cc) ?? null
  const sector = site.sectorByName.get(c.sector)!
  const place = placeLabel(site, c)
  const address = formatAddress(c)
  const groupName = c.groupCc ? site.groupNames.get(c.groupCc) : undefined
  const group = c.groupCc ? site.byCc.get(c.groupCc) : undefined
  const members = c.isGroup ? (site.members.get(c.cc) ?? []) : []
  const sameSpot = site.sameSpot.get(c.cc) ?? []
  const nearby = site.nearby.get(c.cc) ?? []
  const kind = c.isGroup ? 'Registered charity group' : 'Registered charity'

  const description = c.purpose
    ? clip(`${kind} in ${place ?? 'New Zealand'} (${c.cc}). ${capitalise(c.purpose)}`, 160)
    : clip(
        `${kind} in ${place ?? 'New Zealand'} (${c.cc}), in the ${c.sector} sector. See where it is on the map, and the charities nearby.`,
        160,
      )

  const crumbs: Crumb[] = [{ name: 'Browse', path: paths.browse }]
  if (town) crumbs.push({ name: town.name, path: paths.town(town) })
  else if (sector.page) crumbs.push({ name: sector.name, path: paths.sector(sector) })
  crumbs.push({ name: c.name })

  const sectorText = sector.page ? `<a href="${paths.sector(sector)}">${esc(sector.name)}</a>` : esc(sector.name)
  const placeText = town ? `<a href="${paths.town(town)}">${esc(town.name)}</a>` : place ? esc(place) : ''
  const facts = [
    `<span class="cc"><span class="sr">Registration number </span>${esc(c.cc)}</span>`,
    `<span class="tag">${dot(sector.colour)}<span class="sr">Sector: </span>${sectorText}</span>`,
    placeText && `<span>${placeText}</span>`,
  ]
    .filter(Boolean)
    .join('<span class="sep" aria-hidden="true">·</span>')

  const details: string[] = []
  if (c.activity) details.push(`<dt>Activity</dt><dd>${esc(c.activity)}</dd>`)
  if (c.beneficiary) details.push(`<dt>Helps</dt><dd>${esc(c.beneficiary)}</dd>`)
  if (groupName) {
    const name = group ? charityLink(group) : esc(groupName)
    details.push(`<dt>Part of</dt><dd>${name}</dd>`)
  }
  details.push(`<dt>Address</dt><dd>${address ? esc(address) : '<span class="muted">Not listed</span>'}</dd>`)
  if (c.website) {
    const host = new URL(c.website).host.replace(/^www\./i, '')
    details.push(`<dt>Website</dt><dd><a href="${esc(c.website)}" rel="noopener">${esc(host)}</a></dd>`)
  }

  const sections: string[] = []
  if (members.length) {
    sections.push(`<section class="block" aria-labelledby="members">
<h2 id="members">Member charities on the map <span class="count">${n(members.length)}</span></h2>
<ul class="list cols">${members.map((m) => listItem(m, placeLabel(site, m))).join('')}</ul>
</section>`)
  }
  if (sameSpot.length) {
    const shown = sameSpot.slice(0, SAME_SPOT_SHOWN)
    const rest = sameSpot.length - shown.length
    sections.push(`<section class="block" aria-labelledby="same-spot">
<h2 id="same-spot">Also at this address <span class="count">${n(sameSpot.length)}</span></h2>
<ul class="list near">${shown.map((o) => dotItem(site, o)).join('')}</ul>
${rest > 0 ? `<p class="more"><a href="${esc(mapHref({ cc: c.cc }))}">See all ${n(sameSpot.length + 1)} at this address on the map</a></p>` : ''}
</section>`)
  }
  if (nearby.length) {
    sections.push(`<section class="block" aria-labelledby="nearby">
<h2 id="nearby">Nearby charities</h2>
<ul class="list near">${nearby.map((near: Near) => dotItem(site, near.charity, formatDistance(near.metres))).join('')}</ul>
</section>`)
  }
  const more: string[] = []
  if (town) {
    more.push(`<a href="${esc(townSectorHref(town, sector))}">More ${esc(sector.plural)} in ${esc(town.name)}</a>`)
    more.push(`<a href="${paths.town(town)}">All charities in ${esc(town.name)}</a>`)
  } else if (sector.page) {
    more.push(`<a href="${paths.sector(sector)}">${esc(capitalise(sector.plural))} in New Zealand</a>`)
  }
  if (more.length) sections.push(`<p class="more">${more.join('<span class="sep" aria-hidden="true">·</span>')}</p>`)

  const org: Record<string, unknown> = {
    '@type': 'NGO',
    '@id': `${ctx.siteUrl}${paths.charity(c.cc)}#charity`,
    name: c.name,
    identifier: { '@type': 'PropertyValue', propertyID: 'NZ Charities Register number', value: c.cc },
    sameAs: [registerUrl(c.cc)],
    geo: { '@type': 'GeoCoordinates', latitude: c.lat, longitude: c.lon },
  }
  if (c.purpose) org.description = c.purpose
  if (c.website) org.url = c.website
  if (address) {
    org.address = {
      '@type': 'PostalAddress',
      ...(c.street && { streetAddress: c.street }),
      ...((c.city ?? c.suburb) && { addressLocality: c.city ?? c.suburb }),
      ...(c.postcode && { postalCode: c.postcode }),
      addressCountry: 'NZ',
    }
  }
  if (groupName) {
    org.parentOrganization = {
      '@type': 'NGO',
      name: groupName,
      ...(group && { url: ctx.siteUrl + paths.charity(group.cc) }),
    }
  }

  const main = `<article>
<header class="head">
${c.isGroup ? '<p class="kicker">Registered group</p>' : ''}
<h1>${esc(c.name)}</h1>
<p class="facts">${facts}</p>
</header>
<section class="card" aria-label="About ${esc(c.name)}">
${c.purpose ? `<p class="purpose"><span class="sr">Purpose: </span>${esc(c.purpose)}</p>` : ''}
<div class="actions">
<a class="btn btn-primary" href="${esc(mapHref({ cc: c.cc }))}">${PIN}See it on the map</a>
<a class="btn" href="${esc(registerUrl(c.cc))}" rel="noopener">Charities Register summary${EXTERNAL}</a>
<a class="btn" href="${esc(directionsUrl(c))}" rel="noopener">${DIRECTIONS}Directions</a>
</div>
<dl class="details">${details.join('')}</dl>
</section>
${sections.join('\n')}
</article>`

  return layout(ctx, {
    path: paths.charity(c.cc),
    title: place ? `${c.name} – ${place}` : c.name,
    description,
    crumbs,
    main,
    data: [org],
  })
}

// ── Town ─────────────────────────────────────────────────────────────────────

export function townPage(ctx: PageContext, town: Town): string {
  const total = town.charities.length
  const chips = town.sectors
    .map(({ sector, charities }) => sectorChip(sector, townSectorHref(town, sector), charities.length))
    .join('')
  const lists = town.split
    ? ''
    : town.sectors
        .map(
          ({ sector, charities }) => `<section class="block" id="${sector.slug}" aria-labelledby="h-${sector.slug}">
<h2 id="h-${sector.slug}">${dot(sector.colour)}${esc(capitalise(sector.plural))} in ${esc(town.name)} <span class="count">${n(charities.length)}</span></h2>
<ul class="list cols">${charities.map((c) => listItem(c, suburbIn(town, c))).join('')}</ul>
</section>`,
        )
        .join('\n')
  const topSectors = town.sectors
    .slice(0, 3)
    .map((s) => s.sector.name.toLowerCase())
    .join(', ')

  const main = `<header class="head">
<h1>Charities in ${esc(town.name)}</h1>
<p class="lead">${n(total)} registered charities in ${esc(town.name)} are on the map. ${town.split ? 'Choose a sector to see them all.' : 'Here they are by sector.'}</p>
<div class="actions"><a class="btn btn-primary" href="${esc(mapHref({ q: town.name }))}">${PIN}See them on the map</a></div>
</header>
<nav aria-label="Sectors in ${esc(town.name)}"><ul class="chips">${chips}</ul></nav>
${lists}`

  return layout(ctx, {
    path: paths.town(town),
    title: `Charities in ${town.name}`,
    description: clip(
      `${n(total)} registered charities in ${town.name}, New Zealand, by sector (${topSectors} and more), with their addresses and what they do. Find them on the map.`,
      160,
    ),
    crumbs: [{ name: 'Browse', path: paths.browse }, { name: town.name }],
    main,
  })
}

export function townSectorPage(ctx: PageContext, town: Town, sector: Sector, charities: Charity[]): string {
  const count = charities.length
  const heading = `${capitalise(sector.plural)} in ${town.name}`
  const others = town.sectors
    .filter((s) => s.sector !== sector)
    .map((s) => sectorChip(s.sector, townSectorHref(town, s.sector), s.charities.length))
    .join('')
  const lead =
    count === 1
      ? `1 registered charity in the ${sector.name} sector in ${town.name} is on the map.`
      : `${n(count)} registered charities in the ${sector.name} sector in ${town.name} are on the map.`

  const main = `<header class="head">
<h1>${esc(heading)}</h1>
<p class="lead">${esc(lead)}</p>
<div class="actions"><a class="btn btn-primary" href="${esc(mapHref({ q: town.name, sector: sector.name }))}">${PIN}See them on the map</a></div>
</header>
<ul class="list cols">${charities.map((c) => listItem(c, suburbIn(town, c))).join('')}</ul>
<section class="block" aria-labelledby="other-sectors">
<h2 id="other-sectors">Other sectors in ${esc(town.name)}</h2>
<ul class="chips">${others}</ul>
</section>`

  return layout(ctx, {
    path: paths.townSector(town, sector),
    title: heading,
    description: clip(
      `${lead} See their addresses, what they do and where they are on the map. From the Charities Register.`,
      160,
    ),
    crumbs: [
      { name: 'Browse', path: paths.browse },
      { name: town.name, path: paths.town(town) },
      { name: sector.name },
    ],
    main,
  })
}

// ── Sector ───────────────────────────────────────────────────────────────────

export function sectorPage(site: Site, ctx: PageContext, sector: Sector): string {
  const towns: Array<{ town: Town; count: number }> = []
  const elsewhere: Charity[] = []
  for (const town of site.towns) {
    const entry = town.sectors.find((s) => s.sector === sector)
    if (entry) towns.push({ town, count: entry.charities.length })
  }
  for (const c of sector.charities) if (!site.townOf.has(c.cc)) elsewhere.push(c)
  elsewhere.sort(byName)
  const total = sector.charities.length
  const heading = `${capitalise(sector.plural)} in New Zealand`

  const main = `<header class="head">
<h1>${dot(sector.colour)}${esc(heading)}</h1>
<p class="lead">${n(total)} registered charities in the ${esc(sector.name)} sector are on the map, in ${n(towns.length)} towns and cities.</p>
<div class="actions"><a class="btn btn-primary" href="${esc(mapHref({ sector: sector.name }))}">${PIN}See them on the map</a></div>
</header>
<section class="block" aria-labelledby="by-town">
<h2 id="by-town">By town or city</h2>
<ul class="list towns">${towns
    .map(({ town, count }) => `<li><a href="${esc(townSectorHref(town, sector))}">${esc(town.name)}</a> <span class="n">${n(count)}</span></li>`)
    .join('')}</ul>
</section>
${
  elsewhere.length
    ? `<section class="block" aria-labelledby="elsewhere">
<h2 id="elsewhere">In smaller places <span class="count">${n(elsewhere.length)}</span></h2>
<ul class="list cols">${elsewhere.map((c) => listItem(c, placeLabel(site, c))).join('')}</ul>
</section>`
    : ''
}`

  const biggest = towns
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((t) => t.town.name)
    .join(', ')
  return layout(ctx, {
    path: paths.sector(sector),
    title: heading,
    description: clip(
      `${n(total)} registered ${sector.plural} across New Zealand, by town and city${biggest ? `, including ${biggest}` : ''}. Find them on the map.`,
      160,
    ),
    crumbs: [{ name: 'Browse', path: paths.browse }, { name: sector.name }],
    main,
  })
}

// ── Browse ───────────────────────────────────────────────────────────────────

export function browsePage(site: Site, ctx: PageContext): string {
  const sectors = site.sectors
    .filter((s) => s.page)
    .map((s) => sectorChip(s, paths.sector(s), s.charities.length))
    .join('')
  const byLetter = new Map<string, Town[]>()
  for (const town of site.towns) {
    const letter = foldKey(town.name).charAt(0).toUpperCase()
    const key = /[A-Z]/.test(letter) ? letter : '#'
    const list = byLetter.get(key)
    if (list) list.push(town)
    else byLetter.set(key, [town])
  }
  const letters = [...byLetter.keys()]
  const synced = site.syncedAt ? `, last checked ${dateFormat.format(site.syncedAt)}` : ''

  const main = `<header class="head">
<h1>Browse charities in New Zealand</h1>
<p class="lead">${n(site.charities.length)} registered charities are on the map. Find them by sector or by town, with what each one does and where it is. Details come from the Charities Register${esc(synced)}.</p>
<div class="actions"><a class="btn btn-primary" href="/">${PIN}Open the map</a></div>
</header>
<section class="block" aria-labelledby="by-sector">
<h2 id="by-sector">By sector</h2>
<ul class="chips">${sectors}</ul>
</section>
<section class="block" aria-labelledby="by-town">
<h2 id="by-town">By town or city</h2>
<nav class="az" aria-label="Towns by first letter"><ul>${letters
    .map((l) => `<li><a href="#letter-${l === '#' ? 'other' : l.toLowerCase()}">${l}</a></li>`)
    .join('')}</ul></nav>
${letters
  .map(
    (l) => `<h3 id="letter-${l === '#' ? 'other' : l.toLowerCase()}">${l}</h3>
<ul class="list towns">${byLetter
      .get(l)!
      .map((t) => `<li><a href="${paths.town(t)}">${esc(t.name)}</a> <span class="n">${n(t.charities.length)}</span></li>`)
      .join('')}</ul>`,
  )
  .join('\n')}
</section>`

  return layout(ctx, {
    path: paths.browse,
    title: 'Browse charities by town and sector',
    description: clip(
      `All ${n(site.charities.length)} registered charities on the NZ Charities Map, by sector and by town or city, with what each one does and where it is.`,
      160,
    ),
    crumbs: [{ name: 'Browse' }],
    main,
  })
}
