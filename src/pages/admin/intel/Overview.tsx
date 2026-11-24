import { Body1, Button, Caption1, Card, Label, Link, makeStyles, Select, Subtitle1, Subtitle2, tokens, useId } from '@fluentui/react-components'
import { ArrowRight16Regular, Building20Regular, Eye20Regular, Flag20Regular, DocumentMultiple20Regular } from '@fluentui/react-icons'
import { useMemo } from 'react'
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router'
import { formatCount } from '../../../lib/dom'
import {
  bandName,
  BAND_RANGE,
  BANDS,
  MEASURE,
  median,
  money,
  percent,
  signedPercent,
  type Intel,
  type IntelRow,
  type MeasureKey,
  type OverviewCell,
  type SignalKey,
} from '../../../lib/intel'
import { Kpi } from '../AdminFrame'
import { Bars, Legend, LEVEL_COLOUR, PLAIN, SERIES, YearBars, type BarRow } from './charts'
import { ChartCard, charityPath, SignalChips, watchlistPath } from './shell'

/** The sector at a glance: who trips the most signals, how the money moved, who charities serve. */

const useStyles = makeStyles({
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: '8px 16px' },
  filter: { display: 'grid', gap: '2px' },
  filterNote: { color: tokens.colorNeutralForeground3, marginLeft: 'auto', alignSelf: 'center' },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))', gap: '16px' },
  section: { display: 'grid', gap: '12px', minWidth: 0 },
  sectionHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 12px' },
  muted: { color: tokens.colorNeutralForeground3 },
  two: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 30rem), 1fr))', alignItems: 'start', gap: '16px' },
  top: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))', gap: '12px' },
  topCard: {
    display: 'grid',
    gap: '6px',
    alignContent: 'start',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: 'inherit',
    textDecorationLine: 'none',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, border: `1px solid ${tokens.colorNeutralStroke1}` },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  topHead: { display: 'flex', justifyContent: 'space-between', gap: '8px', color: tokens.colorNeutralForeground3 },
  topName: { fontWeight: tokens.fontWeightSemibold },
  card: { display: 'grid', gap: '12px', alignContent: 'start', minWidth: 0 },
  cardHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px 12px' },
  cardTitle: { display: 'grid', gap: '2px', minWidth: 0 },
})

const TOP = 5
const sum = (lists: number[][], n: number) => Array.from({ length: n }, (_, i) => lists.reduce((t, l) => t + (l[i] ?? 0), 0))

/** Adds up what charities declared (a beneficiary, the areas they work in) across cells, largest first. */
function shares(cells: OverviewCell[], pick: (c: OverviewCell) => [Record<string, number>, number], names: string[], limit: number) {
  const counts = new Map<number, number>()
  let total = 0
  for (const c of cells) {
    const [by, n] = pick(c)
    total += n
    for (const [i, v] of Object.entries(by)) counts.set(Number(i), (counts.get(Number(i)) ?? 0) + v)
  }
  const all = [...counts]
    .map(([i, v]) => ({ name: names[i] ?? '?', count: v, share: total ? v / total : 0 }))
    .sort((a, b) => b.count - a.count)
  return { total, list: all.slice(0, limit), all }
}

export function Overview({ intel }: { intel: Intel }) {
  const s = useStyles()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const sectorId = useId('sector')
  const sizeId = useId('size')
  const { meta } = intel
  const sector = meta.sectors.includes(params.get('sector') ?? '') ? params.get('sector') : null
  const size = BANDS.find((b) => String(b) === params.get('size')) ?? null
  const setFilter = (key: 'sector' | 'size', value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }
  const to = (measure: MeasureKey | 'combined', band: number | null = size) => watchlistPath({ measure, size: band, sector })

  const rows = useMemo(
    () => intel.rows.filter((r) => (!sector || r.sector === sector) && (!size || r.band === size)),
    [intel, sector, size],
  )
  const cells = useMemo(
    () => meta.overview.cells.filter((c) => (!sector || meta.sectors[c.sector] === sector) && (!size || c.band === size)),
    [meta, sector, size],
  )
  const years = meta.overview.years
  const span = `${years[0]}–${years.at(-1)}`

  const top = useMemo(
    () =>
      rows
        .filter((r) => r.signals > 0)
        .sort((a, b) => b.signals - a.signals || b.priority - a.priority || (b.values.income ?? 0) - (a.values.income ?? 0))
        .slice(0, TOP),
    [rows],
  )
  const watched = rows.filter((r) => r.signals >= meta.combined_threshold).length
  const priority = rows.filter((r) => r.priority > 0).length

  const signalRows = useMemo<BarRow[]>(
    () =>
      meta.signal_order.map((k) => {
        const look = rows.filter((r) => r.levels[k] === 1).length
        const high = rows.filter((r) => r.levels[k] === 2).length
        return {
          key: k,
          label: MEASURE[k].chip ?? MEASURE[k].title,
          parts: [
            { value: look, colour: LEVEL_COLOUR[1], name: 'worth a look' },
            { value: high, colour: LEVEL_COLOUR[2], name: 'priority' },
          ],
        }
      }),
    [rows, meta],
  )

  const money5 = useMemo(() => {
    const n = years.length
    return {
      panel: cells.reduce((t, c) => t + c.panel, 0),
      income: sum(cells.map((c) => c.income), n),
      spend: sum(cells.map((c) => c.spend), n),
      due: sum(cells.map((c) => c.due), n),
      onTime: sum(cells.map((c) => c.on_time), n),
    }
  }, [cells, years])
  const onTimeShare = money5.due.map((d, i) => (d ? money5.onTime[i]! / d : null))

  const served = useMemo(() => shares(cells, (c) => [c.ben, c.ben_n], meta.overview.beneficiaries, 7), [cells, meta])
  const places = useMemo(() => shares(cells, (c) => [c.areas, c.area_n], meta.overview.areas, 9), [cells, meta])

  const byBand = useMemo(() => {
    const of = (key: MeasureKey, band: number) =>
      median(rows.filter((r) => r.band === band).map((r) => r.values[key]).filter((v): v is number => v !== null))
    return BANDS.filter((b) => !size || b === size).map((band) => ({
      band,
      n: rows.filter((r) => r.band === band).length,
      growth: of('income_change', band),
      turnover: of('officer_turnover', band),
    }))
  }, [rows, size])

  const bandBars = (key: 'growth' | 'turnover', format: (v: number) => string): BarRow[] =>
    byBand
      .filter((b) => b[key] !== null)
      .map((b) => ({
        key: String(b.band),
        label: bandName(b.band),
        parts: [{ value: b[key]!, colour: PLAIN }],
        shown: format(b[key]!),
        tip: [{ value: format(b[key]!), name: `median of ${formatCount(b.n)} charities spending ${BAND_RANGE[b.band]}` }],
      }))

  return (
    <>
      <div className={s.filters}>
        <div className={s.filter}>
          <Label htmlFor={sectorId} size="small">
            Sector
          </Label>
          <Select id={sectorId} value={sector ?? ''} onChange={(_, d) => setFilter('sector', d.value)}>
            <option value="">All sectors</option>
            {meta.sectors.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        <div className={s.filter}>
          <Label htmlFor={sizeId} size="small">
            Size
          </Label>
          <Select id={sizeId} value={size ? String(size) : ''} onChange={(_, d) => setFilter('size', d.value)}>
            <option value="">All sizes</option>
            {BANDS.map((b) => (
              <option key={b} value={b}>
                {bandName(b)}: {BAND_RANGE[b]}
              </option>
            ))}
          </Select>
        </div>
        <Body1 className={s.filterNote} aria-live="polite">
          {formatCount(rows.length)} of {formatCount(intel.rows.length)} registered charities
        </Body1>
      </div>

      <section aria-label="Summary" className={s.kpis}>
        <Kpi icon={<Building20Regular />} label="Charities" value={formatCount(rows.length)} foot={sector || size ? 'in this sector and size' : 'every registered charity'} />
        <Kpi
          icon={<Eye20Regular />}
          tone="warning"
          label="On the watchlist"
          value={formatCount(watched)}
          foot={`${meta.combined_threshold} or more signals: ${rows.length ? ((watched / rows.length) * 100).toFixed(1) : 0}% of them`}
        />
        <Kpi icon={<Flag20Regular />} tone="danger" label="With a priority signal" value={formatCount(priority)} foot="at least one signal at its higher level" />
        <Kpi icon={<DocumentMultiple20Regular />} label="Annual returns read" value={formatCount(meta.counts.returns)} foot={`years ending from ${years[0]! - 1}, all sectors`} />
      </section>

      <Card className={s.card}>
        <div className={s.cardHead}>
          <div className={s.cardTitle}>
            <Subtitle2 as="h2">The {top.length || TOP} charities with the most signals</Subtitle2>
            <Body1 className={s.muted}>Each trips several signals at “worth a look” or above. Open one for the full picture.</Body1>
          </div>
          <Button appearance="secondary" icon={<ArrowRight16Regular />} iconPosition="after" onClick={() => navigate(to('combined'))}>
            The full watchlist
          </Button>
        </div>
        {top.length ? (
          <div className={s.top}>
            {top.map((r, i) => (
              <TopCard key={r.cc} intel={intel} row={r} rank={i + 1} />
            ))}
          </div>
        ) : (
          <Body1 className={s.muted}>No charity here trips a signal.</Body1>
        )}
      </Card>

      <ChartCard
        title="Signals at a glance"
        description="How many of these charities each signal picks out. Click a row to rank the watchlist by it."
        table={{
          head: ['Signal', 'Worth a look', 'Priority'],
          rows: signalRows.map((r) => [r.label, formatCount(r.parts[0]!.value), formatCount(r.parts[1]!.value)]),
        }}
      >
        <Legend marks="box" items={[{ label: 'Worth a look', colour: LEVEL_COLOUR[1] }, { label: 'Priority', colour: LEVEL_COLOUR[2] }]} />
        <Bars rows={signalRows} format={formatCount} label="Charities picked out by each signal, at worth a look and at priority" onPick={(k) => navigate(to(k as SignalKey))} />
      </ChartCard>

      <section className={s.section} aria-labelledby="money-heading">
        <div className={s.sectionHead}>
          <Subtitle1 as="h2" id="money-heading">
            Financial movement
          </Subtitle1>
          <Body1 className={s.muted}>Across the five complete years, {span}</Body1>
        </div>
        <div className={s.two}>
          <ChartCard
            title="Income and spending"
            description="Added up for the same charities every year."
            table={{ head: ['Year', 'Income', 'Spending'], rows: years.map((y, i) => [y, money(money5.income[i]!), money(money5.spend[i]!)]) }}
            foot={`Summed over the ${formatCount(money5.panel)} charities with a published return for every year, so a year's total doesn't move because more or fewer filed.`}
            action={<WatchLink to={to('asset_growth_gap')}>Asset growth beyond spending</WatchLink>}
          >
            <Legend marks="box" items={[{ label: 'Income', colour: SERIES.income }, { label: 'Spending', colour: SERIES.spend }]} />
            <YearBars
              years={years}
              format={money}
              label={`Total income and spending of the same charities, ${span}`}
              series={[
                { key: 'income', label: 'Income', colour: SERIES.income, values: money5.income },
                { key: 'spend', label: 'Spending', colour: SERIES.spend, values: money5.spend },
              ]}
            />
          </ChartCard>
          <ChartCard
            title="Returns filed on time"
            description="Of the returns due each year, the share that arrived on time."
            table={{
              head: ['Year', 'On time', 'Returns due'],
              rows: years.map((y, i) => [y, onTimeShare[i] === null ? '—' : percent(onTimeShare[i]!), formatCount(money5.due[i]!)]),
            }}
            foot={`The share of returns due that arrived within ${meta.grace_days} days of the due date. The register doesn't publish when a return arrived: it is worked out from the approval date, or from the order the register numbered the returns in.`}
            action={<WatchLink to={to('late_returns')}>Late or missing returns</WatchLink>}
          >
            <YearBars
              years={years}
              format={percent}
              top={1}
              label={`Share of returns filed on time, ${span}`}
              series={[{ key: 'on_time', label: 'On time', colour: PLAIN, values: onTimeShare }]}
            />
          </ChartCard>
        </div>
      </section>

      <section className={s.section} aria-labelledby="who-heading">
        <div className={s.sectionHead}>
          <Subtitle1 as="h2" id="who-heading">
            Who charities serve, and where
          </Subtitle1>
          <Body1 className={s.muted}>As each charity declares on the register</Body1>
        </div>
        <div className={s.two}>
          <ChartCard
            title="Main beneficiary"
            table={{ head: ['Beneficiary', 'Share', 'Charities'], rows: served.all.map((x) => [x.name, percent(x.share), formatCount(x.count)]) }}
            foot={`Of the ${formatCount(served.total)} charities that name one.`}
          >
            <Bars
              rows={served.list.map((x) => ({ key: x.name, label: x.name, parts: [{ value: x.share, colour: PLAIN }], shown: percent(x.share), tip: [{ value: formatCount(x.count), name: 'charities' }] }))}
              format={percent}
              label="Share of charities by the main beneficiary they declare"
            />
          </ChartCard>
          <ChartCard
            title="Areas of operation"
            table={{ head: ['Area', 'Share', 'Charities'], rows: places.all.map((x) => [x.name, percent(x.share), formatCount(x.count)]) }}
            foot={`Where charities say they work, not where the money is spent. Of the ${formatCount(places.total)} that declare an area; a charity can declare several.`}
            action={<WatchLink to={to('overseas_share')}>Share spent overseas</WatchLink>}
          >
            <Bars
              rows={places.list.map((x) => ({ key: x.name, label: x.name, parts: [{ value: x.share, colour: PLAIN }], shown: percent(x.share), tip: [{ value: formatCount(x.count), name: 'charities' }] }))}
              format={percent}
              label="Share of charities working in each area"
            />
          </ChartCard>
        </div>
      </section>

      <section className={s.section} aria-labelledby="size-heading">
        <div className={s.sectionHead}>
          <Subtitle1 as="h2" id="size-heading">
            By size
          </Subtitle1>
          <Body1 className={s.muted}>Charities read against others of their size. Click a row to rank that size on the watchlist.</Body1>
        </div>
        <div className={s.two}>
          <ChartCard
            title="Income change"
            description="The median change in income on the latest return."
            table={{ head: ['Size', 'Median change', 'Charities'], rows: byBand.map((b) => [bandName(b.band), b.growth === null ? '—' : signedPercent(b.growth), formatCount(b.n)]) }}
          >
            <Bars rows={bandBars('growth', (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${(Math.abs(v) * 100).toFixed(1)}%`)} format={signedPercent} label="Median income change by size of charity" onPick={(b) => navigate(to('income_change', Number(b)))} />
          </ChartCard>
          <ChartCard
            title="Officer turnover"
            description="The median share of the board leaving each year."
            table={{ head: ['Size', 'Median turnover', 'Charities'], rows: byBand.map((b) => [bandName(b.band), b.turnover === null ? '—' : percent(b.turnover), formatCount(b.n)]) }}
          >
            <Bars rows={bandBars('turnover', percent)} format={percent} label="Median officer turnover by size of charity" onPick={(b) => navigate(to('officer_turnover', Number(b)))} />
          </ChartCard>
        </div>
        <Caption1 className={s.muted}>
          Size is what a charity spent in its latest year, against the reporting tiers' limits: {BANDS.map((b) => `${bandName(b)}, ${BAND_RANGE[b]}`).join('; ')}.
          Not the tier on its return: some small charities tick Tier 1, and older returns carry none.
        </Caption1>
      </section>
    </>
  )
}

function WatchLink({ to, children }: { to: string; children: string }) {
  const navigate = useNavigate()
  return (
    <Button appearance="subtle" icon={<ArrowRight16Regular />} iconPosition="after" onClick={() => navigate(to)} title={`On the watchlist: ${children}`}>
      Watchlist
    </Button>
  )
}

function TopCard({ intel, row, rank }: { intel: Intel; row: IntelRow; rank: number }) {
  const s = useStyles()
  const income = row.values.income
  return (
    <RouterLink to={charityPath(row.cc)} className={s.topCard}>
      <span className={s.topHead}>
        <Caption1>#{rank}</Caption1>
        <Caption1>
          {row.signals} {row.signals === 1 ? 'signal' : 'signals'}
        </Caption1>
      </span>
      <span className={s.topName}>{row.name}</span>
      <Caption1 className={s.muted}>{[bandName(row.band), row.sector, income === null ? null : money(income)].filter(Boolean).join(' · ')}</Caption1>
      <SignalChips intel={intel} row={row} />
    </RouterLink>
  )
}

/** A link in running text to a charity's profile. */
export function CharityLink({ cc, children }: { cc: string; children: string }) {
  const navigate = useNavigate()
  return (
    <Link
      href={charityPath(cc)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        navigate(charityPath(cc))
      }}
    >
      {children}
    </Link>
  )
}
