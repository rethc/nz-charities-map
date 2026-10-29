import {
  Body1,
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbDivider,
  BreadcrumbItem,
  Button,
  Caption1,
  Card,
  FluentProvider,
  makeStyles,
  mergeClasses,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Subtitle2,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TabList,
  Title3,
  tokens,
} from '@fluentui/react-components'
import { CursorClick20Regular, Location20Regular, Open20Regular, Search20Regular } from '@fluentui/react-icons'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { RequireAdmin } from '../../components/RequireAdmin'
import type { UsageCounts } from '../../lib/database.types'
import { formatCount } from '../../lib/dom'
import { supabase } from '../../lib/supabase'
import type { UsageKind } from '../../lib/usage'
import { AdminBar, Kpi, theme } from './AdminFrame'

/**
 * How often people press things on the public map (src/lib/usage.ts), for admins only. The
 * counts are anonymous: the kind of press per day, never who pressed it or what they opened.
 */

type Period = 'd7' | 'd30' | 'm12'
type LoadState = { status: 'loading' } | { status: 'ready'; data: UsageCounts } | { status: 'error'; message: string }

const PERIODS: Record<Period, { tab: string; foot: string }> = {
  d7: { tab: 'Last 7 days', foot: 'in the last 7 days' },
  d30: { tab: 'Last 30 days', foot: 'in the last 30 days' },
  m12: { tab: 'Last 12 months', foot: 'this month and the 11 before' },
}

/** Every kind the map counts, as the admin reads it. A Record, so a new kind can't be left out. */
const LABEL: Record<UsageKind, string> = {
  pin: "A charity's pin on the map",
  shared_pin: 'A pin for several charities at one address',
  shared_list: 'A charity from that list',
  search_pick: 'A search result',
  related: "A charity's group, or one of its members",
  shared_link: 'A link to a charity (shared, bookmarked or reloaded)',
  search: 'Searched by name or number',
  sector: 'Turned on a sector filter',
  cluster: 'Zoomed into a cluster of charities',
  locate: 'Showed their own location',
  zoom_to: 'Zoom to these',
  clear_filters: 'Clear filters',
  browse: 'Browse by region',
  summary: 'Open charity summary (Charities Register)',
  directions: 'Directions',
  website: 'Website',
  phone: 'Phone number',
  email: 'Email address',
  social: 'Social media',
  copy_link: 'Copy link',
  show_more: 'Show more of what it does',
}

const SECTIONS: { title: string; description: string; kinds: UsageKind[] }[] = [
  {
    title: 'Opening a charity',
    description: 'Where people opened a charity from.',
    kinds: ['pin', 'shared_pin', 'shared_list', 'search_pick', 'related', 'shared_link'],
  },
  {
    title: 'Finding charities',
    description: 'Searching, filtering and moving around the map.',
    kinds: ['search', 'sector', 'cluster', 'locate', 'zoom_to', 'clear_filters', 'browse'],
  },
  {
    title: "In a charity's details",
    description: 'What people did once a charity was open.',
    kinds: ['summary', 'directions', 'website', 'phone', 'email', 'social', 'copy_link', 'show_more'],
  },
]

const OPENED: UsageKind[] = ['pin', 'shared_list', 'search_pick', 'related', 'shared_link']
const FOLLOWED_UP: UsageKind[] = ['summary', 'directions', 'website', 'phone', 'email', 'social']

const dayLong = new Intl.DateTimeFormat('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayShort = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const weekday = new Intl.DateTimeFormat('en-NZ', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
const monthLong = new Intl.DateTimeFormat('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthShort = new Intl.DateTimeFormat('en-NZ', { month: 'short', timeZone: 'UTC' })
const fullDate = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
/** The database's dates are New Zealand dates: kept as UTC midnights so they never shift a day. */
const utc = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`)
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

const useStyles = makeStyles({
  root: { height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: tokens.colorNeutralBackground3 },
  scroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
  page: { maxWidth: '1760px', margin: '0 auto', padding: '16px clamp(16px, 3vw, 32px) 40px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px' },
  head: { display: 'grid', gap: '6px' },
  lead: { color: tokens.colorNeutralForeground2, maxWidth: '92ch' },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))', gap: '16px' },
  tabs: { flexWrap: 'wrap', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 30rem), 1fr))', alignItems: 'start', gap: '16px' },
  card: { display: 'grid', gap: '12px', alignContent: 'start', minWidth: 0 },
  cardTitle: { display: 'grid', gap: '2px' },
  muted: { color: tokens.colorNeutralForeground3 },
  center: { display: 'grid', placeItems: 'center', minHeight: '200px' },
  // The columns: thin bars with a rounded top and a 2px gap, on a quiet baseline.
  plot: {
    position: 'relative',
    display: 'flex',
    alignItems: 'stretch',
    gap: '2px',
    height: '180px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  col: { flex: '1 1 0', minWidth: 0, display: 'flex', alignItems: 'flex-end', cursor: 'default' },
  colBar: { width: '100%', borderRadius: '4px 4px 0 0', backgroundColor: tokens.colorBrandBackground },
  colBarHover: { backgroundColor: tokens.colorBrandBackgroundPressed },
  ticks: { position: 'relative', height: '20px', margin: '6px 0 8px', color: tokens.colorNeutralForeground3 },
  tick: { position: 'absolute', top: 0, whiteSpace: 'nowrap', fontSize: tokens.fontSizeBase200, lineHeight: tokens.lineHeightBase200 },
  tickMinor: { '@media (max-width: 640px)': { display: 'none' } },
  tip: {
    position: 'absolute',
    bottom: '100%',
    zIndex: 2,
    marginBottom: '6px',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
    borderRadius: tokens.borderRadiusMedium,
    padding: '4px 10px',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  chartBox: { paddingTop: '36px' },
  countCol: { width: '88px', textAlign: 'end', fontVariantNumeric: 'tabular-nums', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  barCol: { width: '32%' },
  track: { height: '8px' },
  bar: { height: '8px', minWidth: '2px', borderRadius: '0 4px 4px 0', backgroundColor: tokens.colorBrandBackground },
})

export default function UsagePage() {
  return (
    <>
      <title>Map usage – NZ Charities Map</title>
      <RequireAdmin>{(session) => <Usage email={session.user.email ?? null} />}</RequireAdmin>
    </>
  )
}

function Usage({ email }: { email: string | null }) {
  const s = useStyles()
  const navigate = useNavigate()
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [period, setPeriod] = useState<Period>('d30')

  const loading = load.status === 'loading'
  useEffect(() => {
    if (!loading) return
    let active = true
    supabase.rpc('get_usage_counts').then(({ data, error }) => {
      if (!active) return
      if (error) {
        // Before the usage_counts migration the function doesn't exist yet.
        const missing = error.code === 'PGRST202' || /could not find the function/i.test(error.message)
        setLoad({
          status: 'error',
          message: missing
            ? "The database isn't counting yet. Run supabase/migrations/20261030000000_usage_counts.sql in the Supabase SQL editor."
            : error.message,
        })
      } else {
        setLoad({ status: 'ready', data: data as unknown as UsageCounts })
      }
    })
    return () => {
      active = false
    }
  }, [loading])

  const data = load.status === 'ready' ? load.data : null
  const counts = useMemo(() => {
    const out = new Map<string, number>()
    for (const k of data?.kinds ?? []) out.set(k.kind, Number(k[period]))
    return out
  }, [data, period])
  const total = (kinds: UsageKind[]) => kinds.reduce((n, k) => n + (counts.get(k) ?? 0), 0)
  const all = [...counts.values()].reduce((n, v) => n + v, 0)
  const largest = Math.max(1, ...counts.values())

  return (
    <FluentProvider theme={theme} className={s.root}>
      <AdminBar email={email} current="/admin/usage" />
      <div className={s.scroll}>
        <main className={s.page}>
          <div className={s.head}>
            <Breadcrumb aria-label="Breadcrumb" size="small">
              <BreadcrumbItem>
                <BreadcrumbButton onClick={() => navigate('/admin/triage')}>Admin</BreadcrumbButton>
              </BreadcrumbItem>
              <BreadcrumbDivider />
              <BreadcrumbItem>
                <BreadcrumbButton current>Map usage</BreadcrumbButton>
              </BreadcrumbItem>
            </Breadcrumb>
            <Title3 as="h1">Map usage</Title3>
            <Body1 className={s.lead}>
              How often people press things on the public map. Only the kind of press is counted, per day: never who
              pressed it, which charity they opened or what they searched for.
              {data?.since && ` Counting since ${fullDate.format(utc(data.since))}.`}
            </Body1>
          </div>

          {load.status === 'loading' && (
            <div className={s.center}>
              <Spinner label="Loading the counts…" />
            </div>
          )}
          {load.status === 'error' && (
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Couldn't load the counts.</MessageBarTitle>
                {load.message}
              </MessageBarBody>
              <MessageBarActions>
                <Button onClick={() => setLoad({ status: 'loading' })}>Try again</Button>
              </MessageBarActions>
            </MessageBar>
          )}

          {data && (
            <>
              {!data.since && (
                <MessageBar intent="info" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>Nothing counted yet.</MessageBarTitle>
                    Counting starts when people use the public map after this update goes live.
                  </MessageBarBody>
                </MessageBar>
              )}

              <TabList
                className={s.tabs}
                selectedValue={period}
                onTabSelect={(_, d) => setPeriod(d.value as Period)}
                aria-label="Period"
              >
                {(Object.keys(PERIODS) as Period[]).map((p) => (
                  <Tab key={p} value={p}>
                    {PERIODS[p].tab}
                  </Tab>
                ))}
              </TabList>

              <section aria-label="Summary" className={s.kpis}>
                <Kpi icon={<Location20Regular />} label="Charities opened" value={formatCount(total(OPENED))}
                  foot="from a pin, a search, a list or a link" />
                <Kpi icon={<Search20Regular />} label="Searches" value={formatCount(total(['search']))}
                  foot="counted once the typing stops" />
                <Kpi icon={<Open20Regular />} label="Followed up a charity" value={formatCount(total(FOLLOWED_UP))}
                  foot="summary, directions, website, phone, email or social" />
                <Kpi icon={<CursorClick20Regular />} label="All presses" value={formatCount(all)} foot={PERIODS[period].foot} />
              </section>

              <Card className={s.card}>
                <div className={s.cardTitle}>
                  <Subtitle2 as="h2">{period === 'm12' ? 'Presses per month' : 'Presses per day'}</Subtitle2>
                  <Caption1 className={s.muted}>Everything counted, added up. Point at a column for its number.</Caption1>
                </div>
                <Columns data={data} period={period} />
              </Card>

              <div className={s.grid}>
                {SECTIONS.map((section) => (
                  <Card key={section.title} className={s.card}>
                    <div className={s.cardTitle}>
                      <Subtitle2 as="h2">{section.title}</Subtitle2>
                      <Caption1 className={s.muted}>{section.description}</Caption1>
                    </div>
                    <Table size="small" aria-label={section.title}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Pressed</TableHeaderCell>
                          <TableHeaderCell className={s.countCol}>Times</TableHeaderCell>
                          <TableHeaderCell className={s.barCol} aria-hidden="true" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...section.kinds]
                          .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
                          .map((kind) => {
                            const n = counts.get(kind) ?? 0
                            return (
                              <TableRow key={kind}>
                                <TableCell>{LABEL[kind]}</TableCell>
                                <TableCell className={s.countCol}>{formatCount(n)}</TableCell>
                                <TableCell className={s.barCol} aria-hidden="true">
                                  <div className={s.track}>
                                    {n > 0 && <div className={s.bar} style={{ width: `${(n / largest) * 100}%` }} />}
                                  </div>
                                </TableCell>
                              </TableRow>
                            )
                          })}
                      </TableBody>
                    </Table>
                  </Card>
                ))}
              </div>
            </>
          )}
        </main>
      </div>
    </FluentProvider>
  )
}

interface Point {
  key: string
  /** For the tooltip and the summary: "Thu, 30 Oct", "October 2026". */
  long: string
  /** Under the column, when it has a label. */
  short: string
  value: number
  tick: 'major' | 'minor' | null
}

/** Where a label sits under column i of n: centred, except the first and last, held in at the ends. */
function tickPlace(i: number, n: number) {
  if (i === 0) return { left: 0 }
  if (i === n - 1) return { right: 0 }
  return { left: `${((i + 0.5) / n) * 100}%`, transform: 'translateX(-50%)' }
}

/** Where the tooltip sits over column i of n: centred, or held in near either end so it stays on the card. */
function tipPlace(i: number, n: number) {
  const centre = ((i + 0.5) / n) * 100
  if (centre < 12) return { left: 0 }
  if (centre > 88) return { right: 0 }
  return { left: `${centre}%`, transform: 'translateX(-50%)' }
}

/** Presses per day (the last 7 or 30 days) or per month (this month and the 11 before), as columns. */
function Columns({ data, period }: { data: UsageCounts; period: Period }) {
  const s = useStyles()
  const [hover, setHover] = useState<number | null>(null)

  const points = useMemo<Point[]>(() => {
    const today = utc(data.today)
    if (period === 'm12') {
      const byMonth = new Map(data.months.map((m) => [m.month.slice(0, 7), Number(m.count)]))
      const last = today.getUTCFullYear() * 12 + today.getUTCMonth()
      const out: Point[] = []
      for (let at = last - 11; at <= last; at++) {
        const d = utc(`${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, '0')}-01`)
        // Every month's name on a wide screen, every other one (ending with this month) on a phone.
        const tick = (last - at) % 2 === 0 ? 'major' : 'minor'
        out.push({ key: iso(d), long: monthLong.format(d), short: monthShort.format(d), value: byMonth.get(iso(d).slice(0, 7)) ?? 0, tick })
      }
      return out
    }
    const byDay = new Map(data.days.map((d) => [d.day.slice(0, 10), Number(d.count)]))
    const n = period === 'd7' ? 7 : 30
    return Array.from({ length: n }, (_, i) => {
      const d = addDays(today, i - n + 1)
      // Every day of a week; every seventh day of a month, ending today.
      const tick = n === 7 || (n - 1 - i) % 7 === 0 ? 'major' : null
      return { key: iso(d), long: dayLong.format(d), short: n === 7 ? weekday.format(d) : dayShort.format(d), value: byDay.get(iso(d)) ?? 0, tick }
    })
  }, [data, period])

  const max = Math.max(0, ...points.map((p) => p.value))
  const busiest = points.find((p) => p.value === max)
  const sum = points.reduce((n, p) => n + p.value, 0)
  const summary =
    max > 0 && busiest
      ? `${formatCount(sum)} presses in all. The busiest was ${busiest.long}, with ${formatCount(max)}.`
      : 'Nothing counted in this period.'
  const shown = hover === null ? null : points[hover]

  return (
    <div className={s.chartBox}>
      {/* Read out as one sentence; the columns and their labels are for the eye. */}
      <div role="img" aria-label={summary}>
        <div className={s.plot} onMouseLeave={() => setHover(null)}>
          {points.map((p, i) => (
            <div key={p.key} className={s.col} onMouseEnter={() => setHover(i)}>
              {p.value > 0 && (
                <div
                  className={mergeClasses(s.colBar, hover === i && s.colBarHover)}
                  style={{ height: `${(p.value / max) * 100}%` }}
                />
              )}
            </div>
          ))}
          {shown && hover !== null && (
            <div className={s.tip} style={tipPlace(hover, points.length)}>
              {shown.long}: <strong>{formatCount(shown.value)}</strong>
            </div>
          )}
        </div>
        <div className={s.ticks}>
          {points.map((p, i) =>
            p.tick ? (
              <span
                key={p.key}
                className={mergeClasses(s.tick, p.tick === 'minor' && s.tickMinor)}
                style={tickPlace(i, points.length)}
              >
                {p.short}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <Caption1 className={s.muted} aria-hidden="true">
        {summary}
      </Caption1>
    </div>
  )
}
