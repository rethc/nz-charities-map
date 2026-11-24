import {
  Body1,
  Button,
  Caption1,
  Card,
  Link,
  makeStyles,
  mergeClasses,
  MessageBar,
  MessageBarBody,
  SearchBox,
  Spinner,
  Subtitle2,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Title2,
  tokens,
} from '@fluentui/react-components'
import { ArrowDown12Filled, ArrowUp12Filled, Location16Regular, Open16Regular } from '@fluentui/react-icons'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { registerUrl } from '../../../lib/charities'
import {
  bandName,
  BAND_RANGE,
  dollars,
  GROUPS,
  isSignal,
  levelOf,
  loadCharity,
  MEASURES,
  money,
  peers,
  ruleText,
  searchIntel,
  shareBelow,
  standing,
  type Group,
  type Intel,
  type IntelCharity,
  type IntelRow,
  type IntelYear,
  type Level,
  type MeasureInfo,
  type YearStatus,
} from '../../../lib/intel'
import { Legend, LEVEL_COLOUR, LineChart, PositionBar, SERIES } from './charts'
import { CharityLink } from './Overview'
import { charityPath, LevelBadge, showDay } from './shell'

/** One charity: its last five years, its board, its returns, and each measure against charities of its size. */

const GROUP_ORDER: Group[] = ['money', 'activity', 'governance', 'reporting']
const shortDate = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const showShort = (iso: string) => shortDate.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`))
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const STATUS: Record<YearStatus, string> = {
  on_time: 'On time',
  late: 'Late',
  missing: 'Not filed',
  processing: 'Being processed',
  group: 'Filed by its group',
  unknown: 'Not in the data',
  none: 'None due',
}

/** A return is due 6 months after the year ends; a month's last day stays a month's last day. */
function dueDate(ended: string): string {
  const [y, m, d] = ended.slice(0, 10).split('-').map(Number) as [number, number, number]
  const monthEnd = d === new Date(Date.UTC(y, m, 0)).getUTCDate()
  const last = new Date(Date.UTC(y, m + 6, 0)).getUTCDate()
  return new Date(Date.UTC(y, m - 1 + 6, monthEnd ? last : Math.min(d, last))).toISOString().slice(0, 10)
}

const useStyles = makeStyles({
  find: { display: 'grid', gap: '4px', position: 'relative', maxWidth: '34rem' },
  search: { width: '100%', maxWidth: 'none' },
  results: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 5,
    marginTop: '4px',
    padding: '4px',
    display: 'grid',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow16,
  },
  result: {
    display: 'grid',
    gap: '0',
    padding: '6px 10px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    textAlign: 'start',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
  },
  resultOn: { backgroundColor: tokens.colorNeutralBackground1Hover },
  muted: { color: tokens.colorNeutralForeground3 },
  header: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px 24px' },
  headText: { display: 'grid', gap: '4px', minWidth: 0 },
  headLinks: { display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: '4px' },
  verdict: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    alignItems: 'center',
    gap: '2px 12px',
    padding: '10px 16px',
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderInlineStartWidth: '4px',
    maxWidth: '24rem',
  },
  verdictNumber: { gridRow: '1 / span 2', fontSize: tokens.fontSizeHero800, lineHeight: tokens.lineHeightHero800, fontWeight: tokens.fontWeightSemibold },
  verdictTitle: { fontWeight: tokens.fontWeightSemibold },
  layout: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', alignItems: 'start', gap: '16px', '@media (max-width: 1180px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
  column: { display: 'grid', gap: '16px', minWidth: 0 },
  card: { display: 'grid', gap: '12px', alignContent: 'start', minWidth: 0 },
  cardTitle: { display: 'grid', gap: '2px' },
  tableBox: { overflowX: 'auto', minWidth: 0 },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  move: { display: 'inline-flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(8.5rem, 1fr))', gap: '8px' },
  tile: { display: 'grid', gap: '2px', padding: '10px 12px', borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  tileValue: { fontSize: tokens.fontSizeBase600, lineHeight: tokens.lineHeightBase600, fontWeight: tokens.fontWeightSemibold },
  label: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, lineHeight: tokens.lineHeightBase200, fontWeight: tokens.fontWeightSemibold },
  years: { display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(0, 1fr)', gap: '4px' },
  year: { display: 'grid', gap: '4px', justifyItems: 'center', textAlign: 'center' },
  facts: { display: 'grid', gap: '10px' },
  fact: { display: 'grid', gap: '2px', paddingTop: '8px', borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
  links: { display: 'grid', gap: '4px', margin: 0, padding: 0, listStyleType: 'none' },
  group: { padding: '6px 12px', backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusMedium, fontWeight: tokens.fontWeightSemibold },
  measure: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.3fr) 7.5rem minmax(6rem, 1fr)',
    alignItems: 'center',
    gap: '4px 16px',
    padding: '8px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    '@media (max-width: 560px)': { gridTemplateColumns: 'minmax(0, 1fr) auto' },
  },
  scale: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.3fr) 7.5rem minmax(6rem, 1fr)',
    gap: '4px 16px',
    padding: '0 12px',
    color: tokens.colorNeutralForeground3,
    '@media (max-width: 560px)': { display: 'none' },
  },
  scaleEnds: { display: 'flex', justifyContent: 'space-between', gap: '8px' },
  measureLook: { backgroundColor: '#fdf3e2' },
  measurePriority: { backgroundColor: '#fbeae9' },
  measureName: { display: 'grid', gap: '0' },
  measureValue: { justifySelf: 'end', fontVariantNumeric: 'tabular-nums', fontWeight: tokens.fontWeightSemibold },
  strip: { '@media (max-width: 560px)': { gridColumn: '1 / -1' } },
  why: { gridColumn: '1 / -1', color: tokens.colorNeutralForeground2 },
  center: { display: 'grid', placeItems: 'center', minHeight: '200px' },
  empty: { display: 'grid', gap: '8px', justifyItems: 'start', padding: '8px 0' },
})

export function Charity({ intel }: { intel: Intel }) {
  const s = useStyles()
  const { cc: param } = useParams()
  const cc = param?.trim().toUpperCase() ?? null
  const row = cc ? (intel.byCc.get(cc) ?? null) : null

  return (
    <>
      <Finder intel={intel} />
      {!cc ? (
        <Card className={s.card}>
          <div className={s.empty}>
            <Subtitle2 as="h2">Find a charity</Subtitle2>
            <Body1 className={s.muted}>
              Search by name or CC number for its last five years, its board, its returns, and how each measure sits among
              charities of its size. Or open one from the watchlist.
            </Body1>
          </div>
        </Card>
      ) : !row ? (
        <MessageBar intent="info">
          <MessageBarBody>
            No registered charity has the number {cc}. It may have been deregistered, or be a registered group: groups aren't
            measured.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <Profile key={row.cc} intel={intel} row={row} />
      )}
    </>
  )
}

/** Search by name or CC number, with the best matches listed underneath. */
function Finder({ intel }: { intel: Intel }) {
  const s = useStyles()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const results = useMemo(() => searchIntel(intel.rows, query), [intel, query])
  const go = (r: IntelRow) => {
    setQuery('')
    setOpen(false)
    navigate(charityPath(r.cc))
  }
  return (
    <div className={s.find} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <SearchBox
        className={s.search}
        size="large"
        placeholder="Find a charity by name or CC number"
        aria-label="Find a charity by name or CC number"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="intel-results"
        autoComplete="off"
        value={query}
        onChange={(_, d) => {
          setQuery(d.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
            setActive((i) => (results.length ? (i + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0))
          } else if (e.key === 'Enter' && results[active]) {
            e.preventDefault()
            go(results[active])
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {open && results.length > 0 && (
        <div className={s.results} id="intel-results" role="listbox" aria-label="Matching charities">
          {results.map((r, i) => (
            <button
              key={r.cc}
              type="button"
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              className={mergeClasses(s.result, i === active && s.resultOn)}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
            >
              <span>{r.name}</span>
              <Caption1 className={s.muted}>{[r.cc, bandName(r.band), r.sector].filter(Boolean).join(' · ')}</Caption1>
            </button>
          ))}
        </div>
      )}
      {open && query.trim().length >= 2 && !results.length && (
        <div className={s.results}>
          <Body1 className={s.muted} style={{ padding: '6px 10px' }}>
            No registered charity matches.
          </Body1>
        </div>
      )}
    </div>
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

  // Where its count of signals sits among charities of its size.
  const signalStanding = useMemo(() => {
    const sorted = intel.rows.filter((r) => r.band === row.band).map((r) => r.signals).sort((a, b) => a - b)
    return sorted.length >= 20 ? Math.floor(shareBelow(sorted, row.signals) * 100) : null
  }, [intel, row])
  const top: Level = row.priority ? 2 : row.signals ? 1 : 0

  return (
    <>
      <div className={s.header}>
        <div className={s.headText}>
          <Caption1 className={s.label}>Charity · {row.cc}</Caption1>
          <Title2 as="h2">{row.name}</Title2>
          <Body1 className={s.muted}>
            {[
              row.tier ? `Files as Tier ${row.tier}` : 'No tier on its return',
              row.sector,
              row.officers === null ? null : `${row.officers} ${row.officers === 1 ? 'officer' : 'officers'}`,
              income === null ? null : `${money(income)} income`,
              detail?.city,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Body1>
          <div className={s.headLinks}>
            <Link href={registerUrl(row.cc)} target="_blank" rel="noopener noreferrer">
              Charities Register <Open16Regular style={{ verticalAlign: 'text-bottom' }} />
            </Link>
            {detail?.onMap && (
              <Link href={`/?cc=${encodeURIComponent(row.cc)}`}>
                <Location16Regular style={{ verticalAlign: 'text-bottom' }} /> On the map
              </Link>
            )}
          </div>
        </div>
        <div className={s.verdict} style={{ borderInlineStartColor: LEVEL_COLOUR[top] }}>
          <span className={s.verdictNumber}>{row.signals}</span>
          <span className={s.verdictTitle}>
            {row.signals === 1 ? 'signal' : 'signals'} worth a look{row.priority ? `, ${row.priority} at priority` : ''}
          </span>
          <Caption1 className={s.muted}>
            {row.band
              ? signalStanding !== null && row.signals > 0
                ? `More than ${signalStanding}% of ${bandName(row.band)} charities (${BAND_RANGE[row.band]})`
                : `Compared with ${bandName(row.band)} charities: ${BAND_RANGE[row.band]}`
              : 'No return in the last five years to judge its size by'}
          </Caption1>
        </div>
      </div>

      {detail?.note && (
        <MessageBar intent="info">
          <MessageBarBody>{detail.note}</MessageBarBody>
        </MessageBar>
      )}
      {row.tier !== null && row.band > 0 && row.tier !== row.band && (
        <MessageBar intent="info">
          <MessageBarBody>
            Its latest return is filed as Tier {row.tier}, but it spent {row.spend === null ? 'an amount' : money(row.spend)} that
            year, which is {bandName(row.band).toLowerCase()} ({BAND_RANGE[row.band]}). It is compared with charities of its size.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.layout}>
        <div className={s.column}>
          {load.status === 'loading' && (
            <Card className={s.card}>
              <div className={s.center}>
                <Spinner label="Loading its last five years…" />
              </div>
            </Card>
          )}
          {load.status === 'error' && (
            <MessageBar intent="error">
              <MessageBarBody>Couldn't load its years: {load.message}</MessageBarBody>
            </MessageBar>
          )}
          {load.status === 'ready' && !detail && (
            <MessageBar intent="info">
              <MessageBarBody>Its year-by-year figures aren't in the latest run. They will be after the next one.</MessageBarBody>
            </MessageBar>
          )}
          {detail && (
            <>
              <Trend years={detail.years} />
              <Governance row={row} detail={detail} />
              <Reporting intel={intel} detail={detail} row={row} />
              <Purpose detail={detail} row={row} />
              {detail.checks.length > 0 && <Checks detail={detail} />}
            </>
          )}
        </div>
        <Measures intel={intel} row={row} detail={detail} />
      </div>
    </>
  )
}

function Trend({ years }: { years: IntelYear[] }) {
  const s = useStyles()
  const basis = years.findLast((y) => y.fundsBasis)?.fundsBasis ?? 'net_assets'
  const fundsLabel = basis === 'cash' ? 'Cash held' : basis === 'resources' ? 'Resources less commitments' : 'Net assets'
  const mixed = new Set(years.map((y) => y.fundsBasis).filter(Boolean)).size > 1
  const has = years.some((y) => y.income !== null || y.spend !== null || y.funds !== null)
  const moved = (now: number | null, before: number | null | undefined) =>
    now === null || before == null || now === before ? null : now > before ? 'up' : 'down'
  const cell = (now: number | null, before: number | null | undefined) => {
    if (now === null) return '—'
    const move = moved(now, before)
    return (
      <span className={s.move}>
        {move === 'up' && <ArrowUp12Filled aria-label="up on the year before" style={{ color: tokens.colorNeutralForeground3 }} />}
        {move === 'down' && <ArrowDown12Filled aria-label="down on the year before" style={{ color: tokens.colorNeutralForeground3 }} />}
        {dollars(now)}
      </span>
    )
  }
  return (
    <Card className={s.card}>
      <div className={s.cardTitle}>
        <Subtitle2 as="h3">Five-year financial trend</Subtitle2>
        <Body1 className={s.muted}>As declared on its annual returns.</Body1>
      </div>
      {has ? (
        <>
          <Legend
            items={[
              { label: 'Income', colour: SERIES.income },
              { label: 'Spending', colour: SERIES.spend },
              { label: fundsLabel, colour: SERIES.funds },
            ]}
          />
          <LineChart
            years={years.map((y) => y.fy)}
            format={money}
            tick={money}
            label={`Income, spending and ${fundsLabel.toLowerCase()} for each of its last five years`}
            series={[
              { key: 'income', label: 'Income', colour: SERIES.income, values: years.map((y) => y.income) },
              { key: 'spend', label: 'Spending', colour: SERIES.spend, values: years.map((y) => y.spend) },
              { key: 'funds', label: fundsLabel, colour: SERIES.funds, values: years.map((y) => y.funds) },
            ]}
          />
          <div className={s.tableBox}>
            <Table size="small" aria-label="Its figures year by year">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Year</TableHeaderCell>
                  <TableHeaderCell className={s.number}>Income</TableHeaderCell>
                  <TableHeaderCell className={s.number}>Spending</TableHeaderCell>
                  <TableHeaderCell className={s.number}>{fundsLabel}</TableHeaderCell>
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
            Arrows compare with the year before. “—” is a figure the return left blank, or a year with no published return.
            {mixed && ' Its returns changed between tiers, so the last column is not on one basis throughout.'}
            {basis !== 'net_assets' && ' A Tier 4 return is a statement of cash, with no net assets.'}
          </Caption1>
        </>
      ) : (
        <Body1 className={s.muted}>No published return of its own in the last five years.</Body1>
      )}
    </Card>
  )
}

function Governance({ row, detail }: { row: IntelRow; detail: IntelCharity }) {
  const s = useStyles()
  const declared = detail.years.filter((y) => y.related !== null)
  const related = declared.filter((y) => y.related).length
  const board = detail.years.filter((y) => y.officers !== null)
  return (
    <Card className={s.card}>
      <Subtitle2 as="h3">Governance</Subtitle2>
      <div className={s.tiles}>
        <div className={s.tile}>
          <Caption1 className={s.muted}>Officers now</Caption1>
          <span className={s.tileValue}>{row.officers ?? '—'}</span>
        </div>
        <div className={s.tile}>
          <Caption1 className={s.muted}>Boards shared</Caption1>
          <span className={s.tileValue}>{row.values.shared_boards ?? '—'}</span>
        </div>
        <div className={s.tile}>
          <Caption1 className={s.muted}>Related-party transactions</Caption1>
          <span className={s.tileValue}>{declared.length ? `${related} of ${declared.length}` : '—'}</span>
          <Caption1 className={s.muted}>{declared.length ? 'years it declared some' : 'not asked on its returns'}</Caption1>
        </div>
      </div>
      {board.length > 0 && (
        <div>
          <div className={s.label}>Officers on the board at each year end</div>
          <div className={s.years} style={{ marginTop: '6px' }}>
            {board.map((y) => (
              <div key={y.fy} className={s.year}>
                <span className={s.tileValue}>{y.officers}</span>
                <Caption1 className={s.muted}>{y.fy}</Caption1>
              </div>
            ))}
          </div>
        </div>
      )}
      {detail.links.length > 0 && (
        <div>
          <div className={s.label}>Charities with an officer of the same name</div>
          <ul className={s.links} style={{ marginTop: '6px' }}>
            {detail.links.map((l) => (
              <li key={l.cc}>
                <CharityLink cc={l.cc}>{l.name}</CharityLink>{' '}
                <Caption1 className={s.muted}>
                  {l.shared} {l.shared === 1 ? 'name' : 'names'} in common
                </Caption1>
              </li>
            ))}
          </ul>
          <Caption1 className={s.muted} style={{ display: 'block', marginTop: '6px' }}>
            {(row.values.shared_boards ?? 0) > detail.links.length && `The ${detail.links.length} with the most names in common, of ${row.values.shared_boards}. `}
            Names only: the register has no id for a person, so one name in common may be two people.
          </Caption1>
        </div>
      )}
    </Card>
  )
}

function Reporting({ intel, detail, row }: { intel: Intel; detail: IntelCharity; row: IntelRow }) {
  const s = useStyles()
  const judged = detail.years.filter((y) => ['on_time', 'late', 'missing'].includes(y.status))
  const onTime = judged.filter((y) => y.status === 'on_time').length
  const latest = detail.years.findLast((y) => y.status === 'on_time' || y.status === 'late')
  const quality = detail.why.return_quality
  return (
    <Card className={s.card}>
      <Subtitle2 as="h3">Reporting history</Subtitle2>
      <Body1>
        {judged.length
          ? `${onTime} of ${judged.length} returns on time in its last five years${onTime < judged.length ? `; ${judged.length - onTime} late or not filed` : ''}.`
          : 'No return of its own was due in its last five years.'}
      </Body1>
      <div className={s.tableBox}>
        <Table size="small" aria-label="Its returns year by year">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Year ended</TableHeaderCell>
              <TableHeaderCell>Due</TableHeaderCell>
              <TableHeaderCell>Filed</TableHeaderCell>
              <TableHeaderCell>Return</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.years.map((y) => (
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
      <div className={s.facts}>
        {latest && (
          <div className={s.fact}>
            <span className={s.label}>Latest return</span>
            <span>Year ended {showDay(latest.ended)}</span>
          </div>
        )}
        {latest && (
          <div className={s.fact}>
            <span className={s.label}>Audit or review</span>
            <span>
              {latest.audited ? 'Audited or reviewed' : latest.audited === false ? 'Not audited or reviewed' : 'Not stated on the return'}
              {latest.modified ? ', with a modified opinion' : ''}
            </span>
          </div>
        )}
        <div className={s.fact}>
          <span className={s.label}>The return's totals</span>
          <span>{quality ?? (row.values.return_quality === null ? 'No published return to check.' : 'The totals on its latest return add up, and none is blank.')}</span>
        </div>
        {detail.balance && (
          <div className={s.fact}>
            <span className={s.label}>Balance date</span>
            <span>
              {detail.balance[1]} {MONTHS[detail.balance[0] - 1]}
              {detail.registered ? `. Registered ${showDay(detail.registered)}` : ''}
            </span>
          </div>
        )}
      </div>
      <Caption1 className={s.muted}>
        Late: filed more than {intel.meta.grace_days} days after the due date. The register doesn't publish when a return arrived:
        “by” dates are worked out from the order it numbered returns in, and are right to within a few days.
      </Caption1>
    </Card>
  )
}

function Purpose({ detail, row }: { detail: IntelCharity; row: IntelRow }) {
  const s = useStyles()
  const overseas = row.values.overseas_share
  const facts: [string, string | null][] = [
    ['Main activity', detail.activity],
    ['Main beneficiary', detail.beneficiary],
    ['Areas of operation', detail.areas.length ? detail.areas.join('; ') : null],
    ['Spending overseas', overseas === null ? null : overseas > 0 ? `${Math.round(overseas * 100)}% of its spending, as it declares` : 'None declared'],
  ]
  return (
    <Card className={s.card}>
      <Subtitle2 as="h3">Purpose and beneficiaries</Subtitle2>
      {detail.purpose && <Body1>{detail.purpose}</Body1>}
      <div className={s.facts}>
        {facts.map(([label, value]) => (
          <div key={label} className={s.fact}>
            <span className={s.label}>{label}</span>
            <span>{value ?? '—'}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function Checks({ detail }: { detail: IntelCharity }) {
  const s = useStyles()
  const navigate = useNavigate()
  return (
    <Card className={s.card}>
      <div className={s.cardTitle}>
        <Subtitle2 as="h3">Annual return checks</Subtitle2>
        <Body1 className={s.muted}>What the weekly checks of its returns found.</Body1>
      </div>
      <ul className={s.links}>
        {detail.checks.map((c) => (
          <li key={c.check}>
            <Body1>{c.summary}</Body1>
          </li>
        ))}
      </ul>
      <div>
        <Button appearance="secondary" onClick={() => navigate('/admin/returns')}>
          Annual return checks
        </Button>
      </div>
    </Card>
  )
}

function Measures({ intel, row, detail }: { intel: Intel; row: IntelRow; detail: IntelCharity | null }) {
  const s = useStyles()
  return (
    <Card className={s.card}>
      <div className={s.cardTitle}>
        <Subtitle2 as="h3">Measures against charities of its size</Subtitle2>
        <Body1 className={s.muted}>
          {row.band
            ? `Its figure, and where it sits among the ${intel.rows.filter((r) => r.band === row.band).length.toLocaleString('en-NZ')} ${bandName(row.band)} charities.`
            : 'With no return in the last five years there is little to measure.'}
        </Body1>
      </div>
      <div className={s.scale} aria-hidden="true">
        <span />
        <span />
        <span className={s.scaleEnds}>
          <Caption1>Lowest</Caption1>
          <Caption1>Among charities of its size</Caption1>
          <Caption1>Highest</Caption1>
        </span>
      </div>
      <div>
        {GROUP_ORDER.map((g) => (
          <div key={g}>
            <div className={s.group}>{GROUPS[g]}</div>
            {MEASURES.filter((m) => m.group === g).map((m) => (
              <MeasureRow key={m.key} intel={intel} row={row} info={m} why={detail && isSignal(intel.meta, m.key) ? detail.why[m.key] : undefined} />
            ))}
          </div>
        ))}
      </div>
      <Caption1 className={s.muted}>
        Not measured: the share of spending on administration, and the size of related-party transactions. Neither is in the
        register's public data; both are in the financial statements.
      </Caption1>
    </Card>
  )
}

function MeasureRow({ intel, row, info, why }: { intel: Intel; row: IntelRow; info: MeasureInfo; why: string | undefined }) {
  const s = useStyles()
  const value = row.values[info.key]
  const signal = isSignal(intel.meta, info.key) ? info.key : null
  const lv: Level = signal ? row.levels[signal] : 0
  const rule = signal ? intel.meta.signals[signal] : null
  // Where its figure sits among charities of its size: the share of them below it.
  const sorted = peers(intel, info.key, row.band)
  const share = value === null || sorted.length < 20 ? null : shareBelow(sorted, value)
  const where = standing(intel, row, info.key)
  return (
    <div className={mergeClasses(s.measure, lv === 1 && s.measureLook, lv === 2 && s.measurePriority)}>
      <div className={s.measureName}>
        <span title={info.description}>{info.title}</span>
        <Caption1 className={s.muted}>{where}</Caption1>
      </div>
      <span className={s.measureValue}>
        {value === null ? <span className={s.muted}>—</span> : lv ? <LevelBadge level={lv}>{info.format(value)}</LevelBadge> : info.format(value)}
      </span>
      <div className={s.strip}>
        <PositionBar share={share} level={lv} label={`${info.title}: ${value === null ? 'no figure' : info.format(value)}. ${where}.`} />
      </div>
      {lv > 0 && signal && (
        <Body1 className={s.why}>
          {why ? `${why} ` : ''}
          <span className={s.muted}>{ruleText(intel.meta, signal)}</span>
        </Body1>
      )}
      {lv === 0 && signal && value !== null && rule && levelOf(rule, value) > 0 && (
        <Caption1 className={s.why}>
          Over the line, but not counted: {ruleText(intel.meta, signal).replace(/^.*?, (?=where|with)/, 'it counts ').replace(/\.$/, '')}.
        </Caption1>
      )}
    </div>
  )
}
