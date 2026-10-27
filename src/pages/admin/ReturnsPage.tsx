import {
  Badge,
  Body1,
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbDivider,
  BreadcrumbItem,
  Button,
  Caption1,
  Card,
  createTableColumn,
  DataGrid,
  DataGridBody,
  DataGridCell,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridRow,
  FluentProvider,
  Link,
  makeStyles,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  SearchBox,
  Spinner,
  Subtitle2,
  Tab,
  TabList,
  TableCellLayout,
  Text,
  Title3,
  tokens,
  webLightTheme,
  type TableColumnDefinition,
  type TableColumnId,
} from '@fluentui/react-components'
import {
  ArrowSync20Regular,
  CalendarLtr20Regular,
  ClockAlarm20Regular,
  Money20Regular,
  Open16Regular,
  SignOut20Regular,
} from '@fluentui/react-icons'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { BrandMark } from '../../components/Icons'
import { RequireAdmin } from '../../components/RequireAdmin'
import { useCharities } from '../../hooks/useCharities'
import { useElementBox } from '../../hooks/useElementBox'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { registerUrl } from '../../lib/charities'
import type { ReturnCheckFinding, ReturnChecks } from '../../lib/database.types'
import { formatCount } from '../../lib/dom'
import { fold } from '../../lib/search'
import { supabase } from '../../lib/supabase'

/**
 * Annual return checks (scripts/return_checks.py), for admins only, in Microsoft's Fluent UI:
 * the same look as the site's other reports. Automated findings from the register's public
 * data: a lead to check on the register, never a verdict.
 */

type CheckName = ReturnCheckFinding['check']
type View = 'overview' | CheckName
type LoadState = { status: 'loading' } | { status: 'ready'; data: ReturnChecks } | { status: 'error'; message: string }
type Sort = { sortColumn: TableColumnId | undefined; sortDirection: 'ascending' | 'descending' }

/** One finding, flattened for the grids and charts. */
interface Row {
  id: string
  check: CheckName
  cc: string
  name: string
  sector: string
  yearEnded: string | null
  due: string | null
  days: number
  registered: string | null
  returnYearEnded: string | null
  tier: number | null
  limit: number | null
  spent: number[]
  years: string[]
}

/** Overdue returns this late or more are listed: earlier ones are often still being processed. */
const LATE_DAYS = 60
const PAGE = 100
const NOT_ON_MAP = 'Not on the map'

const dateFormat = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const longDate = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' })
const money = (v: number) => '$' + formatCount(v)
const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const asDate = (s: string | null) => (s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null)
const showDate = (s: string | null) => {
  const d = asDate(s)
  return d && !Number.isNaN(d.getTime()) ? dateFormat.format(d) : '—'
}
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0))

const useStyles = makeStyles({
  root: { height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: tokens.colorNeutralBackground3 },
  appBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px 16px',
    padding: '8px 16px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flex: 'none',
  },
  brand: { display: 'flex', alignItems: 'center', gap: '10px' },
  appNav: { marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' },
  email: { color: tokens.colorNeutralForeground3, '@media (max-width: 640px)': { display: 'none' } },
  scroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
  page: { maxWidth: '1320px', margin: '0 auto', padding: '16px clamp(16px, 3vw, 32px) 40px', display: 'grid', gap: '16px' },
  head: { display: 'grid', gap: '6px' },
  titleRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' },
  lead: { color: tokens.colorNeutralForeground2, maxWidth: '92ch' },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))', gap: '16px' },
  kpi: { display: 'grid', gap: '8px', alignContent: 'start' },
  kpiHead: { display: 'flex', alignItems: 'center', gap: '12px', color: tokens.colorNeutralForeground2 },
  icon: {
    display: 'grid',
    placeItems: 'center',
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusLarge,
    flex: 'none',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  danger: { backgroundColor: tokens.colorStatusDangerBackground1, color: tokens.colorStatusDangerForeground1 },
  warning: { backgroundColor: tokens.colorStatusWarningBackground1, color: tokens.colorStatusWarningForeground3 },
  kpiValue: {
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeHero800,
    lineHeight: tokens.lineHeightHero800,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  muted: { color: tokens.colorNeutralForeground3 },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 30rem), 1fr))', gap: '16px' },
  card: { display: 'grid', gap: '12px', alignContent: 'start', minWidth: 0 },
  cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
  cardTitle: { display: 'grid', gap: '2px', minWidth: 0 },
  chart: { position: 'relative', minHeight: '200px' },
  tip: {
    position: 'absolute',
    zIndex: 3,
    pointerEvents: 'none',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
    borderRadius: tokens.borderRadiusMedium,
    padding: '6px 10px 8px',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    maxWidth: '20rem',
  },
  tipHead: { fontWeight: tokens.fontWeightSemibold },
  legend: { display: 'flex', flexWrap: 'wrap', gap: '4px 16px', color: tokens.colorNeutralForeground3 },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
  dot: { width: '10px', height: '10px', borderRadius: '50%', backgroundColor: tokens.colorBrandForeground1 },
  dash: { width: '14px', height: 0, borderTop: `2px dashed ${tokens.colorNeutralForeground3}` },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px 12px' },
  search: { width: 'min(100%, 22rem)' },
  gridBox: { overflowX: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground1 },
  more: { justifySelf: 'start' },
  center: { display: 'grid', placeItems: 'center', minHeight: '200px' },
})

export default function ReturnsPage() {
  return (
    <>
      <title>Annual return checks – NZ Charities Map</title>
      <RequireAdmin>{(session) => <Returns email={session.user.email ?? null} />}</RequireAdmin>
    </>
  )
}

function Returns({ email }: { email: string | null }) {
  const s = useStyles()
  const navigate = useNavigate()
  const charities = useCharities()
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [view, setView] = useState<View>('overview')

  const loading = load.status === 'loading'
  useEffect(() => {
    if (!loading) return
    let active = true
    supabase.rpc('get_return_checks').then(({ data, error }) => {
      if (!active) return
      if (error) {
        // Before the return_checks migration the function doesn't exist yet.
        const missing = error.code === 'PGRST202' || /could not find the function/i.test(error.message)
        setLoad({
          status: 'error',
          message: missing
            ? 'The database has no annual return checks yet. Run the return_checks migration in Supabase, then the "Annual return checks" workflow.'
            : error.message,
        })
      } else {
        setLoad({ status: 'ready', data: data as unknown as ReturnChecks })
      }
    })
    return () => {
      active = false
    }
  }, [loading])

  const byCc = charities.status === 'ready' ? charities.data.byCc : null
  const rows = useMemo<Row[]>(() => {
    if (load.status !== 'ready') return []
    return load.data.findings.map((f) => {
      const d = f.details
      return {
        id: `${f.check}-${f.cc}`,
        check: f.check,
        cc: f.cc,
        name: f.name,
        sector: byCc?.get(f.cc)?.sector ?? NOT_ON_MAP,
        yearEnded: f.year_ended,
        due: typeof d.due === 'string' ? d.due : null,
        days: num(d.days_overdue),
        registered: typeof d.registered_balance_date === 'string' ? d.registered_balance_date : null,
        returnYearEnded: typeof d.return_year_ended === 'string' ? d.return_year_ended : null,
        tier: d.tier === undefined ? null : num(d.tier),
        limit: d.limit === undefined ? null : num(d.limit),
        spent: Array.isArray(d.spent) ? d.spent.map(num) : [],
        years: Array.isArray(d.years) ? d.years.map((y) => String(y ?? '').slice(0, 4)) : [],
      }
    })
  }, [load, byCc])

  const lists = useMemo(
    () => ({
      overdue: rows.filter((r) => r.check === 'overdue' && r.days > LATE_DAYS),
      year_end_mismatch: rows.filter((r) => r.check === 'year_end_mismatch'),
      tier_over_limit: rows.filter((r) => r.check === 'tier_over_limit'),
    }),
    [rows],
  )
  const overdueAll = useMemo(() => rows.filter((r) => r.check === 'overdue').length, [rows])
  const checkedAt = load.status === 'ready' && load.data.checked_at ? new Date(load.data.checked_at) : null

  return (
    <FluentProvider theme={webLightTheme} className={s.root}>
      <header className={s.appBar}>
        <div className={s.brand}>
          <BrandMark size={24} />
          <Subtitle2>NZ Charities Map</Subtitle2>
          <Caption1 className={s.muted}>Admin</Caption1>
        </div>
        <nav aria-label="Admin" className={s.appNav}>
          <Button appearance="subtle" onClick={() => navigate('/admin/triage')}>
            Location review
          </Button>
          <Button appearance="subtle" as="a" href="/">
            Public map
          </Button>
          {email && <Caption1 className={s.email}>{email}</Caption1>}
          <Button appearance="secondary" icon={<SignOut20Regular />} onClick={() => void supabase.auth.signOut()}>
            Sign out
          </Button>
        </nav>
      </header>

      <div className={s.scroll}>
        <main className={s.page}>
          <div className={s.head}>
            <Breadcrumb aria-label="Breadcrumb" size="small">
              <BreadcrumbItem>
                <BreadcrumbButton onClick={() => navigate('/admin/triage')}>Admin</BreadcrumbButton>
              </BreadcrumbItem>
              <BreadcrumbDivider />
              <BreadcrumbItem>
                <BreadcrumbButton current>Annual return checks</BreadcrumbButton>
              </BreadcrumbItem>
            </Breadcrumb>
            <div className={s.titleRow}>
              <Title3 as="h1">Annual return checks</Title3>
              {checkedAt && (
                <Badge appearance="outline" color="informative" size="large" icon={<ArrowSync20Regular />}>
                  Checked {longDate.format(checkedAt)}
                </Badge>
              )}
            </div>
            {load.status === 'ready' && (
              <Body1 className={s.lead}>
                {formatCount(lists.overdue.length)} charities are more than {LATE_DAYS} days late with an annual return,{' '}
                {formatCount(lists.year_end_mismatch.length)} filed with a year end that isn't their registered balance date,
                and {formatCount(lists.tier_over_limit.length)} have outgrown their reporting tier.
              </Body1>
            )}
          </div>

          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Review only.</MessageBarTitle>
              These are automated checks of the Charities Register's public data, and some are wrong, for example where
              a charity has an extension. Confirm on the charity's register page before acting.
            </MessageBarBody>
          </MessageBar>

          {load.status === 'loading' && (
            <div className={s.center}>
              <Spinner label="Loading the checks…" />
            </div>
          )}
          {load.status === 'error' && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Couldn't load the checks.</MessageBarTitle>
                {load.message}
              </MessageBarBody>
              <MessageBarActions>
                <Button onClick={() => setLoad({ status: 'loading' })}>Try again</Button>
              </MessageBarActions>
            </MessageBar>
          )}

          {load.status === 'ready' && (
            <>
              <section aria-label="Summary" className={s.kpis}>
                <Kpi icon={<ClockAlarm20Regular />} tone="danger" label={`Returns more than ${LATE_DAYS} days late`}
                  value={formatCount(lists.overdue.length)} foot={`of ${formatCount(overdueAll)} overdue in all`} />
                <Kpi icon={<CalendarLtr20Regular />} tone="warning" label="Year end differs from register"
                  value={formatCount(lists.year_end_mismatch.length)} foot="latest return vs registered balance date" />
                <Kpi icon={<Money20Regular />} tone="warning" label="Outgrown their tier"
                  value={formatCount(lists.tier_over_limit.length)} foot="three returns running over the limit" />
                <Kpi icon={<ArrowSync20Regular />} label="Last checked"
                  value={checkedAt ? dateFormat.format(checkedAt).replace(/ \d{4}$/, '') : '—'} foot="runs every Monday morning" />
              </section>

              <TabList
                className={s.tabs}
                selectedValue={view}
                onTabSelect={(_, d) => setView(d.value as View)}
                aria-label="Views"
              >
                <Tab value="overview">Overview</Tab>
                <Tab value="overdue">
                  Overdue <Badge appearance="tint" color="informative" shape="circular" size="small">{formatCount(lists.overdue.length)}</Badge>
                </Tab>
                <Tab value="year_end_mismatch">
                  Year end <Badge appearance="tint" color="informative" shape="circular" size="small">{formatCount(lists.year_end_mismatch.length)}</Badge>
                </Tab>
                <Tab value="tier_over_limit">
                  Tier limit <Badge appearance="tint" color="informative" shape="circular" size="small">{formatCount(lists.tier_over_limit.length)}</Badge>
                </Tab>
              </TabList>

              {view === 'overview' && (
                <Overview rows={rows} lists={lists} charities={charities} onView={setView} />
              )}
              {view === 'overdue' && (
                <FindingsGrid
                  key="overdue"
                  title={`Returns more than ${LATE_DAYS} days late`}
                  description="Extensions aren't in the public data, and some charities file through a group the data doesn't record: the register page is the final word."
                  rows={lists.overdue}
                  kind="overdue"
                />
              )}
              {view === 'year_end_mismatch' && (
                <FindingsGrid
                  key="year_end_mismatch"
                  title="Year end differs from the registered balance date"
                  description="Usually a changed balance date, or a return that used the wrong one. The right month with a different day is often a typo."
                  rows={lists.year_end_mismatch}
                  kind="year_end_mismatch"
                />
              )}
              {view === 'tier_over_limit' && (
                <FindingsGrid
                  key="tier_over_limit"
                  title="Charities that have outgrown their tier"
                  description="Filed under the same tier for three returns running while spending over its limit. Uses today's limits for every year."
                  rows={lists.tier_over_limit}
                  kind="tier_over_limit"
                />
              )}
            </>
          )}
        </main>
      </div>
    </FluentProvider>
  )
}

function Kpi({ icon, tone, label, value, foot }: { icon: ReactNode; tone?: 'danger' | 'warning'; label: string; value: string; foot: string }) {
  const s = useStyles()
  return (
    <Card className={s.kpi}>
      <div className={s.kpiHead}>
        <span className={`${s.icon} ${tone === 'danger' ? s.danger : tone === 'warning' ? s.warning : ''}`}>{icon}</span>
        <Body1>{label}</Body1>
      </div>
      <Text className={s.kpiValue}>{value}</Text>
      <Caption1 className={s.muted}>{foot}</Caption1>
    </Card>
  )
}

// ---- Overview: the charts ---------------------------------------------------------------------

const BUCKETS: Array<[string, number, number]> = [
  ['Up to 60 days', 0, 60],
  ['61 to 90 days', 61, 90],
  ['3 to 6 months', 91, 182],
  ['6 to 12 months', 183, 365],
  ['1 to 2 years', 366, 730],
  ['Over 2 years', 731, Infinity],
]

function Overview({
  rows,
  lists,
  charities,
  onView,
}: {
  rows: Row[]
  lists: Record<CheckName, Row[]>
  charities: ReturnType<typeof useCharities>
  onView: (v: View) => void
}) {
  const s = useStyles()
  const overdue = useMemo(() => rows.filter((r) => r.check === 'overdue'), [rows])
  const lateness = useMemo(
    () =>
      BUCKETS.map(([label, low, high]) => ({
        key: label,
        label,
        value: overdue.filter((r) => r.days >= low && r.days <= high).length,
        muted: high <= LATE_DAYS,
      })),
    [overdue],
  )
  const sectors = useMemo(() => {
    if (charities.status !== 'ready') return null
    const totals = new Map<string, number>()
    for (const p of charities.data.points) totals.set(p.sector, (totals.get(p.sector) ?? 0) + 1)
    return [...totals]
      .map(([sector, total]) => {
        const late = lists.overdue.filter((r) => r.sector === sector).length
        return { key: sector, label: sector, value: late / total, late, total }
      })
      .sort((a, b) => b.value - a.value)
  }, [charities, lists.overdue])
  const offMap = lists.overdue.filter((r) => r.sector === NOT_ON_MAP).length

  return (
    <div className={s.grid}>
      <ChartCard title="Overdue returns by how late" description="Due 6 months after the balance date. Grey: up to 60 days, often still being processed." onView={() => onView('overdue')}>
        <HBars
          rows={lateness}
          format={(v) => formatCount(v)}
          tick={(v) => formatCount(v)}
          tip={(r) => [`${r.label} late`, `${formatCount(r.value)} charities`]}
          label="Overdue returns by how late"
        />
      </ChartCard>
      <ChartCard
        title="Late returns by sector"
        description={`Share of each sector's charities on the map more than ${LATE_DAYS} days late. ${formatCount(offMap)} late charities aren't on the map and aren't counted.`}
        onView={() => onView('overdue')}
      >
        {sectors ? (
          <HBars
            rows={sectors}
            format={pct}
            tick={(v) => `${Math.round(v * 100)}%`}
            tip={(r) => {
              const x = sectors.find((q) => q.key === r.key)!
              return [r.label, `${formatCount(x.late)} of ${formatCount(x.total)} charities on the map`, `${pct(r.value)} more than ${LATE_DAYS} days late`]
            }}
            label="Share of charities more than 60 days late, by sector"
          />
        ) : (
          <div className={s.center}>
            {charities.status === 'error' ? <Caption1>Couldn't load the map's charities.</Caption1> : <Spinner size="small" />}
          </div>
        )}
      </ChartCard>
      <ChartCard
        title="Spending against the tier limit"
        description="Last three returns, as a multiple of each charity's tier limit. Two years over are allowed (Tier 2: one) before moving up."
        onView={() => onView('tier_over_limit')}
      >
        <div className={s.legend} aria-hidden="true">
          <Caption1 className={s.legendItem}><span className={s.dot} style={{ opacity: 0.3 }} />Earliest</Caption1>
          <Caption1 className={s.legendItem}><span className={s.dot} style={{ opacity: 0.6 }} />Middle</Caption1>
          <Caption1 className={s.legendItem}><span className={s.dot} />Latest year</Caption1>
          <Caption1 className={s.legendItem}><span className={s.dash} />Tier limit</Caption1>
        </div>
        <TierDots rows={lists.tier_over_limit} />
      </ChartCard>
    </div>
  )
}

function ChartCard({ title, description, onView, children }: { title: string; description: string; onView: () => void; children: ReactNode }) {
  const s = useStyles()
  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div className={s.cardTitle}>
          <Subtitle2 as="h2">{title}</Subtitle2>
          <Caption1 className={s.muted}>{description}</Caption1>
        </div>
        <Button appearance="subtle" onClick={onView}>
          View list
        </Button>
      </div>
      {children}
    </Card>
  )
}

const FONT = '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'
let measureContext: CanvasRenderingContext2D | null = null
function textWidth(text: string, size: number, weight = 400) {
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) return text.length * size * 0.55
  measureContext.font = `${weight} ${size}px ${FONT}`
  return measureContext.measureText(text).width
}
function clip(text: string, size: number, max: number) {
  if (textWidth(text, size) <= max) return text
  let t = text
  while (t.length > 4 && textWidth(`${t}…`, size) > max) t = t.slice(0, -1)
  return `${t}…`
}
function niceTicks(max: number, count: number) {
  const step0 = max / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(step0 || 1))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= step0) ?? mag * 10
  const top = Math.ceil(max / step) * step || step
  const ticks: number[] = []
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t)
  return { ticks, top }
}

interface Tip {
  x: number
  y: number
  lines: string[]
}
function useTip() {
  const [tip, setTip] = useState<Tip | null>(null)
  return { tip, setTip }
}
function TipBox({ tip, width }: { tip: Tip | null; width: number }) {
  const s = useStyles()
  if (!tip) return null
  return (
    <div className={s.tip} style={{ left: Math.max(0, Math.min(width - 220, tip.x + 14)), top: Math.max(0, tip.y - 56) }}>
      <div className={s.tipHead}>{tip.lines[0]}</div>
      {tip.lines.slice(1).map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  )
}

/** Horizontal bars in Fluent's chart style: a value axis along the bottom, values at the bar ends. */
function HBars<T extends { key: string; label: string; value: number; muted?: boolean }>({
  rows,
  format,
  tick,
  tip,
  label,
}: {
  rows: T[]
  format: (v: number) => string
  tick: (v: number) => string
  tip: (r: T) => string[]
  label: string
}) {
  const s = useStyles()
  const [ref, box] = useElementBox<HTMLDivElement>()
  const { tip: shown, setTip } = useTip()
  const width = Math.max(260, box.width)
  const rowH = 32, top = 4, axisH = 22
  const height = top + rows.length * rowH + axisH
  const labelW = Math.min(width * 0.4, Math.max(0, ...rows.map((r) => textWidth(r.label, 13))))
  const valueW = Math.max(0, ...rows.map((r) => textWidth(format(r.value), 12, 600)))
  const left = labelW + 12, right = valueW + 12
  const { ticks, top: maxValue } = niceTicks(Math.max(...rows.map((r) => r.value), 0) || 1, Math.max(2, Math.min(6, Math.floor((width - left - right) / 70))))
  const x = (v: number) => left + (v / maxValue) * Math.max(40, width - left - right)
  const bar = rowH * 0.6
  return (
    <div ref={ref} className={s.chart} onMouseLeave={() => setTip(null)}>
      {box.width > 0 && (
        <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ fontFamily: tokens.fontFamilyBase, display: 'block', overflow: 'visible' }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={top} y2={top + rows.length * rowH} style={{ stroke: tokens.colorNeutralStroke2 }} />
              <text x={x(t)} y={height - 6} textAnchor="middle" fontSize={12} style={{ fill: tokens.colorNeutralForeground3 }}>
                {tick(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const y = top + i * rowH + (rowH - bar) / 2
            return (
              <g key={r.key}>
                <text x={left - 12} y={y + bar / 2} dy="0.35em" textAnchor="end" fontSize={13} style={{ fill: tokens.colorNeutralForeground2 }}>
                  {clip(r.label, 13, labelW)}
                </text>
                <rect x={left} y={y} width={Math.max(2, x(r.value) - left)} height={bar} rx={2}
                  style={{ fill: r.muted ? tokens.colorNeutralStroke1Pressed : tokens.colorBrandForeground1 }} />
                <text x={Math.max(left, x(r.value)) + 6} y={y + bar / 2} dy="0.35em" fontSize={12} fontWeight={600}
                  style={{ fill: tokens.colorNeutralForeground1, fontVariantNumeric: 'tabular-nums' }}>
                  {format(r.value)}
                </text>
                <rect x={0} y={top + i * rowH} width={width} height={rowH} style={{ fill: 'transparent' }}
                  onMouseMove={(e) => {
                    const b = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                    setTip({ x: e.clientX - b.left, y: e.clientY - b.top, lines: tip(r) })
                  }} />
              </g>
            )
          })}
        </svg>
      )}
      <TipBox tip={shown} width={width} />
    </div>
  )
}

/** Each charity's last three years of spending as a multiple of its tier limit. */
function TierDots({ rows }: { rows: Row[] }) {
  const s = useStyles()
  const [ref, box] = useElementBox<HTMLDivElement>()
  const { tip: shown, setTip } = useTip()
  const items = useMemo(
    () =>
      rows
        .map((r) => {
          const limit = r.limit ?? 1
          const pts = r.spent.map((spent, i) => ({ spent, year: r.years[i] ?? '', ratio: spent / limit, i }))
          return { ...r, pts, max: Math.max(...pts.map((p) => p.ratio), 0) }
        })
        .sort((a, b) => b.max - a.max),
    [rows],
  )
  const width = Math.max(280, box.width)
  const rowH = 28, top = 4, axisH = 22
  const height = top + items.length * rowH + axisH
  const labelW = Math.min(width * 0.42, Math.max(0, ...items.map((r) => textWidth(r.name, 13))))
  const tagW = 30
  const left = labelW + tagW + 16, right = 16
  const xMax = Math.max(2, Math.ceil(Math.max(...items.map((r) => r.max), 2) * 1.05 * 2) / 2)
  const x = (v: number) => left + (v / xMax) * (width - left - right)
  const { ticks } = niceTicks(xMax, Math.max(2, Math.min(8, Math.floor((width - left) / 70))))
  const opacity = [0.3, 0.6, 1]
  return (
    <div ref={ref} className={s.chart} onMouseLeave={() => setTip(null)}>
      {box.width > 0 && (
        <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Spending as a multiple of the tier limit, last three returns"
          style={{ fontFamily: tokens.fontFamilyBase, display: 'block', overflow: 'visible' }}>
          {ticks.filter((t) => t <= xMax).map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={top} y2={top + items.length * rowH} style={{ stroke: tokens.colorNeutralStroke2 }} />
              <text x={x(t)} y={height - 6} textAnchor="middle" fontSize={12} style={{ fill: tokens.colorNeutralForeground3 }}>
                {t === 0 ? '0' : `${t}×`}
              </text>
            </g>
          ))}
          <line x1={x(1)} x2={x(1)} y1={top} y2={top + items.length * rowH} strokeDasharray="4 3" strokeWidth={1.5}
            style={{ stroke: tokens.colorNeutralForeground3 }} />
          {items.map((r, i) => {
            const cy = top + i * rowH + rowH / 2
            const lo = Math.min(...r.pts.map((p) => p.ratio))
            return (
              <g key={r.id}>
                <text x={left - tagW - 12} y={cy} dy="0.35em" textAnchor="end" fontSize={13} style={{ fill: tokens.colorNeutralForeground2 }}>
                  {clip(r.name, 13, labelW)}
                </text>
                <rect x={left - tagW - 4} y={cy - 9} width={tagW - 4} height={18} rx={4}
                  style={{ fill: tokens.colorBrandBackground2, stroke: tokens.colorBrandStroke2 }} />
                <text x={left - tagW / 2 - 6} y={cy} dy="0.35em" textAnchor="middle" fontSize={11} fontWeight={600} style={{ fill: tokens.colorBrandForeground1 }}>
                  T{r.tier}
                </text>
                <line x1={x(lo)} x2={x(r.max)} y1={cy} y2={cy} strokeWidth={2} strokeLinecap="round" style={{ stroke: tokens.colorNeutralStroke1 }} />
                {r.pts.map((p) => (
                  <circle key={p.i} cx={x(p.ratio)} cy={cy} r={5.5}
                    style={{ fill: tokens.colorBrandForeground1, fillOpacity: opacity[p.i] ?? 1, stroke: tokens.colorBrandForeground1 }} />
                ))}
                <rect x={0} y={top + i * rowH} width={width} height={rowH} style={{ fill: 'transparent' }}
                  onMouseMove={(e) => {
                    const b = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                    setTip({
                      x: e.clientX - b.left,
                      y: e.clientY - b.top,
                      lines: [`${r.name} · Tier ${r.tier}`, `Limit ${money(r.limit ?? 0)}`, ...r.pts.map((p) => `${p.year}: ${money(p.spent)} (${p.ratio.toFixed(1)}× limit)`)],
                    })
                  }} />
              </g>
            )
          })}
        </svg>
      )}
      <TipBox tip={shown} width={width} />
    </div>
  )
}

// ---- Data grids -------------------------------------------------------------------------------

function charityCell(r: Row) {
  return (
    <TableCellLayout truncate>
      <Link href={registerUrl(r.cc)} target="_blank" rel="noopener noreferrer">
        {r.name} <Open16Regular style={{ verticalAlign: 'text-bottom' }} />
      </Link>
    </TableCellLayout>
  )
}

function columnsFor(kind: CheckName, narrow: boolean): TableColumnDefinition<Row>[] {
  const text = (id: string, header: string, get: (r: Row) => string | null) =>
    createTableColumn<Row>({
      columnId: id,
      compare: (a, b) => (get(a) ?? '').localeCompare(get(b) ?? ''),
      renderHeaderCell: () => header,
      renderCell: (r) => <TableCellLayout truncate>{get(r) ?? '—'}</TableCellLayout>,
    })
  const date = (id: string, header: string, get: (r: Row) => string | null) =>
    createTableColumn<Row>({
      columnId: id,
      compare: (a, b) => (get(a) ?? '').localeCompare(get(b) ?? ''),
      renderHeaderCell: () => header,
      renderCell: (r) => showDate(get(r)),
    })
  const name = createTableColumn<Row>({
    columnId: 'name',
    compare: (a, b) => a.name.localeCompare(b.name),
    renderHeaderCell: () => 'Charity',
    renderCell: charityCell,
  })
  const cc = text('cc', 'CC number', (r) => r.cc)
  const sector = text('sector', 'Sector', (r) => r.sector)
  if (kind === 'overdue') {
    const days = createTableColumn<Row>({
      columnId: 'days',
      compare: (a, b) => a.days - b.days,
      renderHeaderCell: () => 'Days late',
      renderCell: (r) => (
        <Badge appearance="tint" shape="rounded" color={r.days > 365 ? 'danger' : r.days > 182 ? 'warning' : 'subtle'}>
          {formatCount(r.days)}
        </Badge>
      ),
    })
    return narrow
      ? [name, date('yearEnded', 'Year ended', (r) => r.yearEnded), days]
      : [name, cc, sector, date('yearEnded', 'Year ended', (r) => r.yearEnded), date('due', 'Due', (r) => r.due), days]
  }
  if (kind === 'year_end_mismatch') {
    const registered = text('registered', 'Registered balance date', (r) => r.registered)
    const returnEnd = date('returnYearEnded', "Return's year end", (r) => r.returnYearEnded)
    return narrow ? [name, registered, returnEnd] : [name, cc, sector, registered, returnEnd]
  }
  const tier = createTableColumn<Row>({
    columnId: 'tier',
    compare: (a, b) => (a.tier ?? 0) - (b.tier ?? 0),
    renderHeaderCell: () => 'Tier',
    renderCell: (r) => (
      <Badge appearance="tint" shape="rounded" color="brand">
        Tier {r.tier}
      </Badge>
    ),
  })
  const spent = createTableColumn<Row>({
    columnId: 'spent',
    compare: (a, b) => (a.spent.at(-1) ?? 0) - (b.spent.at(-1) ?? 0),
    renderHeaderCell: () => 'Spent, latest year',
    renderCell: (r) => `${money(r.spent.at(-1) ?? 0)} (${r.years.at(-1) ?? ''})`,
  })
  const limit = createTableColumn<Row>({
    columnId: 'limit',
    compare: (a, b) => (a.limit ?? 0) - (b.limit ?? 0),
    renderHeaderCell: () => 'Tier limit',
    renderCell: (r) => money(r.limit ?? 0),
  })
  return narrow ? [name, tier, spent] : [name, cc, tier, spent, limit]
}

const DEFAULT_SORT: Record<CheckName, Sort> = {
  overdue: { sortColumn: 'days', sortDirection: 'descending' },
  year_end_mismatch: { sortColumn: 'name', sortDirection: 'ascending' },
  tier_over_limit: { sortColumn: 'spent', sortDirection: 'descending' },
}

function FindingsGrid({ title, description, rows, kind }: { title: string; description: string; rows: Row[]; kind: CheckName }) {
  const s = useStyles()
  const narrow = useMediaQuery('(max-width: 640px)')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT[kind])
  const [shown, setShown] = useState(PAGE)
  const columns = useMemo(() => columnsFor(kind, narrow), [kind, narrow])

  const filtered = useMemo(() => {
    const q = fold(query.trim())
    const hit = q ? rows.filter((r) => [r.name, r.cc, r.sector].some((v) => fold(v).includes(q))) : rows
    const col = columns.find((c) => c.columnId === sort.sortColumn)
    if (!col) return hit
    const sign = sort.sortDirection === 'ascending' ? 1 : -1
    return hit.slice().sort((a, b) => col.compare(a, b) * sign)
  }, [rows, query, sort, columns])
  const page = filtered.slice(0, shown)

  return (
    <Card className={s.card}>
      <div className={s.cardTitle}>
        <Subtitle2 as="h2">{title}</Subtitle2>
        <Caption1 className={s.muted}>{description}</Caption1>
      </div>
      <div className={s.toolbar}>
        <SearchBox
          className={s.search}
          placeholder="Search name, CC number or sector"
          aria-label={`Search: ${title}`}
          value={query}
          onChange={(_, d) => {
            setQuery(d.value)
            setShown(PAGE)
          }}
        />
        <Caption1 className={s.muted} aria-live="polite">
          {filtered.length === rows.length ? `${formatCount(rows.length)} rows` : `${formatCount(filtered.length)} of ${formatCount(rows.length)} rows`}
        </Caption1>
      </div>
      <div className={s.gridBox}>
        <DataGrid
          items={page}
          columns={columns}
          sortable
          sortState={sort}
          onSortChange={(_, next) => setSort(next as Sort)}
          getRowId={(r: Row) => r.id}
          focusMode="composite"
          resizableColumns={!narrow}
          columnSizingOptions={{
            name: { defaultWidth: 340, minWidth: 180, idealWidth: 340 },
            cc: { defaultWidth: 110, minWidth: 90 },
            sector: { defaultWidth: 220, minWidth: 120 },
          }}
        >
          <DataGridHeader>
            <DataGridRow>{({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}</DataGridRow>
          </DataGridHeader>
          <DataGridBody<Row>>
            {({ item, rowId }) => (
              <DataGridRow<Row> key={rowId}>{({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}</DataGridRow>
            )}
          </DataGridBody>
        </DataGrid>
      </div>
      {filtered.length > shown && (
        <Button className={s.more} onClick={() => setShown((n) => n + PAGE)}>
          Load {formatCount(Math.min(PAGE, filtered.length - shown))} more
        </Button>
      )}
    </Card>
  )
}
