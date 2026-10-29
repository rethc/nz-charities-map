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
  mergeClasses,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  SearchBox,
  Spinner,
  Subtitle2,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TabList,
  Title3,
  tokens,
  type TableColumnDefinition,
  type TableColumnId,
} from '@fluentui/react-components'
import {
  ArrowSync20Regular,
  ClipboardTaskListLtr20Regular,
  DataTrending20Regular,
  DocumentSearch20Regular,
  Open16Regular,
} from '@fluentui/react-icons'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { RequireAdmin } from '../../components/RequireAdmin'
import { useCharities } from '../../hooks/useCharities'
import { useElementBox } from '../../hooks/useElementBox'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { registerUrl } from '../../lib/charities'
import type { ReturnCheckFinding, ReturnChecks } from '../../lib/database.types'
import { formatCount } from '../../lib/dom'
import { fold } from '../../lib/search'
import { supabase } from '../../lib/supabase'
import { AdminBar, Kpi, theme } from './AdminFrame'
import { StatementsView } from './StatementsView'

/**
 * Annual return checks (scripts/return_checks.py), for admins only, in Microsoft's Fluent UI:
 * the same look as the site's other reports. Automated findings from the register's public
 * data: a lead to check on the register, never a verdict.
 */

type CheckName = ReturnCheckFinding['check']
type Group = 'acceptance' | 'register' | 'indicators'
type View = 'overview' | Group | 'statements'
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
  summary: string
  /** The finding's key figure: a number to sort by, and how it's shown. */
  value: number | null
  shown: string | null
  due: string | null
  days: number
  registered: string | null
  returnYearEnded: string | null
  tier: number | null
  limit: number | null
  /** Each year's tier limit, beside `spent` and `years`. */
  limits: number[]
  /** A2: `stayed` (over the limit too long) or `moved_down`, and the tier it moved down from. */
  reason: string | null
  fromTier: number | null
  spent: number[]
  years: string[]
}

/** One of the ten checks, numbered as in the handoff's catalogue: A acceptance, B register, I indicators. */
interface CheckInfo {
  name: CheckName
  code: string
  group: Group
  title: string
  /** What in the return it reads. */
  reads: string
  /** Heading of the key figure's column. */
  figure: string
  description: string
  sort: Sort
}

/** Overdue returns this late or more are listed: earlier ones are often still being processed. */
const LATE_DAYS = 60
const byValue = (direction: Sort['sortDirection']): Sort => ({ sortColumn: 'value', sortDirection: direction })

const CHECKS: CheckInfo[] = [
  {
    name: 'year_end_mismatch', code: 'A1', group: 'acceptance', title: 'Correct reporting year', reads: 'Balance date, year end',
    figure: '', sort: { sortColumn: 'name', sortDirection: 'ascending' },
    description: "The latest return should end on the registered balance date. Usually a changed balance date, or a return that used the wrong one. The right month with a different day is often a typo.",
  },
  {
    name: 'tier_over_limit', code: 'A2', group: 'acceptance', title: 'Correct reporting standard', reads: 'Tier, expenses or payments',
    figure: 'Against limit', sort: byValue('descending'),
    description: "The XRB tier must suit the charity's size: over its limit for longer than the rules allow (two years; Tier 2, one), or moved down to a tier it's too big for. Each year is judged by the limits of its time: Tier 2 and 3 limits rose for years ending from 31 March 2024.",
  },
  {
    name: 'overdue', code: 'B1', group: 'register', title: 'Filed on time', reads: 'Filing history, due dates',
    figure: 'Days late', sort: { sortColumn: 'days', sortDirection: 'descending' },
    description: `Returns more than ${LATE_DAYS} days late. Extensions aren't in the public data, and some charities file through a group the data doesn't record.`,
  },
  {
    name: 'missing_year', code: 'B2', group: 'register', title: 'No missing years', reads: 'Filing history',
    figure: 'Missing', sort: byValue('descending'),
    description: "A year with no return between two that were filed. The charity may have filed as part of a group that year, or had its return withheld: neither shows in the public data.",
  },
  {
    name: 'prior_year_mismatch', code: 'B3', group: 'register', title: "Last year's figures match", reads: 'Tier 4 comparatives',
    figure: 'Difference', sort: byValue('descending'),
    description: "A Tier 4 return repeats last year's income and payments beside this year's. These differ from what the charity reported last year by more than 5% and $1,000. Correcting last year's figures is a fair reason.",
  },
  {
    name: 'negative_net_assets', code: 'I1', group: 'indicators', title: 'Liabilities exceed assets', reads: 'Assets, liabilities',
    figure: 'Net assets', sort: byValue('ascending'),
    description: 'Owes more than it owns, by $10,000 or more and at least a tenth of its income: a sign of financial strain.',
  },
  {
    name: 'deficits', code: 'I2', group: 'indicators', title: 'Deficits three years running', reads: 'Income, expenses',
    figure: 'Deficit, 3 years', sort: byValue('ascending'),
    description: 'Spent more than it took in for three years running, each year by a fifth of its income or more, and $50,000 or more in all.',
  },
  {
    name: 'big_swing', code: 'I3', group: 'indicators', title: 'Big change from last year', reads: 'Income, expenses',
    figure: 'Change', sort: byValue('descending'),
    description: 'Income or spending tripled, or fell to a third, by $500,000 or more. Often a one-off grant, bequest or project: check the return explains it.',
  },
  {
    name: 'staff_pay_no_staff', code: 'I4', group: 'indicators', title: 'Staff pay but no staff', reads: 'Salaries, employees, paid hours',
    figure: 'Staff pay', sort: byValue('descending'),
    description: '$50,000 or more of staff pay, with no employees and no paid hours reported. One of the figures is likely wrong.',
  },
  {
    name: 'repeated_figures', code: 'I5', group: 'indicators', title: 'Same figures as last year', reads: 'Income, expenses',
    figure: 'Income / spending', sort: byValue('descending'),
    description: "Income and spending the same as the year before, to the dollar: often last year's return copied forward.",
  },
]
const CHECK = Object.fromEntries(CHECKS.map((c) => [c.name, c])) as Record<CheckName, CheckInfo>
const GROUPS: Record<Group, { tab: string; title: string; foot: string; icon: ReactNode; tone?: 'danger' | 'warning'; first: CheckName }> = {
  acceptance: { tab: 'Acceptance', title: 'Acceptance checks', foot: 'A1–A2: reporting year and tier', icon: <ClipboardTaskListLtr20Regular />, tone: 'warning', first: 'year_end_mismatch' },
  register: { tab: 'Register', title: 'Register cross-checks', foot: "B1–B3: filing history, last year's figures", icon: <DocumentSearch20Regular />, tone: 'danger', first: 'overdue' },
  indicators: { tab: 'Indicators', title: 'Standard indicators', foot: 'I1–I5: from the figures declared', icon: <DataTrending20Regular />, first: 'negative_net_assets' },
}
const GROUP_NAMES = Object.keys(GROUPS) as Group[]
const PAGE = 100
/** The theme's burnt orange: the second colour in a chart, beside the brand blue. */
const WARM = '#ad5400'
/** Charities shown in the overview's tier chart: the full list is under A2. */
const TIER_TOP = 12
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

/** Chart text: labels, and the numbers along an axis. */
const LABEL = 14
const TICK = 13

const useStyles = makeStyles({
  root: { height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: tokens.colorNeutralBackground3 },
  scroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
  page: { maxWidth: '1760px', margin: '0 auto', padding: '16px clamp(16px, 3vw, 32px) 40px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px' },
  head: { display: 'grid', gap: '6px' },
  titleRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' },
  lead: { color: tokens.colorNeutralForeground2, maxWidth: '92ch' },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))', gap: '16px' },
  muted: { color: tokens.colorNeutralForeground3 },
  tabs: { flexWrap: 'wrap', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  wide: { gridColumn: '1 / -1' },
  overview: { display: 'grid', gap: '16px', minWidth: 0 },
  column: { display: 'grid', gap: '16px', alignContent: 'start', minWidth: 0 },
  subTabs: { flexWrap: 'wrap', rowGap: '4px' },
  codeCol: { width: '72px' },
  countCol: { width: '96px', textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 30rem), 1fr))', alignItems: 'start', gap: '16px' },
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
  swatch: { width: '12px', height: '12px', borderRadius: '2px', backgroundColor: tokens.colorBrandForeground1 },
  swatchWarm: { backgroundColor: WARM },
  dash: { width: '14px', height: 0, borderTop: `2px dashed ${tokens.colorNeutralForeground3}` },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px 12px' },
  search: { width: 'min(100%, 22rem)' },
  // The list scrolls in its own box, as Dynamics 365's grid does, so its column headings stay in view.
  gridBox: {
    overflow: 'auto',
    maxHeight: 'min(72vh, 60rem)',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  gridHead: { position: 'sticky', top: 0, zIndex: 2, backgroundColor: tokens.colorNeutralBackground1, boxShadow: `0 1px 0 ${tokens.colorNeutralStroke2}` },
  gridEnd: { height: '1px' },
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
        summary: f.summary,
        value: typeof d.value === 'number' ? d.value : null,
        shown: typeof d.shown === 'string' ? d.shown : null,
        due: typeof d.due === 'string' ? d.due : null,
        days: num(d.days_overdue),
        registered: typeof d.registered_balance_date === 'string' ? d.registered_balance_date : null,
        returnYearEnded: typeof d.return_year_ended === 'string' ? d.return_year_ended : null,
        tier: d.tier === undefined ? null : num(d.tier),
        limit: d.limit === undefined ? null : num(d.limit),
        limits: Array.isArray(d.limits) ? d.limits.map(num) : [],
        reason: typeof d.reason === 'string' ? d.reason : null,
        fromTier: d.from_tier === undefined ? null : num(d.from_tier),
        spent: Array.isArray(d.spent) ? d.spent.map(num) : [],
        years: Array.isArray(d.years) ? d.years.map((y) => String(y ?? '').slice(0, 4)) : [],
      }
    })
  }, [load, byCc])

  const lists = useMemo(() => {
    const out = Object.fromEntries(CHECKS.map((c) => [c.name, [] as Row[]])) as Record<CheckName, Row[]>
    for (const r of rows) if (r.check !== 'overdue' || r.days > LATE_DAYS) out[r.check]?.push(r)
    return out
  }, [rows])
  const groupCount = (g: Group) => CHECKS.filter((c) => c.group === g).reduce((n, c) => n + lists[c.name].length, 0)
  const flagged = useMemo(() => new Set(CHECKS.flatMap((c) => lists[c.name].map((r) => r.cc))).size, [lists])
  const [picked, setPicked] = useState<Record<Group, CheckName>>(() => ({
    acceptance: GROUPS.acceptance.first,
    register: GROUPS.register.first,
    indicators: GROUPS.indicators.first,
  }))
  const show = (check: CheckName) => {
    const group = CHECK[check].group
    setPicked((p) => ({ ...p, [group]: check }))
    setView(group)
  }
  const checkedAt = load.status === 'ready' && load.data.checked_at ? new Date(load.data.checked_at) : null

  return (
    <FluentProvider theme={theme} className={s.root}>
      <AdminBar email={email} current="/admin/returns" />

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
              <Badge appearance="tint" color="brand" size="large">
                Public data, post-publication
              </Badge>
            </div>
            {load.status === 'ready' && (
              <Body1 className={s.lead}>
                {formatCount(flagged)} charities have at least one finding from the ten checks that need nothing but the
                register's public data: two acceptance checks, three register cross-checks and five standard indicators.
                The checks that read the financial statements are on the Statements tab.
              </Body1>
            )}
          </div>

          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Public data, after publication: review only.</MessageBarTitle>
              These are automated checks of the Charities Register's public data, and some are wrong.
            </MessageBarBody>
          </MessageBar>

          {load.status === 'loading' && (
            <div className={s.center}>
              <Spinner label="Loading the checks…" />
            </div>
          )}
          {load.status === 'error' && (
            <MessageBar intent="error" layout="multiline">
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
                {GROUP_NAMES.map((g) => (
                  <Kpi key={g} icon={GROUPS[g].icon} tone={GROUPS[g].tone} label={GROUPS[g].title}
                    value={formatCount(groupCount(g))} foot={GROUPS[g].foot} />
                ))}
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
                {GROUP_NAMES.map((g) => (
                  <Tab key={g} value={g}>
                    {GROUPS[g].tab} <Badge appearance="tint" color="informative" shape="circular" size="small">{formatCount(groupCount(g))}</Badge>
                  </Tab>
                ))}
                <Tab value="statements">Statements</Tab>
              </TabList>

              {view === 'overview' ? (
                <Overview rows={rows} lists={lists} charities={charities} onView={show} />
              ) : view === 'statements' ? (
                <StatementsView />
              ) : (
                <GroupView group={view} lists={lists} check={picked[view]} onCheck={show} />
              )}
            </>
          )}
        </main>
      </div>
    </FluentProvider>
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
  onView: (check: CheckName) => void
}) {
  const s = useStyles()
  const overdue = useMemo(() => rows.filter((r) => r.check === 'overdue'), [rows])
  const lateness = useMemo(
    () =>
      BUCKETS.map(([label, low, high]) => ({
        key: label,
        label,
        value: overdue.filter((r) => r.days >= low && r.days <= high).length,
        color: high <= LATE_DAYS ? WARM : undefined,
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
  const tierBars = useMemo(
    () =>
      lists.tier_over_limit
        .filter((r) => r.value !== null)
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
        .slice(0, TIER_TOP)
        .map((r) => {
          const moved = r.reason === 'moved_down'
          const spent = r.spent.at(-1) ?? 0
          return {
            key: r.id,
            label: r.name,
            value: r.value ?? 0,
            color: moved ? WARM : undefined,
            tip: [
              r.name,
              moved ? `Moved down from Tier ${r.fromTier} to Tier ${r.tier}` : `Tier ${r.tier}, over its limit too many years running`,
              `Latest year: ${money(spent)}, ${(r.value ?? 0).toFixed(1)}× the ${money(r.limit ?? 0)} limit`,
            ],
          }
        }),
    [lists.tier_over_limit],
  )

  return (
    <div className={s.overview}>
      <Catalogue lists={lists} onView={onView} />
      <div className={s.grid}>
        <div className={s.column}>
          <ChartCard title="Overdue returns by how late" description="Due 6 months after the balance date. Orange: up to 60 days." onView={() => onView('overdue')}>
            <HBars
              rows={lateness}
              format={(v) => formatCount(v)}
              tick={(v) => formatCount(v)}
              tip={(r) => [`${r.label} late`, `${formatCount(r.value)} charities`]}
              label="Overdue returns by how late"
            />
          </ChartCard>
          <ChartCard
            title="Spending against the tier limit"
            description={`How many times over its tier's limit each charity spent in its latest return. The ${formatCount(tierBars.length)} furthest over, of ${formatCount(lists.tier_over_limit.length)}.`}
            onView={() => onView('tier_over_limit')}
          >
            <div className={s.legend} aria-hidden="true">
              <Caption1 className={s.legendItem}><span className={s.swatch} />Stayed in its tier too long</Caption1>
              <Caption1 className={s.legendItem}><span className={mergeClasses(s.swatch, s.swatchWarm)} />Moved down a tier it's too big for</Caption1>
              <Caption1 className={s.legendItem}><span className={s.dash} />The limit</Caption1>
            </div>
            <HBars
              rows={tierBars}
              format={(v) => `${v.toFixed(1)}×`}
              tick={(v) => `${v}×`}
              mark={{ value: 1, label: 'Limit' }}
              tip={(r) => r.tip}
              label="How many times over its tier's limit each charity spent in its latest year"
            />
          </ChartCard>
        </div>
        <ChartCard
          title="Late returns by sector"
          description={`Share of each sector's charities on the map more than ${LATE_DAYS} days late.`}
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
      </div>
    </div>
  )
}

function Catalogue({ lists, onView }: { lists: Record<CheckName, Row[]>; onView: (check: CheckName) => void }) {
  const s = useStyles()
  const narrow = useMediaQuery('(max-width: 640px)')
  return (
    <Card className={mergeClasses(s.card, s.wide)}>
      <div className={s.cardTitle}>
        <Subtitle2 as="h2">The ten checks</Subtitle2>
        <Body1 className={s.muted}>
          Each reads only the register's public data feed. The checks that read the financial statements are on the
          Statements tab.
        </Body1>
      </div>
      <div className={s.gridBox}>
        <Table size="small" aria-label="The ten checks">
          <TableHeader>
            <TableRow>
              <TableHeaderCell className={s.codeCol}>No.</TableHeaderCell>
              <TableHeaderCell>Check</TableHeaderCell>
              {!narrow && <TableHeaderCell>Group</TableHeaderCell>}
              {!narrow && <TableHeaderCell>Reads</TableHeaderCell>}
              <TableHeaderCell className={s.countCol}>Flagged</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {CHECKS.map((c) => (
              <TableRow key={c.name}>
                <TableCell className={s.codeCol}>
                  <Badge appearance="tint" color="brand" shape="rounded">
                    {c.code}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Link onClick={() => onView(c.name)}>{c.title}</Link>
                </TableCell>
                {!narrow && <TableCell>{GROUPS[c.group].title}</TableCell>}
                {!narrow && <TableCell>{c.reads}</TableCell>}
                <TableCell className={s.countCol}>{formatCount(lists[c.name].length)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function GroupView({ group, lists, check, onCheck }: {
  group: Group
  lists: Record<CheckName, Row[]>
  check: CheckName
  onCheck: (check: CheckName) => void
}) {
  const s = useStyles()
  return (
    <>
      <TabList
        appearance="subtle-circular"
        className={s.subTabs}
        selectedValue={check}
        onTabSelect={(_, d) => onCheck(d.value as CheckName)}
        aria-label={GROUPS[group].title}
      >
        {CHECKS.filter((c) => c.group === group).map((c) => (
          <Tab key={c.name} value={c.name}>
            {c.code} {c.title} <Badge appearance="tint" color="informative" shape="circular" size="small">{formatCount(lists[c.name].length)}</Badge>
          </Tab>
        ))}
      </TabList>
      <FindingsGrid key={check} info={CHECK[check]} rows={lists[check]} />
    </>
  )
}

function ChartCard({ title, description, onView, children }: { title: string; description: string; onView: () => void; children: ReactNode }) {
  const s = useStyles()
  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div className={s.cardTitle}>
          <Subtitle2 as="h2">{title}</Subtitle2>
          <Body1 className={s.muted}>{description}</Body1>
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
function HBars<T extends { key: string; label: string; value: number; color?: string }>({
  rows,
  format,
  tick,
  tip,
  label,
  mark,
}: {
  rows: T[]
  format: (v: number) => string
  tick: (v: number) => string
  tip: (r: T) => string[]
  label: string
  /** A value to mark with a dashed line across the bars, such as a limit. */
  mark?: { value: number; label: string }
}) {
  const s = useStyles()
  const [ref, box] = useElementBox<HTMLDivElement>()
  const { tip: shown, setTip } = useTip()
  const width = Math.max(260, box.width)
  const rowH = 34, top = mark ? 22 : 4, axisH = 22
  const height = top + rows.length * rowH + axisH
  const labelW = Math.min(width * 0.4, Math.max(0, ...rows.map((r) => textWidth(r.label, LABEL))))
  const valueW = Math.max(0, ...rows.map((r) => textWidth(format(r.value), TICK, 600)))
  const left = labelW + 12, right = valueW + 12
  const { ticks, top: maxValue } = niceTicks(Math.max(...rows.map((r) => r.value), mark?.value ?? 0, 0) || 1, Math.max(2, Math.min(6, Math.floor((width - left - right) / 70))))
  const x = (v: number) => left + (v / maxValue) * Math.max(40, width - left - right)
  const bar = rowH * 0.6
  return (
    <div ref={ref} className={s.chart} onMouseLeave={() => setTip(null)}>
      {box.width > 0 && (
        <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ fontFamily: tokens.fontFamilyBase, display: 'block', overflow: 'visible' }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={top} y2={top + rows.length * rowH} style={{ stroke: tokens.colorNeutralStroke2 }} />
              <text x={x(t)} y={height - 6} textAnchor="middle" fontSize={TICK} style={{ fill: tokens.colorNeutralForeground3 }}>
                {tick(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const y = top + i * rowH + (rowH - bar) / 2
            return (
              <g key={r.key}>
                <text x={left - 12} y={y + bar / 2} dy="0.35em" textAnchor="end" fontSize={LABEL} style={{ fill: tokens.colorNeutralForeground2 }}>
                  {clip(r.label, LABEL, labelW)}
                </text>
                <rect x={left} y={y} width={Math.max(2, x(r.value) - left)} height={bar} rx={2}
                  style={{ fill: r.color ?? tokens.colorBrandForeground1 }} />
                <text x={Math.max(left, x(r.value)) + 6} y={y + bar / 2} dy="0.35em" fontSize={TICK} fontWeight={600}
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
          {mark && (
            <g aria-hidden="true">
              <line x1={x(mark.value)} x2={x(mark.value)} y1={top - 4} y2={top + rows.length * rowH} strokeDasharray="4 3" strokeWidth={1.5}
                style={{ stroke: tokens.colorNeutralForeground1 }} />
              <text x={x(mark.value)} y={top - 9} textAnchor="middle" fontSize={TICK} fontWeight={600} style={{ fill: tokens.colorNeutralForeground1 }}>
                {mark.label}
              </text>
            </g>
          )}
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
  const figure = createTableColumn<Row>({
    columnId: 'value',
    compare: (a, b) => (a.value ?? 0) - (b.value ?? 0),
    renderHeaderCell: () => CHECK[kind].figure,
    // Two figures ("income / spending") sit one above the other, so neither runs into the next column.
    renderCell: (r) => (
      <span style={{ display: 'grid', padding: '8px 0', fontVariantNumeric: 'tabular-nums' }}>
        {(r.shown ?? '—').split(' / ').map((part) => (
          <span key={part}>{part}</span>
        ))}
      </span>
    ),
  })
  const finding = createTableColumn<Row>({
    columnId: 'summary',
    compare: (a, b) => a.summary.localeCompare(b.summary),
    renderHeaderCell: () => 'What the check found',
    renderCell: (r) => <span style={{ display: 'block', whiteSpace: 'normal', padding: '8px 0' }}>{r.summary}</span>,
  })
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
  if (kind !== 'tier_over_limit') {
    return narrow ? [name, figure] : [name, cc, figure, finding]
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
  return narrow ? [name, tier, figure] : [name, cc, tier, figure, finding]
}

/**
 * Column widths. Names, sectors and findings share the spare room (grow), so the grid fills any
 * width; figures, dates and badges keep the room their content needs. `min` is in px.
 */
const COLUMN: Record<string, { grow: number; min: number }> = {
  name: { grow: 3, min: 160 },
  sector: { grow: 1.4, min: 140 },
  registered: { grow: 1.4, min: 160 },
  summary: { grow: 5, min: 300 },
  cc: { grow: 0, min: 112 },
  tier: { grow: 0, min: 100 },
  value: { grow: 0, min: 150 },
  yearEnded: { grow: 0, min: 136 },
  due: { grow: 0, min: 136 },
  returnYearEnded: { grow: 0, min: 150 },
  days: { grow: 0, min: 112 },
}
const CELL_PADDING = 16
function columnStyle(id: TableColumnId): CSSProperties {
  const { grow, min } = COLUMN[String(id)] ?? { grow: 1, min: 120 }
  return { flex: grow ? `${grow} 1 0` : `0 0 ${min + CELL_PADDING}px`, minWidth: min + CELL_PADDING }
}

function FindingsGrid({ info, rows }: { info: CheckInfo; rows: Row[] }) {
  const s = useStyles()
  const narrow = useMediaQuery('(max-width: 640px)')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>(info.sort)
  const kind = info.name
  const title = `${info.code} · ${info.title}`
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
  const more = filtered.length > shown

  // Continuous scroll, as in Dynamics 365's grid: the next rows load as the end of the list comes
  // into view. Set up again after each load, so a tall box keeps filling until it can scroll.
  const boxRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const total = filtered.length
  useEffect(() => {
    const end = endRef.current
    if (shown >= total || !end) return
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown((n) => n + PAGE), {
      root: boxRef.current,
      rootMargin: '0px 0px 400px 0px',
    })
    observer.observe(end)
    return () => observer.disconnect()
  }, [shown, total])
  const restart = () => {
    setShown(PAGE)
    boxRef.current?.scrollTo({ top: 0 })
  }

  return (
    <Card className={s.card}>
      <div className={s.cardTitle}>
        <Subtitle2 as="h2">{title}</Subtitle2>
        <Body1 className={s.muted}>{info.description}</Body1>
      </div>
      <div className={s.toolbar}>
        <SearchBox
          className={s.search}
          placeholder="Search name, CC number or sector"
          aria-label={`Search: ${title}`}
          value={query}
          onChange={(_, d) => {
            setQuery(d.value)
            restart()
          }}
        />
        <Body1 className={s.muted} aria-live="polite">
          {filtered.length === rows.length ? `${formatCount(rows.length)} rows` : `${formatCount(filtered.length)} of ${formatCount(rows.length)} rows`}
        </Body1>
      </div>
      <div ref={boxRef} className={s.gridBox}>
        <DataGrid
          items={page}
          columns={columns}
          sortable
          sortState={sort}
          onSortChange={(_, next) => {
            setSort(next as Sort)
            restart()
          }}
          getRowId={(r: Row) => r.id}
          focusMode="composite"
          // Below the columns' least widths the list scrolls sideways in its box, not the page.
          style={{ minWidth: columns.reduce((sum, c) => sum + Number(columnStyle(c.columnId).minWidth), 0) }}
        >
          <DataGridHeader className={s.gridHead}>
            <DataGridRow>
              {({ renderHeaderCell, columnId }) => (
                <DataGridHeaderCell style={columnStyle(columnId)}>{renderHeaderCell()}</DataGridHeaderCell>
              )}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<Row>>
            {({ item, rowId }) => (
              <DataGridRow<Row> key={rowId}>
                {({ renderCell, columnId }) => <DataGridCell style={columnStyle(columnId)}>{renderCell(item)}</DataGridCell>}
              </DataGridRow>
            )}
          </DataGridBody>
        </DataGrid>
        <div ref={endRef} className={s.gridEnd} aria-hidden="true" />
      </div>
      {more && (
        <Body1 className={s.muted}>
          Showing {formatCount(shown)} of {formatCount(filtered.length)}. Scroll the list for more.
        </Body1>
      )}
    </Card>
  )
}
