import {
  Body1,
  Body1Strong,
  Button,
  Caption1,
  Caption1Strong,
  Card,
  Combobox,
  Field,
  Link,
  makeStyles,
  mergeClasses,
  MessageBar,
  MessageBarBody,
  Option,
  Skeleton,
  SkeletonItem,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Title2,
  tokens,
  typographyStyles,
} from '@fluentui/react-components'
import { ArrowDown12Filled, ArrowUp12Filled, BuildingRegular, Location16Regular, Open16Regular, Search20Regular } from '@fluentui/react-icons'
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { registerUrl } from '../../../lib/charities'
import {
  bandName,
  BAND_RANGE,
  dollars,
  GROUP_ORDER,
  GROUPS,
  isSignal,
  levelOf,
  loadCharity,
  MEASURES,
  money,
  moneyWords,
  peers,
  ruleCondition,
  ruleText,
  searchIntel,
  shareBelow,
  standing,
  type Intel,
  type IntelCharity,
  type IntelRow,
  type IntelYear,
  type Level,
  type MeasureInfo,
  type YearStatus,
} from '../../../lib/intel'
import { Legend, LineChart, PositionBar, SERIES } from './charts'
import { CharityLink } from './Overview'
import { charityPath, EmptyState, LevelBadge, MeasureGuide, Panel, showDay, Stat } from './shell'

/** One charity: its last 5 years, its annual returns, its officers, and each measure compared with its reporting tier. */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const shortDate = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const showShort = (iso: string) => shortDate.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`))

const STATUS: Record<YearStatus, string> = {
  on_time: 'On time',
  late: 'Late',
  missing: 'Not filed',
  processing: 'Being processed',
  group: 'Filed by its group',
  unknown: 'Not in the data',
  none: 'None due',
}

/** An annual return is due 6 months after the balance date; a month's last day stays a month's last day. */
function dueDate(ended: string): string {
  const [y, m, d] = ended.slice(0, 10).split('-').map(Number) as [number, number, number]
  const monthEnd = d === new Date(Date.UTC(y, m, 0)).getUTCDate()
  const last = new Date(Date.UTC(y, m + 6, 0)).getUTCDate()
  return new Date(Date.UTC(y, m - 1 + 6, monthEnd ? last : Math.min(d, last))).toISOString().slice(0, 10)
}

const useStyles = makeStyles({
  find: { maxWidth: '34rem' },
  option: { display: 'grid', gap: tokens.spacingVerticalXXS },
  muted: { color: tokens.colorNeutralForeground3 },
  // The charity's name, and its signals at a glance
  header: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXXL}`,
    '@media (max-width: 800px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  headText: { display: 'grid', gap: tokens.spacingVerticalXS, minWidth: 0 },
  headLinks: { display: 'flex', flexWrap: 'wrap', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, marginTop: tokens.spacingVerticalXS },
  verdict: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    alignItems: 'center',
    gap: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    borderInlineStartWidth: '4px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens.colorNeutralStroke1,
    maxWidth: '26rem',
  },
  verdictLook: { borderInlineStartColor: tokens.colorPaletteMarigoldBorderActive },
  verdictPriority: { borderInlineStartColor: tokens.colorPaletteRedBorderActive },
  verdictNumber: { gridRow: '1 / span 2', ...typographyStyles.largeTitle },
  // The page: two columns, then a row of cards
  top: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 6fr)',
    alignItems: 'start',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 1180px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  column: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: tokens.spacingVerticalL, minWidth: 0 },
  bottom: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 24rem), 1fr))', alignItems: 'start', gap: tokens.spacingHorizontalL },
  tableBox: { overflowX: 'auto', minWidth: 0 },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  numberHead: { justifyContent: 'flex-end' },
  move: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'flex-end' },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: tokens.spacingHorizontalM },
  rowHead: { width: '40%' },
  // A name and what goes with it
  facts: { display: 'grid', gap: tokens.spacingVerticalM, margin: 0 },
  fact: { display: 'grid', gap: tokens.spacingVerticalXXS },
  factName: { color: tokens.colorNeutralForeground3 },
  factValue: { margin: 0 },
  list: { display: 'grid', gap: tokens.spacingVerticalXS, margin: 0, padding: 0, listStyleType: 'none' },
  block: { display: 'grid', gap: tokens.spacingVerticalS },
  // The measures table
  measures: { minWidth: '30rem' },
  valueCol: { width: '10rem' },
  barCol: { width: '32%' },
  scaleEnds: { display: 'flex', justifyContent: 'space-between', width: '100%', gap: tokens.spacingHorizontalS },
  groupRow: { backgroundColor: tokens.colorNeutralBackground3 },
  measureName: { display: 'grid', gap: tokens.spacingVerticalXXS, padding: `${tokens.spacingVerticalS} 0` },
  look: { backgroundColor: tokens.colorStatusWarningBackground1 },
  priority: { backgroundColor: tokens.colorStatusDangerBackground1 },
  joined: { borderBottomStyle: 'none' },
  why: { padding: `0 ${tokens.spacingHorizontalS} ${tokens.spacingVerticalM}`, height: 'auto', color: tokens.colorNeutralForeground2 },
  value: { display: 'flex', justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums', ...typographyStyles.body1Strong },
  skeleton: { display: 'grid', gap: tokens.spacingVerticalM },
})

export function Charity({ intel }: { intel: Intel }) {
  const { cc: param } = useParams()
  const cc = param?.trim().toUpperCase() ?? null
  const row = cc ? (intel.byCc.get(cc) ?? null) : null

  return (
    <>
      <Finder intel={intel} />
      {!cc ? (
        <Card size="large">
          <EmptyState icon={<BuildingRegular fontSize={28} />} title="Find a charity to see its profile">
            Search by name or CC number above, or open a charity from the watchlist. A profile shows the charity's last 5 years,
            its annual returns, its officers, and how each figure compares with other charities in its reporting tier.
          </EmptyState>
        </Card>
      ) : !row ? (
        <Card size="large">
          <EmptyState icon={<Search20Regular fontSize={28} />} title={`No registered charity has the number ${cc}`}>
            It may have been deregistered. A registered group has its own number too, and groups are not measured here.
          </EmptyState>
        </Card>
      ) : (
        <Profile key={row.cc} intel={intel} row={row} />
      )}
    </>
  )
}

/** Search by name or CC number, as Fluent's combobox: type, then choose from the matches. */
function Finder({ intel }: { intel: Intel }) {
  const s = useStyles()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const results = useMemo(() => searchIntel(intel.rows, query), [intel, query])
  return (
    <Field label="Find a charity" className={s.find}>
      <Combobox
        freeform
        size="large"
        placeholder="Name or CC number"
        autoComplete="off"
        expandIcon={<Search20Regular />}
        value={query}
        selectedOptions={[]}
        onChange={(e) => setQuery(e.target.value)}
        onOptionSelect={(_, d) => {
          if (!d.optionValue) return
          setQuery('')
          navigate(charityPath(d.optionValue))
        }}
      >
        {results.map((r) => (
          <Option key={r.cc} value={r.cc} text={r.name}>
            <span className={s.option}>
              <span>{r.name}</span>
              <Caption1 className={s.muted}>{[r.cc, bandName(r.band), r.sector].filter(Boolean).join(' · ')}</Caption1>
            </span>
          </Option>
        ))}
        {query.trim().length >= 2 && !results.length && (
          <Option key="none" value="" text="" disabled>
            No registered charity matches
          </Option>
        )}
      </Combobox>
    </Field>
  )
}

type Load = { status: 'loading' } | { status: 'ready'; detail: IntelCharity | null } | { status: 'error'; message: string }

function Profile({ intel, row }: { intel: Intel; row: IntelRow }) {
  const s = useStyles()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  useEffect(() => {
    let active = true
    loadCharity(intel, row.cc).then(
      (detail) => active && setLoad({ status: 'ready', detail }),
      (err: unknown) => active && setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      active = false
    }
  }, [intel, row.cc])
  const detail = load.status === 'ready' ? load.detail : null
  const income = row.values.income

  // Where its number of signals sits among charities in its tier.
  const signalStanding = useMemo(() => {
    const sorted = intel.rows.filter((r) => r.band === row.band).map((r) => r.signals).sort((a, b) => a - b)
    return sorted.length >= 20 ? Math.floor(shareBelow(sorted, row.signals) * 100) : null
  }, [intel, row])
  const top: Level = row.priority ? 2 : row.signals ? 1 : 0

  return (
    <>
      <Card size="large">
        <div className={s.header}>
          <div className={s.headText}>
            <Caption1 className={s.muted}>Registered charity {row.cc}</Caption1>
            <Title2 as="h2">{row.name}</Title2>
            <Body1 className={s.muted}>
              {[
                row.band ? bandName(row.band) : null,
                row.sector,
                row.officers === null ? null : `${row.officers} ${row.officers === 1 ? 'officer' : 'officers'}`,
                income === null ? null : `${money(income)} revenue`,
                detail?.city,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Body1>
            <div className={s.headLinks}>
              <Link href={registerUrl(row.cc)} target="_blank" rel="noopener noreferrer">
                View on the Charities Register <Open16Regular style={{ verticalAlign: 'text-bottom' }} />
              </Link>
              {detail?.onMap && (
                <Link href={`/?cc=${encodeURIComponent(row.cc)}`}>
                  <Location16Regular style={{ verticalAlign: 'text-bottom' }} /> Show on the map
                </Link>
              )}
            </div>
          </div>
          <div className={mergeClasses(s.verdict, top === 1 && s.verdictLook, top === 2 && s.verdictPriority)}>
            <span className={s.verdictNumber}>{row.signals}</span>
            <Body1Strong>
              {row.signals === 1 ? 'signal' : 'signals'}
              {row.priority ? `, ${row.priority} at priority` : row.signals ? ' worth a look' : ''}
            </Body1Strong>
            <Caption1 className={s.muted}>
              {!row.band
                ? 'It has no annual return in the last 5 years to work out its reporting tier.'
                : signalStanding !== null && row.signals > 0
                  ? `More than ${signalStanding}% of ${bandName(row.band)} charities`
                  : `Compared with other ${bandName(row.band)} charities`}
            </Caption1>
          </div>
        </div>
      </Card>

      {detail?.note && (
        <MessageBar intent="info">
          <MessageBarBody>{detail.note}</MessageBarBody>
        </MessageBar>
      )}
      {row.tier !== null && row.band > 0 && row.tier !== row.band && (
        <MessageBar intent="info">
          <MessageBarBody>
            This charity's latest annual return says Tier {row.tier}.{' '}
            {row.spend === null ? 'Its expenses put' : `Its expenses of ${moneyWords(row.spend)} put`} it in {bandName(row.band)} (
            {BAND_RANGE[row.band]}), so it is compared with other {bandName(row.band)} charities.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.top}>
        <div className={s.column}>
          {load.status === 'loading' && <CardSkeleton />}
          {load.status === 'error' && (
            <MessageBar intent="error">
              <MessageBarBody>The year-by-year figures could not be loaded: {load.message}</MessageBarBody>
            </MessageBar>
          )}
          {load.status === 'ready' && !detail && (
            <MessageBar intent="info">
              <MessageBarBody>The year-by-year figures for this charity are not in the latest update. They will be in the next one.</MessageBarBody>
            </MessageBar>
          )}
          {detail && (
            <>
              <Trend years={detail.years} />
              <Reporting intel={intel} detail={detail} row={row} />
            </>
          )}
        </div>
        <Measures intel={intel} row={row} detail={detail} />
      </div>

      {detail && (
        <div className={s.bottom}>
          <Governance row={row} detail={detail} />
          <Purpose detail={detail} row={row} />
          {detail.checks.length > 0 && <Checks detail={detail} />}
        </div>
      )}
    </>
  )
}

function CardSkeleton() {
  const s = useStyles()
  return (
    <Card size="large">
      <Skeleton aria-label="Loading this charity's last 5 years" className={s.skeleton}>
        <SkeletonItem size={20} style={{ width: '14rem', maxWidth: '100%' }} />
        <SkeletonItem size={128} />
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonItem key={i} size={16} />
        ))}
      </Skeleton>
    </Card>
  )
}

/** A name with what goes with it, one above the other. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  const s = useStyles()
  return (
    <div className={s.fact}>
      <dt>
        <Caption1Strong className={s.factName}>{name}</Caption1Strong>
      </dt>
      <dd className={s.factValue}>
        <Body1>{children}</Body1>
      </dd>
    </div>
  )
}

function Trend({ years }: { years: IntelYear[] }) {
  const s = useStyles()
  const basis = years.findLast((y) => y.fundsBasis)?.fundsBasis ?? 'net_assets'
  const fundsLabel = basis === 'cash' ? 'Cash held' : basis === 'resources' ? 'Resources less commitments' : 'Net assets'
  const mixed = new Set(years.map((y) => y.fundsBasis).filter(Boolean)).size > 1
  const has = years.some((y) => y.income !== null || y.spend !== null || y.funds !== null)
  const cell = (now: number | null, before: number | null | undefined) => {
    if (now === null) return '—'
    const move = before == null || now === before ? null : now > before ? 'up' : 'down'
    return (
      <span className={s.move}>
        {move === 'up' && <ArrowUp12Filled aria-label="up on the year before" className={s.muted} />}
        {move === 'down' && <ArrowDown12Filled aria-label="down on the year before" className={s.muted} />}
        {dollars(now)}
      </span>
    )
  }
  return (
    <Panel title="Revenue, expenses and net assets" description="The last 5 years, as reported on its annual returns." level={3}>
      {has ? (
        <>
          <Legend
            items={[
              { label: 'Revenue', colour: SERIES.income },
              { label: 'Expenses', colour: SERIES.spend },
              { label: fundsLabel, colour: SERIES.funds },
            ]}
          />
          <LineChart
            years={years.map((y) => y.fy)}
            format={money}
            tick={money}
            label={`Revenue, expenses and ${fundsLabel.toLowerCase()} for each of its last 5 years`}
            series={[
              { key: 'income', label: 'Revenue', colour: SERIES.income, values: years.map((y) => y.income) },
              { key: 'spend', label: 'Expenses', colour: SERIES.spend, values: years.map((y) => y.spend) },
              { key: 'funds', label: fundsLabel, colour: SERIES.funds, values: years.map((y) => y.funds) },
            ]}
          />
          <div className={s.tableBox}>
            <Table size="small" aria-label="Its figures year by year">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Year</TableHeaderCell>
                  <TableHeaderCell button={{ className: s.numberHead }}>Revenue</TableHeaderCell>
                  <TableHeaderCell button={{ className: s.numberHead }}>Expenses</TableHeaderCell>
                  <TableHeaderCell button={{ className: s.numberHead }}>{fundsLabel}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {years.map((y, i) => (
                  <TableRow key={y.fy}>
                    <TableCell>{y.fy}</TableCell>
                    <TableCell className={s.number}>{cell(y.income, years[i - 1]?.income)}</TableCell>
                    <TableCell className={s.number}>{cell(y.spend, years[i - 1]?.spend)}</TableCell>
                    <TableCell className={s.number}>{cell(y.funds, years[i - 1]?.funds)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Caption1 className={s.muted}>
            Arrows compare each figure with the year before. A dash means the figure was left blank, or there is no published
            annual return for that year.
            {mixed && ' Its annual returns changed tier, so the last column is not the same kind of figure every year.'}
            {basis !== 'net_assets' && ' A Tier 4 charity reports cash, so it has operating receipts and payments rather than revenue and expenses, and no net assets.'}
          </Caption1>
        </>
      ) : (
        <Body1 className={s.muted}>This charity has no published annual return of its own in the last 5 years.</Body1>
      )}
    </Panel>
  )
}

/** How its annual returns went, in a sentence: what the card says when there is no table to show. */
function returnsSummary(detail: IntelCharity, due: number, onTime: number): string {
  const late = due - onTime
  if (!due) {
    if (detail.inGroup) return 'Its group files annual returns for it, so none of its own was due.'
    // Registered too recently for its first balance date, and the 6 months after it, to have passed.
    const lastYear = detail.years.at(-1)?.fy ?? 0
    const isNew = detail.registered !== null && Number(detail.registered.slice(0, 4)) >= lastYear
    return isNew ? 'Its first annual return is not due yet.' : 'No annual return of its own was due in its last 5 years.'
  }
  if (due === 1) return `Its 1 annual return due in the last 5 years was ${onTime ? 'filed on time' : 'late or not filed'}.`
  if (!late) return `All ${due} of its annual returns due in the last 5 years were filed on time.`
  return `${onTime || 'None'} of its last ${due} annual returns ${onTime === 1 ? 'was' : 'were'} filed on time. ${late} ${late === 1 ? 'was' : 'were'} late or not filed.`
}

function Reporting({ intel, detail, row }: { intel: Intel; detail: IntelCharity; row: IntelRow }) {
  const s = useStyles()
  const judged = detail.years.filter((y) => ['on_time', 'late', 'missing'].includes(y.status))
  const onTime = judged.filter((y) => y.status === 'on_time').length
  // The year-by-year table only earns its room when a return was late or not filed. Then it
  // lists the years a return was due or filed, not the years none was.
  const showTable = onTime < judged.length
  const rows = detail.years.filter((y) => ['on_time', 'late', 'missing', 'processing'].includes(y.status))
  const latest = detail.years.findLast((y) => y.status === 'on_time' || y.status === 'late')
  const quality = detail.why.return_quality
  return (
    <Panel title="Annual returns" description={returnsSummary(detail, judged.length, onTime)}>
      {showTable && (
        <div className={s.tableBox}>
          <Table size="small" aria-label="Its annual returns year by year">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Year ended</TableHeaderCell>
                <TableHeaderCell>Due</TableHeaderCell>
                <TableHeaderCell>Filed</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((y) => (
                <TableRow key={y.fy}>
                  <TableCell>{y.ended ? showShort(y.ended) : y.fy}</TableCell>
                  <TableCell>{y.ended ? showShort(dueDate(y.ended)) : '—'}</TableCell>
                  <TableCell>{y.filed ? `${y.filedBasis === 'estimated' ? 'by ' : ''}${showShort(y.filed)}` : '—'}</TableCell>
                  <TableCell>
                    {y.status === 'late' || y.status === 'missing' ? (
                      <LevelBadge level={y.status === 'missing' ? 2 : 1}>{STATUS[y.status]}</LevelBadge>
                    ) : (
                      <span className={y.status === 'on_time' ? undefined : s.muted}>{STATUS[y.status]}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <dl className={s.facts}>
        {latest && (
          <Fact name="Audit or review of the latest annual return">
            {latest.audited ? 'Audited or reviewed' : latest.audited === false ? 'Not audited or reviewed' : 'Not stated'}
            {latest.modified ? ', with a modified opinion' : ''}
          </Fact>
        )}
        {row.values.return_quality !== null && (
          <Fact name="Totals on the latest annual return">{quality ?? 'The totals add up, and none is blank.'}</Fact>
        )}
        {detail.balance && (
          <Fact name="Balance date">
            {detail.balance[1]} {MONTHS[detail.balance[0] - 1]}
            {detail.registered ? `. Registered on ${showDay(detail.registered)}.` : ''}
          </Fact>
        )}
      </dl>
      {showTable ? (
        <Caption1 className={s.muted}>
          An annual return is due 6 months after the balance date. Here, late means filed more than {intel.meta.grace_days} days
          after the due date. The register does not publish the date a return was filed. A date starting with “by” is worked
          out from the order the register numbered the returns in, and is accurate to within a few days.
        </Caption1>
      ) : (
        judged.length > 0 && (
          <Caption1 className={s.muted}>
            An annual return is due 6 months after the balance date. Here, on time means filed within {intel.meta.grace_days} days
            of the due date.
          </Caption1>
        )
      )}
    </Panel>
  )
}

function Governance({ row, detail }: { row: IntelRow; detail: IntelCharity }) {
  const s = useStyles()
  const declared = detail.years.filter((y) => y.related !== null)
  const related = declared.filter((y) => y.related).length
  const board = detail.years.filter((y) => y.officers !== null)
  const shared = row.values.shared_boards
  return (
    <Panel title="Officers and governance">
      <div className={s.stats}>
        <Stat label="Current officers" value={row.officers ?? '—'} />
        <Stat label="Charities sharing an officer" value={shared ?? '—'} />
        <Stat
          label="Related party transactions"
          value={declared.length ? `${related} of ${declared.length}` : '—'}
          foot={declared.length ? 'years it reported some' : 'not asked on its returns'}
        />
      </div>
      {board.length > 0 && (
        <div className={s.tableBox}>
          <Table size="small" aria-label="Officers at each balance date">
            <TableHeader>
              <TableRow>
                <TableHeaderCell className={s.rowHead}>Year</TableHeaderCell>
                {board.map((y) => (
                  <TableHeaderCell key={y.fy}>{y.fy}</TableHeaderCell>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className={s.rowHead}>Officers at the balance date</TableCell>
                {board.map((y) => (
                  <TableCell key={y.fy}>{y.officers}</TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
      {detail.links.length > 0 && (
        <div className={s.block}>
          <Caption1Strong className={s.factName}>Charities with a current officer of the same name</Caption1Strong>
          <ul className={s.list}>
            {detail.links.map((l) => (
              <li key={l.cc}>
                <CharityLink cc={l.cc}>{l.name}</CharityLink>{' '}
                <Caption1 className={s.muted}>
                  {l.shared} {l.shared === 1 ? 'name' : 'names'} in common
                </Caption1>
              </li>
            ))}
          </ul>
          <Caption1 className={s.muted}>
            {(shared ?? 0) > detail.links.length && `These are the ${detail.links.length} with the most names in common, of ${shared}. `}
            This matches names only. The register has no identifier for a person, so the same name may be 2 different people.
          </Caption1>
        </div>
      )}
    </Panel>
  )
}

function Purpose({ detail, row }: { detail: IntelCharity; row: IntelRow }) {
  const s = useStyles()
  const overseas = row.values.overseas_share
  return (
    <Panel title="Purpose and beneficiaries" description="What the charity has told the Charities Register.">
      <dl className={s.facts}>
        {detail.purpose && <Fact name="Charitable purpose">{detail.purpose}</Fact>}
        <Fact name="Main activity">{detail.activity ?? '—'}</Fact>
        <Fact name="Main beneficiary">{detail.beneficiary ?? '—'}</Fact>
        <Fact name="Areas of operation">{detail.areas.length ? detail.areas.join('; ') : '—'}</Fact>
        <Fact name="Funds spent overseas">
          {overseas === null ? '—' : overseas > 0 ? `${Math.round(overseas * 100)}% of its funds, as it reports` : 'None reported'}
        </Fact>
      </dl>
    </Panel>
  )
}

function Checks({ detail }: { detail: IntelCharity }) {
  const s = useStyles()
  const navigate = useNavigate()
  return (
    <Panel
      title="Annual return checks"
      description="What the weekly checks of its annual returns found."
      action={
        <Button appearance="secondary" onClick={() => navigate('/admin/returns')}>
          See all checks
        </Button>
      }
    >
      <ul className={s.list}>
        {detail.checks.map((c) => (
          <li key={c.check}>
            <Body1>{c.summary}</Body1>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function Measures({ intel, row, detail }: { intel: Intel; row: IntelRow; detail: IntelCharity | null }) {
  const s = useStyles()
  const inTier = intel.rows.filter((r) => r.band === row.band).length
  return (
    <Panel
      title={row.band ? `How it compares with other ${bandName(row.band)} charities` : 'Its figures'}
      description={
        row.band
          ? `Each figure, and where it sits among the ${inTier.toLocaleString('en-NZ')} charities in ${bandName(row.band)} (${BAND_RANGE[row.band]}).`
          : 'With no annual return in the last 5 years there is little to measure.'
      }
      action={<MeasureGuide intel={intel} />}
      foot="Not measured: the share of expenses that goes on administration, and the size of related party transactions. Neither is in the register's public data. Both are in a charity's financial statements."
    >
      <div className={s.tableBox}>
        <Table aria-label="Its figures compared with its reporting tier" className={s.measures}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Measure</TableHeaderCell>
              <TableHeaderCell className={s.valueCol} button={{ className: s.numberHead }}>
                This charity
              </TableHeaderCell>
              <TableHeaderCell className={s.barCol}>
                <span className={s.scaleEnds}>
                  <span>Lowest</span>
                  <span>Highest</span>
                </span>
              </TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {GROUP_ORDER.map((g) => (
              <Fragment key={g}>
                <TableRow className={s.groupRow}>
                  <TableCell colSpan={3}>
                    <Body1Strong>{GROUPS[g]}</Body1Strong>
                  </TableCell>
                </TableRow>
                {MEASURES.filter((m) => m.group === g).map((m) => (
                  <MeasureRows key={m.key} intel={intel} row={row} info={m} why={detail && isSignal(intel.meta, m.key) ? detail.why[m.key] : undefined} />
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  )
}

function MeasureRows({ intel, row, info, why }: { intel: Intel; row: IntelRow; info: MeasureInfo; why: string | undefined }) {
  const s = useStyles()
  const value = row.values[info.key]
  const signal = isSignal(intel.meta, info.key) ? info.key : null
  const lv: Level = signal ? row.levels[signal] : 0
  const rule = signal ? intel.meta.signals[signal] : null
  // Where its figure sits among charities in its tier: the share of them below it.
  const sorted = peers(intel, info.key, row.band)
  const share = value === null || sorted.length < 20 ? null : shareBelow(sorted, value)
  const where = standing(intel, row, info.key)
  // Over the line, but something else that must hold doesn't: say so, so the figure isn't a puzzle.
  const notCounted = lv === 0 && signal && value !== null && rule && levelOf(rule, value) > 0 ? ruleCondition(intel.meta, signal) : null
  const note = lv > 0 && signal ? `${why ? `${why} ` : ''}${ruleText(intel.meta, signal)}` : notCounted ? `Not counted as a signal. ${notCounted}` : null
  const tint = lv === 2 ? s.priority : lv === 1 ? s.look : undefined
  return (
    <>
      <TableRow className={mergeClasses(tint, note ? s.joined : undefined)}>
        <TableCell>
          <div className={s.measureName}>
            <span>{info.title}</span>
            <Caption1 className={s.muted}>{where}</Caption1>
          </div>
        </TableCell>
        <TableCell>
          <span className={s.value}>
            {value === null ? <span className={s.muted}>—</span> : lv ? <LevelBadge level={lv}>{info.format(value)}</LevelBadge> : info.format(value)}
          </span>
        </TableCell>
        <TableCell>
          <PositionBar share={share} level={lv} label={`${info.title}: ${value === null ? 'no figure' : info.format(value)}. ${where}.`} />
        </TableCell>
      </TableRow>
      {note && (
        <TableRow className={tint}>
          <TableCell colSpan={3} className={s.why}>
            <Caption1>{note}</Caption1>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
