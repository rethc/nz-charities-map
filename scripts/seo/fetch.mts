/**
 * Loads what the public map shows, for the static pages: every charity with a pin, with the
 * details its popup shows, plus the names of registered groups. It uses the same publishable
 * key and row level security as the map itself, so a page can't show anything the map doesn't.
 */
import { cleanSectorName } from '../../src/lib/sectors.ts'
import { isSocialPage, socialLinks, type SocialLink } from '../../src/lib/socials.ts'

export interface Charity {
  cc: string
  name: string
  sector: string
  lon: number
  lat: number
  /** The town as the map has it: the address's city, or its suburb when there is no city. */
  place: string | null
  street: string | null
  suburb: string | null
  city: string | null
  postcode: string | null
  purpose: string | null
  activity: string | null
  beneficiary: string | null
  phone: string | null
  email: string | null
  /** Its own website: a website that is a Facebook page or the like is in `socials` instead. */
  website: string | null
  socials: SocialLink[]
  isGroup: boolean
  /** CC number of the registered group this charity is a member of. */
  groupCc: string | null
}

export interface SourceData {
  charities: Charity[]
  /** Every registered group's name by CC number, including groups that have no pin. */
  groupNames: Map<string, string>
  /** The most recent time a charity was synced from the register. */
  syncedAt: Date | null
}

export interface Row {
  cc_number: string
  name: string
  sector: string | null
  street: string | null
  suburb: string | null
  city: string | null
  postcode: string | null
  coordinates: { coordinates?: unknown } | null
  last_synced_at: string | null
  purpose?: string | null
  activity?: string | null
  beneficiary?: string | null
  phone?: string | null
  email?: string | null
  website?: string | null
  socials?: unknown
  is_group?: boolean | null
  group_cc?: string | null
}

const BASIC_COLUMNS = 'cc_number,name,sector,street,suburb,city,postcode,coordinates,last_synced_at'
const DETAIL_COLUMNS = `${BASIC_COLUMNS},purpose,activity,beneficiary,phone,email,website,is_group,group_cc`
const SOCIAL_COLUMNS = `${DETAIL_COLUMNS},socials`
/** Newest first: a database that hasn't had a migration yet refuses its columns, so the next set is tried. */
const COLUMN_SETS = [SOCIAL_COLUMNS, DETAIL_COLUMNS, BASIC_COLUMNS]
const PAGE_SIZE = 1000
const PARALLEL = 4

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A GET that tries three times when the network or the server stumbles. */
async function get(url: string, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) })
      if (res.ok || attempt === 3 || (res.status < 500 && res.status !== 429)) return res
    } catch (err) {
      if (attempt === 3) throw err
    }
    await sleep(attempt * 3000)
  }
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => '')
  return new Error(`${what} failed (HTTP ${res.status}): ${body.slice(0, 300)}`)
}

const text = (value: string | null | undefined): string | null => value?.trim() || null

/** Only plain web addresses become links. */
function webAddress(value: string | null | undefined): string | null {
  const v = text(value)
  if (!v || !/^https?:\/\//i.test(v)) return null
  try {
    return new URL(v).href
  } catch {
    return null
  }
}

/** Email addresses become mailto: links, so only plain ones get through (the sync's own rule). */
function emailAddress(value: string | null | undefined): string | null {
  const v = text(value)
  return v && /^[^@\s<>()",;:]+@[^@\s<>()",;:]+\.[A-Za-z]{2,}$/.test(v) ? v : null
}

export function toCharity(row: Row): Charity | null {
  const point = row.coordinates?.coordinates
  if (!Array.isArray(point) || typeof point[0] !== 'number' || typeof point[1] !== 'number') return null
  // CC numbers become page addresses, so only the register's own format gets through.
  if (!/^CC\d+(-\d+)?$/.test(row.cc_number)) return null
  const website = webAddress(row.website)
  return {
    cc: row.cc_number,
    name: row.name.trim(),
    sector: cleanSectorName(row.sector),
    lon: point[0],
    lat: point[1],
    place: text(row.city) ?? text(row.suburb),
    street: text(row.street),
    suburb: text(row.suburb),
    city: text(row.city),
    postcode: text(row.postcode),
    purpose: text(row.purpose),
    activity: text(row.activity),
    beneficiary: text(row.beneficiary),
    phone: text(row.phone),
    email: emailAddress(row.email),
    website: isSocialPage(website) ? null : website,
    socials: socialLinks(row.socials, website),
    isGroup: row.is_group === true,
    groupCc: text(row.group_cc),
  }
}

async function loadRows(supabaseUrl: string, headers: Record<string, string>): Promise<Row[]> {
  const pageUrl = (columns: string, offset: number) =>
    `${supabaseUrl}/rest/v1/charities?${new URLSearchParams({
      select: columns,
      order: 'cc_number',
      offset: String(offset),
      limit: String(PAGE_SIZE),
    })}`

  // The first page also asks for the total, so a server that returns fewer rows per page
  // than asked for can't make the list stop early.
  let columns = COLUMN_SETS[0]!
  let res = await get(pageUrl(columns, 0), { ...headers, Prefer: 'count=exact' })
  for (const fewer of COLUMN_SETS.slice(1)) {
    if (res.status !== 400) break
    // A database from before a migration (charity_socials, charity_details_and_groups) refuses its columns.
    const body = (await res.json().catch(() => null)) as { code?: string } | null
    if (body?.code !== '42703') throw new Error(`Loading charities failed (HTTP 400): ${JSON.stringify(body)}`)
    columns = fewer
    res = await get(pageUrl(columns, 0), { ...headers, Prefer: 'count=exact' })
  }
  if (!res.ok) throw await failure(res, 'Loading charities')
  const total = Number(res.headers.get('content-range')?.split('/')[1])
  const rows = (await res.json()) as Row[]
  if (!Number.isFinite(total)) throw new Error('Loading charities: the response had no total count')
  const step = rows.length
  if (step === 0) return rows

  const offsets: number[] = []
  for (let offset = step; offset < total; offset += step) offsets.push(offset)
  for (let i = 0; i < offsets.length; i += PARALLEL) {
    const pages = await Promise.all(
      offsets.slice(i, i + PARALLEL).map(async (offset) => {
        const r = await get(pageUrl(columns, offset), headers)
        if (!r.ok) throw await failure(r, `Loading charities from row ${offset}`)
        return (await r.json()) as Row[]
      }),
    )
    for (const page of pages) rows.push(...page)
  }
  return rows
}

/** Group names come from the map's own snapshot, which lists groups that have no pin as well. */
async function loadGroupNames(supabaseUrl: string): Promise<Map<string, string>> {
  try {
    const res = await get(`${supabaseUrl}/storage/v1/object/public/public-data/charities.json`, {})
    if (!res.ok) throw await failure(res, 'Loading the snapshot')
    const json = (await res.json()) as { groups?: Record<string, unknown> }
    const names = new Map<string, string>()
    for (const [cc, name] of Object.entries(json.groups ?? {})) {
      if (typeof name === 'string' && name.trim()) names.set(cc, name.trim())
    }
    return names
  } catch (err) {
    console.warn(`  Group names unavailable, so only groups with a pin are named: ${String(err)}`)
    return new Map()
  }
}

export async function loadSourceData(supabaseUrl: string, key: string): Promise<SourceData> {
  const headers: Record<string, string> = { apikey: key, Accept: 'application/json' }
  // Legacy anon keys are JWTs and also go in Authorization; new sb_publishable_ keys must not.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`

  const [rows, groupNames] = await Promise.all([loadRows(supabaseUrl, headers), loadGroupNames(supabaseUrl)])

  const byCc = new Map<string, Charity>()
  let synced = 0
  for (const row of rows) {
    const charity = toCharity(row)
    if (charity) byCc.set(charity.cc, charity)
    const t = row.last_synced_at ? Date.parse(row.last_synced_at) : NaN
    if (t > synced) synced = t
  }
  // A group with a pin is named even if the snapshot couldn't be read.
  for (const c of byCc.values()) if (c.isGroup && !groupNames.has(c.cc)) groupNames.set(c.cc, c.name)

  const charities = [...byCc.values()].sort((a, b) => (a.cc < b.cc ? -1 : a.cc > b.cc ? 1 : 0))
  return { charities, groupNames, syncedAt: synced ? new Date(synced) : null }
}
