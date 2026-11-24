import { formatCount } from './dom'
import { fold } from './search'
import { supabase } from './supabase'

/**
 * Intelligence (scripts/intelligence.py), for admins only: every registered charity's measures
 * from the register's public data, in one snapshot the pages sort, filter and compare in the
 * browser. A measure is a reason to look, never a finding.
 */

/** The measures with a "worth a look" and a "priority" level. */
export type SignalKey =
  | 'asset_growth_gap'
  | 'reserves_years'
  | 'current_ratio'
  | 'dormant_years'
  | 'income_per_officer'
  | 'late_returns'
  | 'return_quality'
  | 'modified_audits'
export type MeasureKey = SignalKey | 'income' | 'income_change' | 'trading_share' | 'overseas_share' | 'officer_turnover' | 'shared_boards'
export type Level = 0 | 1 | 2
export type Group = 'money' | 'activity' | 'governance' | 'reporting'

export interface SignalRule {
  look: number
  priority: number
  /** What else must hold, in dollars, so a large ratio on small money doesn't count. */
  floor?: number
  /** A low value is the signal. */
  low?: boolean
  /** Only counts with this many officers or fewer. */
  officers?: number
}

export interface OverviewCell {
  sector: number
  band: number
  n: number
  /** Charities with a published return in every one of the years: the money below is theirs. */
  panel: number
  income: number[]
  spend: number[]
  due: number[]
  on_time: number[]
  ben_n: number
  ben: Record<string, number>
  area_n: number
  areas: Record<string, number>
}

export interface IntelMeta {
  as_of: string
  fetched: string
  /** The last five years every charity's return is due for. */
  years: number[]
  columns: string[]
  year_columns: string[]
  signals: Record<SignalKey, SignalRule>
  signal_order: SignalKey[]
  combined_threshold: number
  grace_days: number
  near_zero: number
  sectors: string[]
  counts: { charities: number; returns: number; officers: number }
  overview: { years: number[]; beneficiaries: string[]; areas: string[]; cells: OverviewCell[] }
}

export interface IntelRow {
  cc: string
  name: string
  nameKey: string
  /** The size band, named after the tier a charity of that size reports under. 0: no return to judge by. */
  band: number
  /** The tier on its latest return. */
  tier: number | null
  sector: string | null
  spend: number | null
  funds: number | null
  officers: number | null
  values: Record<MeasureKey, number | null>
  levels: Record<SignalKey, Level>
  /** Signals at "worth a look" or above, and how many of those are at "priority". */
  signals: number
  priority: number
}

export interface Intel {
  computedAt: Date | null
  meta: IntelMeta
  rows: IntelRow[]
  byCc: Map<string, IntelRow>
  /** A dry run served by `npm run dev`, not the database. */
  preview: boolean
}

export type YearStatus = 'on_time' | 'late' | 'missing' | 'processing' | 'group' | 'unknown' | 'none'

export interface IntelYear {
  fy: number
  ended: string | null
  status: YearStatus
  filed: string | null
  filedBasis: 'approved' | 'estimated' | null
  income: number | null
  spend: number | null
  funds: number | null
  fundsBasis: 'net_assets' | 'resources' | 'cash' | null
  tier: number | null
  audited: boolean | null
  modified: boolean | null
  related: boolean | null
  officers: number | null
}

export interface IntelCharity {
  city: string | null
  registered: string | null
  balance: [month: number, day: number] | null
  activity: string | null
  beneficiary: string | null
  areas: string[]
  inGroup: boolean
  note: string | null
  years: IntelYear[]
  latestReturnId: number | null
  why: Partial<Record<SignalKey, string>>
  links: { cc: string; name: string; shared: number }[]
  current: { assets: number | null; liabilities: number | null }
  purpose: string | null
  onMap: boolean
  checks: { check: string; summary: string; year_ended: string | null }[]
}

// ---- The measures -----------------------------------------------------------------------------

export interface MeasureInfo {
  key: MeasureKey
  group: Group
  title: string
  /** The signal's name on a chip, as short as it goes. */
  chip?: string
  description: string
  format: (v: number) => string
}

/** $18.6m, $668k, $940: short, as beside a charity's name. */
export function money(v: number): string {
  const sign = v < 0 ? '−' : ''
  const a = Math.abs(v)
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}b`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}m`
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`
  return `${sign}$${Math.round(a)}`
}
/** $18,551,818: in full, as in a table of figures. */
export const dollars = (v: number) => `${v < 0 ? '−' : ''}$${formatCount(Math.abs(v))}`
export const percent = (v: number) => `${Math.round(v * 100)}%`
export const signedPercent = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.round(Math.abs(v) * 100)}%`
const times = (v: number) => (v >= 999 ? '999×+' : `${v >= 100 ? Math.round(v) : v.toFixed(1)}×`)
const points = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatCount(Math.abs(v))} pts`
const count = (v: number) => formatCount(v)

export const GROUPS: Record<Group, string> = {
  money: 'Money',
  activity: 'Activity',
  governance: 'Governance',
  reporting: 'Reporting',
}

export const MEASURES: MeasureInfo[] = [
  {
    key: 'income', group: 'money', title: 'Total income',
    description: 'Total income on the latest return.',
    format: money,
  },
  {
    key: 'income_change', group: 'money', title: 'Income change, latest year',
    description: 'Income on the latest return against the year before.',
    format: signedPercent,
  },
  {
    key: 'asset_growth_gap', group: 'money', title: 'Asset growth beyond spending', chip: 'Assets outgrowing spend',
    description: 'How much faster net assets grew than spending over three years, in percentage points. A charity building up funds faster than it puts them to use.',
    format: points,
  },
  {
    key: 'reserves_years', group: 'money', title: 'Net assets ÷ annual spending', chip: 'High assets vs spend',
    description: 'Net assets as years of spending at the latest rate: 25× means it spent a twenty-fifth of what it holds. A Tier 4 (cash) return gives resources less commitments, or cash held, instead of net assets.',
    format: times,
  },
  {
    key: 'current_ratio', group: 'money', title: 'Current ratio', chip: 'Low liquidity',
    description: 'Current assets against current liabilities on the latest return: under 1, it owes more within the year than it has to hand. Tier 4 returns have no balance sheet.',
    format: (v) => (v >= 100 ? String(Math.round(v)) : v.toFixed(v < 10 ? 2 : 1)),
  },
  {
    key: 'trading_share', group: 'activity', title: 'Trading share of income',
    description: 'Trading and commercial income as a share of all income on the latest return. The forms from 2024 ask only for commercial activities, so newer returns show less than older ones.',
    format: percent,
  },
  {
    key: 'dormant_years', group: 'activity', title: 'Years of near-zero activity', chip: 'Near-zero activity',
    description: 'Years of the last five whose return shows under $1,000 of both income and spending.',
    format: count,
  },
  {
    key: 'overseas_share', group: 'activity', title: 'Share spent overseas',
    description: 'The share of its spending the charity says goes overseas, from its register record.',
    format: percent,
  },
  {
    key: 'income_per_officer', group: 'governance', title: 'Income per officer', chip: 'Thin board',
    description: 'Income on the latest return for each officer serving now. The signal: a lot of money overseen by three people or fewer.',
    format: money,
  },
  {
    key: 'officer_turnover', group: 'governance', title: 'Officer turnover',
    description: 'The share of the board that left in a year, averaged over the last five.',
    format: percent,
  },
  {
    key: 'shared_boards', group: 'governance', title: 'Boards shared with other charities',
    description: 'Other registered charities with a serving officer of the same name. The register has no id for a person, so two people with one name count as one; very common names are left out.',
    format: count,
  },
  {
    key: 'late_returns', group: 'reporting', title: 'Late or missing returns', chip: 'Late returns',
    description: 'Years of the last five whose return was filed more than 60 days after it was due, or not at all. Members of a registered group are left out: the group files for them.',
    format: count,
  },
  {
    key: 'return_quality', group: 'reporting', title: 'Return errors and blank totals', chip: 'Return errors',
    description: "Totals on the latest return that are blank or don't add up: income less spending against the surplus, assets less liabilities against net assets, net assets against equity.",
    format: count,
  },
  {
    key: 'modified_audits', group: 'reporting', title: 'Modified audit opinions', chip: 'Modified audit',
    description: 'Years of the last five for which the charity declared a modified audit opinion: qualified, adverse or a disclaimer.',
    format: count,
  },
]
export const MEASURE = Object.fromEntries(MEASURES.map((m) => [m.key, m])) as Record<MeasureKey, MeasureInfo>
export const isSignal = (meta: IntelMeta, key: MeasureKey): key is SignalKey => key in meta.signals

export const LEVEL_NAME: Record<Level, string> = { 0: 'No signal', 1: 'Worth a look', 2: 'Priority' }

/** "Tier 3 size": the size band, by the tier a charity of that size reports under. */
export const bandName = (band: number) => (band ? `Tier ${band} size` : 'No recent return')
export const BAND_RANGE: Record<number, string> = {
  1: '$33m or more a year',
  2: '$5m to $33m a year',
  3: '$140,000 to $5m a year',
  4: 'under $140,000 a year',
  0: 'no return in the last five years',
}
export const BANDS = [1, 2, 3, 4] as const

/** Where a signal starts, in words: "Worth a look from 10×, priority from 25×, with net assets of $1.0m or more." */
export function ruleText(meta: IntelMeta, key: SignalKey): string {
  const rule = meta.signals[key]
  const f = MEASURE[key].format
  const range = rule.low
    ? `Worth a look under ${f(rule.look)}, priority under ${f(rule.priority)}`
    : `Worth a look from ${f(rule.look)}, priority from ${f(rule.priority)}`
  const floor: Partial<Record<SignalKey, string>> = {
    asset_growth_gap: `where net assets grew by ${money(rule.floor ?? 0)} or more`,
    reserves_years: `with net assets of ${money(rule.floor ?? 0)} or more`,
    current_ratio: `with ${money(rule.floor ?? 0)} or more owed within the year, more than its current assets and investments together`,
    income_per_officer: `with ${rule.officers ?? 3} officers or fewer`,
  }
  return `${range}${floor[key] ? `, ${floor[key]}` : ''}.`
}

/** The level a value would have, leaving aside what else must hold. For colouring a distribution. */
export function levelOf(rule: SignalRule, value: number): Level {
  if (rule.low) return value < rule.priority ? 2 : value < rule.look ? 1 : 0
  return value >= rule.priority ? 2 : value >= rule.look ? 1 : 0
}

// ---- Where a figure sits among others ---------------------------------------------------------

/** The share of `sorted` (ascending) below `value`. */
export function shareBelow(sorted: number[], value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid]! < value) lo = mid + 1
    else hi = mid
  }
  return sorted.length ? lo / sorted.length : 0
}

/** The value a share `p` of `sorted` (ascending) falls below. */
export function quantile(sorted: number[], p: number): number | null {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))]! : null
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const s = values.slice().sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const peerCache = new WeakMap<Intel, Map<string, number[]>>()
/** Every value of a measure among charities of one size band, ascending. */
export function peers(intel: Intel, key: MeasureKey, band: number): number[] {
  let cache = peerCache.get(intel)
  if (!cache) peerCache.set(intel, (cache = new Map()))
  const id = `${key}:${band}`
  let sorted = cache.get(id)
  if (!sorted) {
    sorted = []
    for (const r of intel.rows) {
      const v = r.values[key]
      if (r.band === band && v !== null) sorted.push(v)
    }
    sorted.sort((a, b) => a - b)
    cache.set(id, sorted)
  }
  return sorted
}

/** "Higher than 92% of Tier 2 size charities", or where it sits when that says little. */
export function standing(intel: Intel, row: IntelRow, key: MeasureKey): string {
  const v = row.values[key]
  if (v === null) return 'Not on its returns'
  const sorted = peers(intel, key, row.band)
  if (sorted.length < 20) return 'Too few charities of its size to compare'
  const below = shareBelow(sorted, v)
  const above = 1 - shareBelow(sorted, v + 1e-9)
  const among = `${bandName(row.band)} charities`
  // A figure most of them share (no late returns, nothing spent overseas) is neither high nor low.
  if (1 - below - above >= 0.5) return `The same as most ${among}`
  if (below >= 0.75) return `Higher than ${Math.floor(below * 100)}% of ${among}`
  if (above >= 0.75) return `Lower than ${Math.floor(above * 100)}% of ${among}`
  return `Mid-range for ${among}`
}

// ---- Loading ----------------------------------------------------------------------------------

type Snapshot = { computed_at: string | null; meta: IntelMeta; rows: unknown[][] }

/** `npm run dev` serves a dry run of the script from .intel-preview/ here (vite.config.ts). Never in a build. */
const PREVIEW = '/__intel'

function parse(snapshot: Snapshot, preview: boolean): Intel {
  const { meta } = snapshot
  const at = Object.fromEntries(meta.columns.map((c, i) => [c, i])) as Record<string, number>
  const measureKeys = MEASURES.map((m) => m.key)
  const rows: IntelRow[] = snapshot.rows.map((raw) => {
    const get = (c: string) => raw[at[c]!] as number | null
    const values = Object.fromEntries(measureKeys.map((k) => [k, get(k) ?? null])) as Record<MeasureKey, number | null>
    const digits = String(raw[at.levels!] ?? '')
    const levels = Object.fromEntries(meta.signal_order.map((k, i) => [k, Number(digits[i] ?? 0) as Level])) as Record<SignalKey, Level>
    const flagged = meta.signal_order.filter((k) => levels[k] > 0)
    const sector = get('sector')
    const name = String(raw[at.name!])
    return {
      cc: String(raw[at.cc!]),
      name,
      nameKey: fold(name),
      band: get('band') ?? 0,
      tier: get('tier'),
      sector: sector === null || sector < 0 ? null : (meta.sectors[sector] ?? null),
      spend: get('spend'),
      funds: get('funds'),
      officers: get('officers'),
      values,
      levels,
      signals: flagged.length,
      priority: flagged.filter((k) => levels[k] === 2).length,
    }
  })
  return {
    computedAt: snapshot.computed_at ? new Date(snapshot.computed_at) : null,
    meta,
    rows,
    byCc: new Map(rows.map((r) => [r.cc, r])),
    preview,
  }
}

/** A dry run on this machine, if `npm run dev` has one to serve. */
async function previewSnapshot(): Promise<Snapshot | null> {
  if (!import.meta.env.DEV) return null
  try {
    const res = await fetch(`${PREVIEW}/snapshot`)
    return res.ok ? ((await res.json()) as Snapshot) : null
  } catch {
    return null
  }
}

let loading: Promise<Intel> | null = null

/** The snapshot, loaded once and shared by the pages. `fresh` loads it again. */
export function loadIntel(fresh = false): Promise<Intel> {
  if (loading && !fresh) return loading
  const attempt = (async () => {
    const local = await previewSnapshot()
    if (local) return parse(local, true)
    const { data, error } = await supabase.rpc('get_intel_snapshot')
    if (error) {
      // Before the intelligence migration the function doesn't exist yet.
      const missing = error.code === 'PGRST202' || /could not find the function/i.test(error.message)
      throw new Error(missing ? NOT_SET_UP : error.message)
    }
    if (!data) throw new Error(NOT_SET_UP)
    return parse(data as unknown as Snapshot, false)
  })()
  loading = attempt
  attempt.catch(() => {
    if (loading === attempt) loading = null
  })
  return attempt
}

const NOT_SET_UP =
  'The database has no intelligence yet. Run the intelligence migration in Supabase, then the "Intelligence" workflow.'

/** Whether `npm run dev` is serving a dry run: the pages then need no sign-in. Always false in a build. */
export async function hasPreview(): Promise<boolean> {
  if (!import.meta.env.DEV) return false
  try {
    return (await fetch(`${PREVIEW}/snapshot`, { method: 'HEAD' })).ok
  } catch {
    return false
  }
}

type RawCharity = {
  detail: Record<string, unknown> & { years: unknown[][]; links: [string, string, number][] }
  purpose: string | null
  on_map: boolean
  checks: IntelCharity['checks']
}

export async function loadCharity(intel: Intel, cc: string): Promise<IntelCharity | null> {
  let raw: RawCharity | null
  if (intel.preview) {
    const res = await fetch(`${PREVIEW}/charity/${encodeURIComponent(cc)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`The preview answered HTTP ${res.status}`)
    raw = (await res.json()) as RawCharity
  } else {
    const { data, error } = await supabase.rpc('get_intel_charity', { p_cc: cc })
    if (error) throw new Error(error.message)
    raw = data as unknown as RawCharity | null
  }
  if (!raw) return null
  const d = raw.detail
  const at = Object.fromEntries(intel.meta.year_columns.map((c, i) => [c, i])) as Record<string, number>
  const years: IntelYear[] = d.years.map((y) => {
    const get = <T,>(c: string) => (y[at[c]!] ?? null) as T | null
    return {
      fy: Number(y[at.fy!]),
      ended: get<string>('ended'),
      status: (get<YearStatus>('status') ?? 'none'),
      filed: get<string>('filed'),
      filedBasis: get<'approved' | 'estimated'>('filed_basis'),
      income: get<number>('income'),
      spend: get<number>('spend'),
      funds: get<number>('funds'),
      fundsBasis: get<'net_assets' | 'resources' | 'cash'>('funds_basis'),
      tier: get<number>('tier'),
      audited: get<boolean>('audited'),
      modified: get<boolean>('modified'),
      related: get<boolean>('related'),
      officers: get<number>('officers'),
    }
  })
  return {
    city: (d.city as string | null) ?? null,
    registered: (d.registered as string | null) ?? null,
    balance: (d.balance as [number, number] | null) ?? null,
    activity: (d.activity as string | null) ?? null,
    beneficiary: (d.beneficiary as string | null) ?? null,
    areas: (d.areas as string[] | undefined) ?? [],
    inGroup: Boolean(d.in_group),
    note: (d.note as string | null) ?? null,
    years,
    latestReturnId: (d.latest_return_id as number | null) ?? null,
    why: (d.why as IntelCharity['why'] | undefined) ?? {},
    links: d.links.map(([linkCc, name, shared]) => ({ cc: linkCc, name, shared })),
    current: (d.current as IntelCharity['current'] | undefined) ?? { assets: null, liabilities: null },
    purpose: raw.purpose,
    onMap: raw.on_map,
    checks: raw.checks ?? [],
  }
}

/** Charities whose name or CC number matches, best first. */
export function searchIntel(rows: IntelRow[], query: string, limit = 8): IntelRow[] {
  const q = fold(query).trim().replace(/\s+/g, ' ')
  if (q.length < 2) return []
  const cc = /^cc\s?\d+$/.test(q) ? q.replace(/\s/g, '').toUpperCase() : null
  const tokens = q.split(' ')
  const ranked: [number, IntelRow][] = []
  for (const r of rows) {
    if (cc) {
      if (r.cc.startsWith(cc)) ranked.push([r.cc === cc ? 0 : 1, r])
    } else if (tokens.every((t) => r.nameKey.includes(t))) {
      ranked.push([r.nameKey.startsWith(q) ? 1 : r.nameKey.split(' ').some((w) => w.startsWith(tokens[0]!)) ? 2 : 3, r])
    }
  }
  ranked.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length || a[1].name.localeCompare(b[1].name))
  return ranked.slice(0, limit).map(([, r]) => r)
}
