/**
 * Builds the pages search engines can read, straight after `vite build` (see "build" in
 * package.json): one per charity, town and sector, a browse page and a sitemap, all in dist/.
 *
 * The map is a single-page app, so on its own a search engine sees one page and a map it can't
 * read. These pages carry each charity's name, purpose and address as plain text and link back
 * to the map. They're rebuilt on every deploy (and weekly by the sync workflow, once a Netlify
 * build hook is set up), so they follow the register.
 *
 * Settings: VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, the same as the map's (from
 * the environment or a .env file). URL, which Netlify sets during builds, is the site's address.
 * SEO_PAGES=off skips this step.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { loadSourceData } from './fetch.mts'
import { loadAreas } from './areas.mts'
import { buildSite, type Town } from './model.mts'
import {
  browsePage,
  charityPage,
  districtPage,
  esc,
  paths,
  regionPage,
  sectorPage,
  townPage,
  townSectorPage,
  type PageContext,
} from './render.mts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const dist = path.join(root, 'dist')
const DEFAULT_SITE_URL = 'https://charities.co.nz'
/** Addresses per sitemap file; the limit is 50,000. */
const SITEMAP_CHUNK = 25_000
/** Folders this script owns in dist/, cleared before each run. */
const OUTPUT_DIRS = ['browse', 'charity', 'in', 'region', 'sector', 'sitemaps']

/** "/charity/cc12345/" → dist/charity/cc12345/index.html, which Netlify serves at that address. */
function writePage(urlPath: string, html: string) {
  const dir = path.join(dist, ...urlPath.split('/').filter(Boolean))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), html)
}

/**
 * browse.css gets the map's own Roboto font rules, so the pages use the font files the map has
 * already downloaded. Its name has no hash, so a style change doesn't change 28,000 pages.
 */
function writeStylesheet(indexHtml: string) {
  const ownCss = fs.readFileSync(fileURLToPath(new URL('browse.css', import.meta.url)), 'utf8')
  const appCssPath = indexHtml.match(/href="(\/assets\/[^"]+\.css)"/)?.[1]
  const appCss = appCssPath ? fs.readFileSync(path.join(dist, appCssPath), 'utf8') : ''
  const fonts = appCss.match(/@font-face\{[^}]*roboto-latin(?:-ext)?-wght-normal[^}]*\}/g) ?? []
  if (fonts.length === 0) console.warn('  No Roboto font rules found in the app stylesheet: the pages fall back to system fonts.')
  fs.writeFileSync(path.join(dist, 'browse.css'), `${fonts.join('\n')}\n${ownCss}`)
}

function writeSitemaps(siteUrl: string, directory: string[], charities: string[]) {
  const urlset = (list: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${list
      .map((p) => `<url><loc>${esc(siteUrl + p)}</loc></url>`)
      .join('\n')}\n</urlset>\n`
  fs.mkdirSync(path.join(dist, 'sitemaps'), { recursive: true })
  const files: string[] = ['sitemaps/directory.xml']
  fs.writeFileSync(path.join(dist, files[0]!), urlset(directory))
  for (let i = 0; i < charities.length; i += SITEMAP_CHUNK) {
    const file = `sitemaps/charities-${i / SITEMAP_CHUNK + 1}.xml`
    fs.writeFileSync(path.join(dist, file), urlset(charities.slice(i, i + SITEMAP_CHUNK)))
    files.push(file)
  }
  fs.writeFileSync(
    path.join(dist, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${files
      .map((f) => `<sitemap><loc>${esc(`${siteUrl}/${f}`)}</loc></sitemap>`)
      .join('\n')}\n</sitemapindex>\n`,
  )

  // Tell every crawler where the sitemap is (public/robots.txt has the rest).
  const robotsPath = path.join(dist, 'robots.txt')
  const robots = fs.existsSync(robotsPath) ? fs.readFileSync(robotsPath, 'utf8') : 'User-agent: *\n'
  if (!/^Sitemap:/im.test(robots)) {
    fs.writeFileSync(robotsPath, `${robots.trimEnd()}\n\nSitemap: ${siteUrl}/sitemap.xml\n`)
  }
}

/**
 * Places now listed under a bigger town ("Wellington CBD" under Wellington) send their own page
 * address on to the town's page, in case it was crawled or shared before they were merged. The
 * rules go first in dist/_redirects, ahead of its catch-all "not found" rule.
 */
function writeTownRedirects(merged: Map<string, Town>) {
  if (merged.size === 0) return
  const file = path.join(dist, '_redirects')
  const rules = [...merged]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([slug, town]) => [`/in/${slug}    ${paths.town(town)}    301`, `/in/${slug}/*    ${paths.town(town)}    301`])
  const header = '# Added by scripts/seo/build-pages.mts: places listed under a bigger town.'
  fs.writeFileSync(file, `${header}\n${rules.join('\n')}\n\n${fs.readFileSync(file, 'utf8')}`)
}

async function main() {
  if (process.env.SEO_PAGES === 'off') {
    console.log('Static pages: skipped (SEO_PAGES=off).')
    return
  }
  const env = loadEnv('production', root, 'VITE_')
  const supabaseUrl = (env.VITE_SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? '').trim()
  if (!supabaseUrl || !key) {
    console.log('Static pages: skipped, because VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are not set.')
    return
  }
  const indexPath = path.join(dist, 'index.html')
  if (!fs.existsSync(indexPath)) throw new Error('dist/index.html is missing. Run `vite build` first.')

  const started = Date.now()
  const siteUrl = (process.env.URL || DEFAULT_SITE_URL).replace(/\/+$/, '')
  console.log(`Static pages: loading charities from ${supabaseUrl} …`)
  const source = await loadSourceData(supabaseUrl, key)
  if (source.charities.length === 0) throw new Error('Supabase returned no charities.')
  const areas = loadAreas()
  if (!areas) console.warn('  scripts/seo/areas.json is missing, so there are no region pages. Run `npm run seo:areas`.')
  const site = buildSite(source, areas)

  for (const dir of OUTPUT_DIRS) fs.rmSync(path.join(dist, dir), { recursive: true, force: true })
  const indexHtml = fs.readFileSync(indexPath, 'utf8')
  // The same visitor counter as the map, so these pages show up in the site's analytics too.
  const analytics = indexHtml.match(/<script[^>]*static\.cloudflareinsights\.com[^>]*><\/script>/)?.[0] ?? ''
  const ctx: PageContext = { siteUrl, analytics }
  writeStylesheet(indexHtml)

  const directory = ['/', paths.browse]
  writePage(paths.browse, browsePage(site, ctx))
  let districtPages = 0
  for (const region of site.regions) {
    writePage(paths.region(region), regionPage(site, ctx, region))
    directory.push(paths.region(region))
    for (const district of region.districts) {
      writePage(paths.district(district), districtPage(site, ctx, district))
      directory.push(paths.district(district))
      districtPages++
    }
  }
  let sectorPages = 0
  for (const sector of site.sectors) {
    if (!sector.page) continue
    writePage(paths.sector(sector), sectorPage(site, ctx, sector))
    directory.push(paths.sector(sector))
    sectorPages++
  }
  let townSectorPages = 0
  for (const town of site.towns) {
    writePage(paths.town(town), townPage(ctx, town))
    directory.push(paths.town(town))
    if (!town.sectorPages) continue
    for (const { sector, charities } of town.sectors) {
      writePage(paths.townSector(town, sector), townSectorPage(ctx, town, sector, charities))
      directory.push(paths.townSector(town, sector))
      townSectorPages++
    }
  }
  const charityPaths = site.charities.map((c) => {
    const p = paths.charity(c.cc)
    writePage(p, charityPage(site, ctx, c))
    return p
  })
  writeSitemaps(siteUrl, directory, charityPaths)
  writeTownRedirects(site.mergedTowns)

  const fmt = new Intl.NumberFormat('en-NZ').format
  console.log(
    `Static pages: ${fmt(charityPaths.length)} charities, ${fmt(site.regions.length)} regions, ` +
      `${fmt(districtPages)} districts, ${fmt(site.towns.length)} towns ` +
      `(+${fmt(townSectorPages)} town sector pages), ${fmt(sectorPages)} sectors, ` +
      `${fmt(directory.length + charityPaths.length)} addresses in the sitemap. ` +
      `${((Date.now() - started) / 1000).toFixed(1)} s.`,
  )
}

main().catch((err: unknown) => {
  console.error(`\nStatic pages failed: ${err instanceof Error ? err.message : String(err)}`)
  console.error('The build stops here, so the version of the site that is live now stays up.')
  process.exit(1)
})
