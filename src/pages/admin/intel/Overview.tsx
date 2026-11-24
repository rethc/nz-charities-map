import {
  Body1,
  Button,
  Caption1,
  Field,
  Link,
  makeStyles,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  tokens,
  type LabelProps,
} from '@fluentui/react-components'
import { ArrowRight16Regular, Building20Regular, DocumentMultiple20Regular, Eye20Regular, Flag20Regular, Search24Regular } from '@fluentui/react-icons'
import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import { formatCount } from '../../../lib/dom'
import {
  bandName,
  BAND_RANGE,
  BANDS,
  MEASURE,
  median,
  money,
  percent,
  SIGNAL_MEANS,
  signedPercent,
  TIER_MEANS,
  type Intel,
  type MeasureKey,
  type OverviewCell,
  type SignalKey,
} from '../../../lib/intel'
import { Kpi } from '../AdminFrame'
import { Bars, Legend, LEVEL_COLOUR, PLAIN, SERIES, YearBars, type BarRow } from './charts'
import { ChartCard, charityPath, EmptyState, HelpLabel, LevelBadge, Panel, Section, SignalChips, watchlistPath } from './shell'

/** The sector at a glance: who has the most signals, how the money moved, who charities serve. */

const useStyles = makeStyles({
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}` },
  field: { minWidth: 'min(14rem, 100%)', maxWidth: '100%' },
  filterNote: { color: tokens.colorNeutralForeground3, marginLeft: 'auto', paddingBottom: tokens.spacingVerticalXS },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))', gap: tokens.spacingHorizontalL },
  lead: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)',
    alignItems: 'start',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  two: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 30rem), 1fr))', alignItems: 'start', gap: tokens.spacingHorizontalL },
  muted: { color: tokens.colorNeutralForeground3 },
  tableBox: { overflowX: 'auto', minWidth: 0 },
  rank: { width: '3rem', color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  count: { width: '6rem' },
  name: { display: 'grid', gap: tokens.spacingVerticalXXS, padding: `${tokens.spacingVerticalS} 0` },
  chips: { padding: `${tokens.spacingVerticalS} 0` },
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
  const narrow = useMediaQuery('(max-width: 720px)')
  const [params, setParams] = useSearchParams()
  const { meta } = intel
  const sector = meta.sectors.includes(params.get('sector') ?? '') ? params.get('sector') : null
  const tier = BANDS.find((b) => String(b) === params.get('tier')) ?? null
  const setFilter = (key: 'sector' | 'tier', value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }
  const to = (measure: MeasureKey | 'combined', band: number | null = tier) => watchlistPath({ measure, tier: band, sector })

  const rows = useMemo(
    () => intel.rows.filter((r) => (!sector || r.sector === sector) && (!tier || r.band === tier)),
    [intel, sector, tier],
  )
  const cells = useMemo(
    () => meta.overview.cells.filter((c) => (!sector || meta.sectors[c.sector] === sector) && (!tier || c.band === tier)),
    [meta, sector, tier],
  )
  const years = meta.overview.years
  const span = `${years[0]} to ${years.at(-1)}`

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
      meta.signal_order.map((k) => ({
        key: k,
        label: MEASURE[k].short,
        parts: [
          { value: rows.filter((r) => r.levels[k] === 1).length, colour: LEVEL_COLOUR[1], name: 'worth a look' },
          { value: rows.filter((r) => r.levels[k] === 2).length, colour: LEVEL_COLOUR[2], name: 'priority' },
        ],
      })),
    [rows, meta],
  )

  const totals = useMemo(() => {
    const n = years.length
    return {
      panel: cells.reduce((t, c) => t + c.panel, 0),
      income: sum(cells.map((c) => c.income), n),
      spend: sum(cells.map((c) => c.spend), n),
      due: sum(cells.map((c) => c.due), n),
      onTime: sum(cells.map((c) => c.on_time), n),
    }
  }, [cells, years])
  const onTimeShare = totals.due.map((d, i) => (d ? totals.onTime[i]! / d : null))

  const served = useMemo(() => shares(cells, (c) => [c.ben, c.ben_n], meta.overview.beneficiaries, 7), [cells, meta])
  const places = useMemo(() => shares(cells, (c) => [c.areas, c.area_n], meta.overview.areas, 9), [cells, meta])

  const byTier = useMemo(() => {
    const of = (key: MeasureKey, band: number) =>
      median(rows.filter((r) => r.band === band).map((r) => r.values[key]).filter((v): v is number => v !== null))
    return BANDS.filter((b) => !tier || b === tier).map((band) => ({
      band,
      n: rows.filter((r) => r.band === band).length,
      growth: of('income_change', band),
      turnover: of('officer_turnover', band),
    }))
  }, [rows, tier])
  const tierBars = (key: 'growth' | 'turnover', format: (v: number) => string): BarRow[] =>
    byTier
      .filter((b) => b[key] !== null)
      .map((b) => ({
        key: String(b.band),
        label: bandName(b.band),
        parts: [{ value: b[key]!, colour: PLAIN }],
        shown: format(b[key]!),
        tip: [{ value: format(b[key]!), name: `the middle figure of ${formatCount(b.n)} charities with ${BAND_RANGE[b.band]}` }],
      }))
  const oneDecimal = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${(Math.abs(v) * 100).toFixed(1)}%`
  const shareBars = (list: { name: string; count: number; share: number }[]): BarRow[] =>
    list.map((x) => ({ key: x.name, label: x.name, parts: [{ value: x.share, colour: PLAIN }], shown: percent(x.share), tip: [{ value: formatCount(x.count), name: 'charities' }] }))

  return (
    <>
      <div className={s.filters}>
        <Field label="Sector" className={s.field}>
          <Select value={sector ?? ''} onChange={(_, d) => setFilter('sector', d.value)}>
            <option value="">All sectors</option>
            {meta.sectors.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          className={s.field}
          label={{
            children: (_: unknown, props: LabelProps) => (
              <HelpLabel {...props} info={TIER_MEANS}>
                Reporting tier
              </HelpLabel>
            ),
          }}
        >
          <Select value={tier ? String(tier) : ''} onChange={(_, d) => setFilter('tier', d.value)}>
            <option value="">All tiers</option>
            {BANDS.map((b) => (
              <option key={b} value={b} title={BAND_RANGE[b]}>
                {bandName(b)}
              </option>
            ))}
          </Select>
        </Field>
        <Body1 className={s.filterNote} aria-live="polite">
          Showing {formatCount(rows.length)} of {formatCount(intel.rows.length)} registered charities
        </Body1>
      </div>

      <section aria-label="Summary" className={s.kpis}>
        <Kpi icon={<Building20Regular />} label="Registered charities" value={formatCount(rows.length)} foot={sector || tier ? 'in this sector and tier' : 'every charity on the register'} />
        <Kpi
          icon={<Eye20Regular />}
          tone="warning"
          label="On the watchlist"
          value={formatCount(watched)}
          foot={`${meta.combined_threshold} or more signals: ${rows.length ? ((watched / rows.length) * 100).toFixed(1) : 0}% of these charities`}
        />
        <Kpi icon={<Flag20Regular />} tone="danger" label="With a priority signal" value={formatCount(priority)} foot="at least 1 signal at its higher level" />
        <Kpi icon={<DocumentMultiple20Regular />} label="Annual returns read" value={formatCount(meta.counts.returns)} foot={`for years ending from ${years[0]! - 1}, all sectors`} />
      </section>

      <div className={s.lead}>
        <Panel
          level={2}
          title="Charities with the most signals"
          description={SIGNAL_MEANS}
          action={
            <Button appearance="secondary" icon={<ArrowRight16Regular />} iconPosition="after" onClick={() => navigate(to('combined'))}>
              See the watchlist
            </Button>
          }
        >
          {top.length ? (
            <div className={s.tableBox}>
              <Table aria-label="The charities with the most signals">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell className={s.rank}>#</TableHeaderCell>
                    <TableHeaderCell>Charity</TableHeaderCell>
                    <TableHeaderCell className={s.count}>Signals</TableHeaderCell>
                    {!narrow && <TableHeaderCell>Which signals</TableHeaderCell>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {top.map((r, i) => (
                    <TableRow key={r.cc}>
                      <TableCell className={s.rank}>{i + 1}</TableCell>
                      <TableCell>
                        <span className={s.name}>
                          <CharityLink cc={r.cc}>{r.name}</CharityLink>
                          <Caption1 className={s.muted}>
                            {[bandName(r.band), r.sector, r.values.income === null ? null : `${money(r.values.income)} revenue`].filter(Boolean).join(' · ')}
                          </Caption1>
                        </span>
                      </TableCell>
                      <TableCell className={s.count}>
                        <LevelBadge level={r.priority ? 2 : 1}>{r.signals}</LevelBadge>
                      </TableCell>
                      {!narrow && (
                        <TableCell>
                          <div className={s.chips}>
                            <SignalChips intel={intel} row={r} />
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState icon={<Search24Regular />} title="No signals here">
              None of these charities has a signal. Try another sector or reporting tier.
            </EmptyState>
          )}
        </Panel>

        <ChartCard
          level={2}
          title="How many charities each signal picks out"
          description="Select a row to rank the watchlist by that signal."
          table={{
            head: ['Signal', 'Worth a look', 'Priority'],
            rows: signalRows.map((r) => [r.label, formatCount(r.parts[0]!.value), formatCount(r.parts[1]!.value)]),
          }}
        >
          <Legend marks="box" items={[{ label: 'Worth a look', colour: LEVEL_COLOUR[1] }, { label: 'Priority', colour: LEVEL_COLOUR[2] }]} />
          <Bars rows={signalRows} format={formatCount} label="Charities picked out by each signal, at worth a look and at priority" onPick={(k) => navigate(to(k as SignalKey))} />
        </ChartCard>
      </div>

      <Section title="Revenue, expenses and annual returns" description={`The 5 most recent years with every annual return due: ${span}.`}>
        <div className={s.two}>
          <ChartCard
            title="Revenue and expenses"
            description="Added up for the same charities every year."
            table={{ head: ['Year', 'Revenue', 'Expenses'], rows: years.map((y, i) => [y, money(totals.income[i]!), money(totals.spend[i]!)]) }}
            foot={`Covers the ${formatCount(totals.panel)} charities with a published annual return for every one of these years. That way a year's total does not change just because more or fewer charities filed.`}
            action={<WatchLink to={to('asset_growth_gap')} about={MEASURE.asset_growth_gap.title} />}
          >
            <Legend marks="box" items={[{ label: 'Revenue', colour: SERIES.income }, { label: 'Expenses', colour: SERIES.spend }]} />
            <YearBars
              years={years}
              format={money}
              label={`Total revenue and expenses of the same charities, ${span}`}
              series={[
                { key: 'income', label: 'Revenue', colour: SERIES.income, values: totals.income },
                { key: 'spend', label: 'Expenses', colour: SERIES.spend, values: totals.spend },
              ]}
            />
          </ChartCard>
          <ChartCard
            title="Annual returns filed on time"
            description="The share of annual returns due each year that were filed on time."
            table={{
              head: ['Year', 'On time', 'Annual returns due'],
              rows: years.map((y, i) => [y, onTimeShare[i] === null ? '—' : percent(onTimeShare[i]!), formatCount(totals.due[i]!)]),
            }}
            foot={`On time means filed within ${meta.grace_days} days of the due date. The register does not publish the date a return was filed, so we work it out from the approval date or from the order the register numbered the returns in.`}
            action={<WatchLink to={to('late_returns')} about={MEASURE.late_returns.title} />}
          >
            <YearBars
              years={years}
              format={percent}
              top={1}
              label={`Share of annual returns filed on time, ${span}`}
              series={[{ key: 'on_time', label: 'On time', colour: PLAIN, values: onTimeShare }]}
            />
          </ChartCard>
        </div>
      </Section>

      <Section title="Who charities serve, and where" description="What each charity has told the Charities Register.">
        <div className={s.two}>
          <ChartCard
            title="Main beneficiary"
            table={{ head: ['Beneficiary', 'Share', 'Charities'], rows: served.all.map((x) => [x.name, percent(x.share), formatCount(x.count)]) }}
            foot={`Share of the ${formatCount(served.total)} charities that name a main beneficiary.`}
          >
            <Bars rows={shareBars(served.list)} format={percent} label="Share of charities by the main beneficiary they name" />
          </ChartCard>
          <ChartCard
            title="Areas of operation"
            table={{ head: ['Area', 'Share', 'Charities'], rows: places.all.map((x) => [x.name, percent(x.share), formatCount(x.count)]) }}
            foot={`Where charities say they work, not where they spend their money. Share of the ${formatCount(places.total)} charities that name an area. A charity can name more than 1.`}
            action={<WatchLink to={to('overseas_share')} about={MEASURE.overseas_share.title} />}
          >
            <Bars rows={shareBars(places.list)} format={percent} label="Share of charities working in each area" />
          </ChartCard>
        </div>
      </Section>

      <Section title="By reporting tier" description="The middle figure (median) for the charities in each tier. Select a row to rank that tier on the watchlist.">
        <div className={s.two}>
          <ChartCard
            title="Change in revenue"
            description="Revenue on the latest annual return compared with the year before."
            table={{ head: ['Reporting tier', 'Median change', 'Charities'], rows: byTier.map((b) => [bandName(b.band), b.growth === null ? '—' : oneDecimal(b.growth), formatCount(b.n)]) }}
          >
            <Bars rows={tierBars('growth', oneDecimal)} format={signedPercent} label="Median change in revenue by reporting tier" onPick={(b) => navigate(to('income_change', Number(b)))} />
          </ChartCard>
          <ChartCard
            title="Officers leaving each year"
            description="The share of a charity's officers who leave in a year."
            table={{ head: ['Reporting tier', 'Median share', 'Charities'], rows: byTier.map((b) => [bandName(b.band), b.turnover === null ? '—' : percent(b.turnover), formatCount(b.n)]) }}
          >
            <Bars rows={tierBars('turnover', percent)} format={percent} label="Median share of officers leaving each year, by reporting tier" onPick={(b) => navigate(to('officer_turnover', Number(b)))} />
          </ChartCard>
        </div>
        <Caption1 className={s.muted}>
          {TIER_MEANS} The limits: {BANDS.map((b) => `${bandName(b)}, ${BAND_RANGE[b]}`).join('; ')}.
        </Caption1>
      </Section>
    </>
  )
}

function WatchLink({ to, about }: { to: string; about: string }) {
  const navigate = useNavigate()
  return (
    <Button appearance="subtle" icon={<ArrowRight16Regular />} iconPosition="after" onClick={() => navigate(to)} title={`Rank the watchlist by: ${about}`}>
      Watchlist
    </Button>
  )
}

/** A link to a charity's profile that stays inside the app. */
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
