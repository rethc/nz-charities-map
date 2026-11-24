import {
  Body1,
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
  Field,
  makeStyles,
  MenuGroup,
  MenuGroupHeader,
  MenuItemRadio,
  MenuList,
  SearchBox,
  Select,
  Subtitle1,
  tokens,
  type LabelProps,
  type TableColumnDefinition,
  type TableColumnId,
} from '@fluentui/react-components'
import { ArrowDownload20Regular, Search24Regular } from '@fluentui/react-icons'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useSearchParams } from 'react-router'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import { formatCount } from '../../../lib/dom'
import {
  bandName,
  BAND_RANGE,
  BANDS,
  GROUP_ORDER,
  GROUPS,
  isSignal,
  LEVEL_NAME,
  MEASURE,
  MEASURES,
  money,
  quantile,
  ruleText,
  TIER_MEANS,
  type Intel,
  type IntelRow,
  type Level,
  type MeasureKey,
} from '../../../lib/intel'
import { fold } from '../../../lib/search'
import { CharityLink } from './Overview'
import { EmptyState, HelpLabel, LevelBadge, MeasureGuide, SignalChips, Stat } from './shell'

/** Every charity ranked by one measure, or by how many signals it has. */

type Pick = MeasureKey | 'combined'
type Sort = { sortColumn: TableColumnId | undefined; sortDirection: 'ascending' | 'descending' }
/** A charity with its place in the list as sorted. */
interface Ranked {
  row: IntelRow
  rank: number
}

const PAGE = 100
const COMBINED = 'All signals combined'

const useStyles = makeStyles({
  layout: {
    display: 'grid',
    gridTemplateColumns: '19rem minmax(0, 1fr)',
    alignItems: 'start',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  rail: { padding: tokens.spacingVerticalS },
  railNote: { color: tokens.colorNeutralForeground3, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} ${tokens.spacingVerticalXS}` },
  main: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: tokens.spacingVerticalL, minWidth: 0 },
  card: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: tokens.spacingVerticalM, alignContent: 'start', minWidth: 0 },
  headText: { display: 'grid', gap: tokens.spacingVerticalXS, maxWidth: '88ch' },
  muted: { color: tokens.colorNeutralForeground3 },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 13rem), 1fr))', gap: tokens.spacingHorizontalM },
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}` },
  field: { minWidth: '11rem' },
  search: { minWidth: 'min(100%, 16rem)', flex: '1 1 16rem', maxWidth: '22rem' },
  commands: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, marginLeft: 'auto' },
  gridBox: {
    overflow: 'auto',
    maxHeight: 'min(76vh, 64rem)',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  gridHead: { position: 'sticky', top: 0, zIndex: 2, backgroundColor: tokens.colorNeutralBackground1, boxShadow: `0 1px 0 ${tokens.colorNeutralStroke2}` },
  rank: { color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  name: { display: 'grid', gap: tokens.spacingVerticalXXS, padding: `${tokens.spacingVerticalS} 0`, minWidth: 0 },
  number: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  chips: { padding: `${tokens.spacingVerticalS} 0` },
  end: { height: '1px' },
})

/** Column widths, as on the annual return checks: names and signals share the spare room. `min` is in px. */
const COLUMN: Record<string, { grow: number; min: number }> = {
  rank: { grow: 0, min: 48 },
  name: { grow: 3, min: 220 },
  income: { grow: 0, min: 104 },
  value: { grow: 0, min: 176 },
  signals: { grow: 3, min: 260 },
}
const CELL_PADDING = 16
function columnStyle(id: TableColumnId): CSSProperties {
  const { grow, min } = COLUMN[String(id)] ?? { grow: 1, min: 120 }
  return { flex: grow ? `${grow} 1 0` : `0 0 ${min + CELL_PADDING}px`, minWidth: min + CELL_PADDING }
}

function csvCell(value: string | number | null) {
  const text = value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function Watchlist({ intel }: { intel: Intel }) {
  const s = useStyles()
  const { meta } = intel
  const stacked = useMediaQuery('(max-width: 1100px)')
  const narrow = useMediaQuery('(max-width: 900px)')
  const compact = useMediaQuery('(max-width: 640px)')
  const [params, setParams] = useSearchParams()

  const pick: Pick = MEASURES.find((m) => m.key === params.get('m'))?.key ?? 'combined'
  const info = pick === 'combined' ? null : MEASURE[pick]
  const signal = info && isSignal(meta, info.key) ? info.key : null
  const rule = signal ? meta.signals[signal] : null
  const levelled = pick === 'combined' || signal !== null
  const tier = BANDS.find((b) => String(b) === params.get('tier')) ?? null
  const sector = meta.sectors.includes(params.get('sector') ?? '') ? params.get('sector') : null
  const atLeast: Level = !levelled ? 0 : params.get('show') === '2' && signal ? 2 : params.get('show') ? 1 : 0
  const query = params.get('q') ?? ''

  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  // The order last chosen for each measure: a signal where low is unusual starts lowest first.
  const [sorts, setSorts] = useState<Partial<Record<Pick, Sort>>>({})
  const lowFirst = Boolean(rule?.low)
  const sort = useMemo<Sort>(() => sorts[pick] ?? { sortColumn: 'value', sortDirection: lowFirst ? 'ascending' : 'descending' }, [sorts, pick, lowFirst])

  /** Charities in the tier and sector picked: what the figures above the list describe. */
  const scoped = useMemo(
    () => intel.rows.filter((r) => (!tier || r.band === tier) && (!sector || r.sector === sector)),
    [intel, tier, sector],
  )
  const valueOf = useMemo(() => (pick === 'combined' ? (r: IntelRow) => r.signals : (r: IntelRow) => r.values[pick]), [pick])
  const levelFor = useMemo(
    () => (r: IntelRow): Level => (pick === 'combined' ? (r.signals >= meta.combined_threshold ? 1 : 0) : signal ? r.levels[signal] : 0),
    [pick, signal, meta],
  )
  const withValue = useMemo(() => scoped.filter((r) => valueOf(r) !== null), [scoped, valueOf])

  const listed = useMemo<Ranked[]>(() => {
    const q = fold(query.trim())
    const bySignals = (a: IntelRow, b: IntelRow) => a.signals - b.signals || a.priority - b.priority
    const compare: Record<string, (a: IntelRow, b: IntelRow) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      income: (a, b) => (a.values.income ?? 0) - (b.values.income ?? 0),
      value: pick === 'combined' ? bySignals : (a, b) => valueOf(a)! - valueOf(b)!,
      signals: bySignals,
    }
    const column = String(sort.sortColumn)
    const by = compare[column] ?? compare.value!
    const sign = sort.sortDirection === 'ascending' ? 1 : -1
    // A charity with no revenue to sort by goes last, whichever way the column is sorted.
    const blank = (r: IntelRow) => (column === 'income' && r.values.income === null ? 1 : 0)
    return withValue
      .filter((r) => levelFor(r) >= atLeast && (!q || r.nameKey.includes(q) || r.cc.toLowerCase().includes(q)))
      .sort((a, b) => blank(a) - blank(b) || sign * by(a, b) || (b.values.income ?? 0) - (a.values.income ?? 0))
      .map((row, i) => ({ row, rank: i + 1 }))
  }, [withValue, query, atLeast, sort, pick, levelFor, valueOf])

  const title = info ? info.title : COMBINED
  const format = useMemo(() => (info ? info.format : (v: number) => `${formatCount(v)} ${v === 1 ? 'signal' : 'signals'}`), [info])

  /** The figures above the list: how many the signal picks out, and what a usual figure is. */
  const stats = useMemo(() => {
    const share = (n: number) => (scoped.length ? `${((n / scoped.length) * 100).toFixed(1)}% of ${formatCount(scoped.length)} charities` : '')
    if (pick === 'combined') {
      const on = scoped.filter((r) => r.signals >= meta.combined_threshold).length
      const more = scoped.filter((r) => r.signals > meta.combined_threshold).length
      const high = scoped.filter((r) => r.priority > 0).length
      return [
        { label: `On the watchlist (${meta.combined_threshold} or more signals)`, value: formatCount(on), foot: share(on), level: 1 as Level },
        { label: `${meta.combined_threshold + 1} or more signals`, value: formatCount(more), foot: 'a shorter list to start from', level: 0 as Level },
        { label: 'With a signal at priority', value: formatCount(high), foot: share(high), level: 2 as Level },
      ]
    }
    const sorted = withValue.map((r) => valueOf(r)!).sort((a, b) => a - b)
    const at = (p: number) => {
      const v = quantile(sorted, p)
      return v === null ? '—' : format(v)
    }
    const usual = [
      { label: 'Middle figure (median)', value: at(0.5), foot: 'half of charities are above it and half below', level: 0 as Level },
      rule?.low
        ? { label: 'Lowest 10% of charities', value: `under ${at(0.1)}`, foot: `of ${formatCount(sorted.length)} with a figure`, level: 0 as Level }
        : { label: 'Highest 10% of charities', value: `over ${at(0.9)}`, foot: `of ${formatCount(sorted.length)} with a figure`, level: 0 as Level },
    ]
    if (!signal) return [{ label: 'Lowest 25% of charities', value: `under ${at(0.25)}`, foot: `of ${formatCount(sorted.length)} with a figure`, level: 0 as Level }, ...usual]
    const look = scoped.filter((r) => r.levels[signal] === 1).length
    const high = scoped.filter((r) => r.levels[signal] === 2).length
    return [
      { label: LEVEL_NAME[1], value: formatCount(look), foot: share(look), level: 1 as Level },
      { label: LEVEL_NAME[2], value: formatCount(high), foot: share(high), level: 2 as Level },
      ...usual,
    ]
  }, [pick, scoped, withValue, valueOf, format, signal, rule, meta])

  const download = () => {
    const head = ['Rank', 'CC number', 'Charity', 'Reporting tier', 'Tier on latest annual return', 'Sector', 'Total revenue', title, 'Level', 'Signals', 'Which signals']
    const lines = listed.map(({ row: r, rank }) =>
      [
        rank, r.cc, r.name, bandName(r.band), r.tier, r.sector, r.values.income, valueOf(r),
        signal ? ['', LEVEL_NAME[1], LEVEL_NAME[2]][r.levels[signal]] : '',
        r.signals,
        meta.signal_order.filter((k) => r.levels[k] > 0).map((k) => MEASURE[k].short).join('; '),
      ].map((v) => csvCell(v ?? null)).join(','),
    )
    const url = URL.createObjectURL(new Blob([`﻿${head.map(csvCell).join(',')}\n${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `watchlist-${pick.replaceAll('_', '-')}-${meta.as_of}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const counts = useMemo(() => {
    const out = new Map<Pick, number>([['combined', scoped.filter((r) => r.signals >= meta.combined_threshold).length]])
    for (const k of meta.signal_order) out.set(k, scoped.filter((r) => r.levels[k] > 0).length)
    return out
  }, [scoped, meta])
  const countOf = (key: Pick) => (counts.has(key) ? formatCount(counts.get(key)!) : undefined)
  const choose = (next: Pick) => set({ m: next === 'combined' ? null : next, show: null })

  const columns = useMemo<TableColumnDefinition<Ranked>[]>(() => {
    // The list arrives sorted, with ties and blanks settled. The grid sorts what it is given again
    // with the column's compare: comparing places makes it keep the order it was given.
    const keep = (a: Ranked, b: Ranked) => (sort.sortDirection === 'ascending' ? a.rank - b.rank : b.rank - a.rank)
    const out: TableColumnDefinition<Ranked>[] = [
      // A compare that takes no arguments marks a column the grid can't sort by.
      createTableColumn<Ranked>({ columnId: 'rank', compare: () => 0, renderHeaderCell: () => '#', renderCell: (x) => <span className={s.rank}>{x.rank}</span> }),
      createTableColumn<Ranked>({
        columnId: 'name',
        compare: keep,
        renderHeaderCell: () => 'Charity',
        renderCell: ({ row: r }) => (
          <span className={s.name}>
            <CharityLink cc={r.cc}>{r.name}</CharityLink>
            <Caption1 className={s.muted}>{[r.cc, bandName(r.band), r.sector].filter(Boolean).join(' · ')}</Caption1>
          </span>
        ),
      }),
    ]
    if (pick !== 'income' && !compact) {
      out.push(
        createTableColumn<Ranked>({
          columnId: 'income',
          compare: keep,
          renderHeaderCell: () => 'Revenue',
          renderCell: ({ row: r }) => <span className={s.number}>{r.values.income === null ? '—' : money(r.values.income)}</span>,
        }),
      )
    }
    out.push(
      createTableColumn<Ranked>({
        columnId: 'value',
        compare: keep,
        renderHeaderCell: () => (pick === 'combined' ? 'Signals' : MEASURE[pick].short),
        renderCell: ({ row: r }) => {
          const v = valueOf(r)!
          const lv = levelFor(r)
          if (pick === 'combined') return v ? <LevelBadge level={r.priority ? 2 : 1}>{formatCount(v)}</LevelBadge> : <span className={s.number}>0</span>
          return lv ? <LevelBadge level={lv}>{format(v)}</LevelBadge> : <span className={s.number}>{format(v)}</span>
        },
      }),
    )
    if (!narrow) {
      out.push(
        createTableColumn<Ranked>({
          columnId: 'signals',
          compare: keep,
          renderHeaderCell: () => (pick === 'combined' ? 'Which signals' : 'All its signals'),
          renderCell: ({ row: r }) => (
            <span className={s.chips}>
              <SignalChips intel={intel} row={r} max={4} />
            </span>
          ),
        }),
      )
    }
    return out
  }, [pick, compact, narrow, valueOf, levelFor, format, intel, s, sort.sortDirection])

  const tierLabel = {
    children: (_: unknown, props: LabelProps) => (
      <HelpLabel {...props} info={TIER_MEANS}>
        Reporting tier
      </HelpLabel>
    ),
  }

  return (
    <div className={s.layout}>
      {stacked ? (
        <Field label="Rank the list by">
          <Select value={pick} onChange={(_, d) => choose(d.value as Pick)}>
            <option value="combined">
              {COMBINED} ({countOf('combined')})
            </option>
            {GROUP_ORDER.map((g) => (
              <optgroup key={g} label={GROUPS[g]}>
                {MEASURES.filter((m) => m.group === g).map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.short}
                    {counts.has(m.key) ? ` (${countOf(m.key)})` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
      ) : (
        <Card className={s.rail}>
          <MenuList
            aria-label="Rank the list by"
            checkedValues={{ measure: [pick] }}
            onCheckedValueChange={(_, d) => d.checkedItems[0] && choose(d.checkedItems[0] as Pick)}
          >
            <MenuItemRadio name="measure" value="combined" secondaryContent={countOf('combined')}>
              {COMBINED}
            </MenuItemRadio>
            {GROUP_ORDER.map((g) => (
              <MenuGroup key={g}>
                <MenuGroupHeader>{GROUPS[g]}</MenuGroupHeader>
                {MEASURES.filter((m) => m.group === g).map((m) => (
                  <MenuItemRadio key={m.key} name="measure" value={m.key} secondaryContent={countOf(m.key)}>
                    {m.short}
                  </MenuItemRadio>
                ))}
              </MenuGroup>
            ))}
          </MenuList>
          <Caption1 className={s.railNote}>
            A number is how many charities that signal picks out. The others give context and do not count as signals.
          </Caption1>
          <MeasureGuide intel={intel} />
        </Card>
      )}

      <div className={s.main}>
        <Card size="large" className={s.card}>
          <div className={s.headText}>
            <Caption1 className={s.muted}>Ranked by</Caption1>
            <Subtitle1 as="h2">{title}</Subtitle1>
            <Body1>
              {info
                ? info.description
                : `How many signals a charity has at “worth a look” or above. A charity with ${meta.combined_threshold} or more is on the watchlist: several unusual figures together are more likely to be worth checking than 1 on its own.`}
            </Body1>
            {signal ? (
              <Body1 className={s.muted}>{ruleText(meta, signal)}</Body1>
            ) : (
              pick !== 'combined' && <Body1 className={s.muted}>This figure gives context. It does not count as a signal.</Body1>
            )}
          </div>
          <div className={s.stats}>
            {stats.map((t) => (
              <Stat key={t.label} label={t.label} value={t.value} foot={t.foot} level={t.level} />
            ))}
          </div>
        </Card>

        <Card size="large" className={s.card}>
          <div className={s.filters}>
            <Field label={tierLabel} className={s.field}>
              <Select value={tier ? String(tier) : ''} onChange={(_, d) => set({ tier: d.value || null })}>
                <option value="">All tiers</option>
                {BANDS.map((b) => (
                  <option key={b} value={b} title={BAND_RANGE[b]}>
                    {bandName(b)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sector" className={s.field}>
              <Select value={sector ?? ''} onChange={(_, d) => set({ sector: d.value || null })}>
                <option value="">All sectors</option>
                {meta.sectors.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
            {levelled && (
              <Field label="Show" className={s.field}>
                <Select value={String(atLeast)} onChange={(_, d) => set({ show: d.value === '0' ? null : d.value })}>
                  <option value="0">Every charity</option>
                  <option value="1">{pick === 'combined' ? 'Only charities on the watchlist' : 'Only worth a look or priority'}</option>
                  {signal && <option value="2">Only priority</option>}
                </Select>
              </Field>
            )}
            <Field label="Find a charity" className={s.search}>
              <SearchBox placeholder="Name or CC number" value={query} onChange={(_, d) => set({ q: d.value || null })} />
            </Field>
            <div className={s.commands}>
              <Body1 className={s.muted} aria-live="polite">
                {formatCount(listed.length)} {listed.length === 1 ? 'charity' : 'charities'}
              </Body1>
              <Button appearance="secondary" icon={<ArrowDownload20Regular />} onClick={download} disabled={!listed.length}>
                Download CSV
              </Button>
            </div>
          </div>

          <Grid
            // A changed list is a new grid: back to its first rows, scrolled to the top.
            key={`${pick}|${tier}|${sector}|${atLeast}|${query}|${sort.sortColumn}|${sort.sortDirection}`}
            items={listed}
            columns={columns}
            sort={sort}
            onSort={(next) => setSorts((all) => ({ ...all, [pick]: next }))}
            label={`Charities ranked by ${title.toLowerCase()}`}
          />
        </Card>
      </div>
    </div>
  )
}

/** The list, as Fluent's data grid: column headings that sort, and more rows as you scroll. */
function Grid({ items, columns, sort, onSort, label }: {
  items: Ranked[]
  columns: TableColumnDefinition<Ranked>[]
  sort: Sort
  onSort: (next: Sort) => void
  label: string
}) {
  const s = useStyles()
  const [shown, setShown] = useState(PAGE)
  const boxRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const total = items.length
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

  if (!total) {
    return (
      <div className={s.gridBox}>
        <EmptyState icon={<Search24Regular />} title="No charities match">
          Clear the search, or choose another reporting tier, sector or “Show” option.
        </EmptyState>
      </div>
    )
  }
  return (
    <>
      <div ref={boxRef} className={s.gridBox}>
        <DataGrid
          aria-label={label}
          items={items.slice(0, shown)}
          columns={columns}
          sortable
          sortState={sort}
          onSortChange={(_, next) => onSort(next as Sort)}
          getRowId={(x: Ranked) => x.row.cc}
          focusMode="composite"
          // Below the columns' least widths the list scrolls sideways in its box, not the page.
          style={{ minWidth: columns.reduce((sum, c) => sum + Number(columnStyle(c.columnId).minWidth), 0) }}
        >
          <DataGridHeader className={s.gridHead}>
            <DataGridRow>
              {({ renderHeaderCell, columnId }) => <DataGridHeaderCell style={columnStyle(columnId)}>{renderHeaderCell()}</DataGridHeaderCell>}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<Ranked>>
            {({ item, rowId }) => (
              <DataGridRow<Ranked> key={rowId}>
                {({ renderCell, columnId }) => <DataGridCell style={columnStyle(columnId)}>{renderCell(item)}</DataGridCell>}
              </DataGridRow>
            )}
          </DataGridBody>
        </DataGrid>
        <div ref={endRef} className={s.end} aria-hidden="true" />
      </div>
      {total > shown && (
        <Caption1 className={s.muted}>
          Showing {formatCount(shown)} of {formatCount(total)}. Scroll the list for more.
        </Caption1>
      )}
    </>
  )
}
