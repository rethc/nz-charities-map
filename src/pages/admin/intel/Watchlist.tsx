import {
  Body1,
  Button,
  Caption1,
  Card,
  Label,
  makeStyles,
  mergeClasses,
  SearchBox,
  Select,
  Subtitle2,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  ToggleButton,
  tokens,
  useId,
} from '@fluentui/react-components'
import { ArrowDownload20Regular, ArrowSortDown20Regular, ArrowSortUp20Regular } from '@fluentui/react-icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import { formatCount } from '../../../lib/dom'
import {
  bandName,
  BANDS,
  GROUPS,
  isSignal,
  MEASURE,
  MEASURES,
  money,
  quantile,
  ruleText,
  type Group,
  type Intel,
  type IntelRow,
  type Level,
  type MeasureKey,
} from '../../../lib/intel'
import { fold } from '../../../lib/search'
import { CharityLink } from './Overview'
import { LevelBadge, SignalChips } from './shell'

/** Every charity ranked by one measure, or by how many signals it trips. */

type Pick = MeasureKey | 'combined'
const PAGE = 100
const GROUP_ORDER: Group[] = ['money', 'activity', 'governance', 'reporting']

const useStyles = makeStyles({
  layout: { display: 'grid', gridTemplateColumns: '17rem minmax(0, 1fr)', alignItems: 'start', gap: '16px', '@media (max-width: 960px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
  rail: { display: 'grid', gap: '2px', padding: '12px' },
  railGroup: { color: tokens.colorNeutralForeground3, padding: '12px 8px 2px', fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    width: '100%',
    padding: '6px 8px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    textAlign: 'start',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
  },
  itemOn: { backgroundColor: tokens.colorBrandBackground2, fontWeight: tokens.fontWeightSemibold, ':hover': { backgroundColor: tokens.colorBrandBackground2 } },
  itemCount: { color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums', fontWeight: tokens.fontWeightRegular, flex: 'none' },
  main: { display: 'grid', gap: '16px', minWidth: 0 },
  card: { display: 'grid', gap: '12px', alignContent: 'start', minWidth: 0 },
  headText: { display: 'grid', gap: '4px', alignContent: 'start', maxWidth: '92ch' },
  muted: { color: tokens.colorNeutralForeground3 },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))', gap: '8px' },
  tile: { display: 'grid', gap: '2px', alignContent: 'start', padding: '10px 14px', borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3, borderInlineStartWidth: '4px', borderInlineStartStyle: 'solid', borderInlineStartColor: 'transparent' },
  tileValue: { fontSize: tokens.fontSizeBase600, lineHeight: tokens.lineHeightBase600, fontWeight: tokens.fontWeightSemibold },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' },
  pills: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  search: { width: 'min(100%, 18rem)' },
  spacer: { marginLeft: 'auto' },
  gridBox: {
    overflow: 'auto',
    maxHeight: 'min(76vh, 64rem)',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  gridHead: { position: 'sticky', top: 0, zIndex: 2, backgroundColor: tokens.colorNeutralBackground1, boxShadow: `0 1px 0 ${tokens.colorNeutralStroke2}` },
  rank: { width: '56px', color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  name: { display: 'grid', gap: '2px', padding: '8px 0', minWidth: '14rem' },
  figure: { width: '12rem', textAlign: 'end', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  income: { width: '7rem', textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  signalCell: { padding: '8px 0' },
  end: { height: '1px' },
})

function csvCell(value: string | number | null) {
  const text = value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function Watchlist({ intel }: { intel: Intel }) {
  const s = useStyles()
  const { meta } = intel
  const narrow = useMediaQuery('(max-width: 960px)')
  const compact = useMediaQuery('(max-width: 720px)')
  const [params, setParams] = useSearchParams()
  const measureId = useId('measure')

  const pick: Pick = MEASURES.find((m) => m.key === params.get('m'))?.key ?? 'combined'
  const info = pick === 'combined' ? null : MEASURE[pick]
  const signal = info && isSignal(meta, info.key) ? info.key : null
  const rule = signal ? meta.signals[signal] : null
  const levelled = pick === 'combined' || signal !== null
  const size = BANDS.find((b) => String(b) === params.get('size')) ?? null
  const sector = meta.sectors.includes(params.get('sector') ?? '') ? params.get('sector') : null
  const atLeast: Level = !levelled ? 0 : params.get('flagged') === '2' && signal ? 2 : params.get('flagged') ? 1 : 0
  const lowFirst = params.get('order') === 'low' || (params.get('order') === null && Boolean(rule?.low))
  const query = params.get('q') ?? ''

  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  /** Charities of the size and sector picked: what the counts describe. */
  const scoped = useMemo(
    () => intel.rows.filter((r) => (!size || r.band === size) && (!sector || r.sector === sector)),
    [intel, size, sector],
  )
  const valueOf = useMemo(() => (pick === 'combined' ? (r: IntelRow) => r.signals : (r: IntelRow) => r.values[pick]), [pick])
  const levelFor = useMemo(
    () => (r: IntelRow): Level => (pick === 'combined' ? (r.signals >= meta.combined_threshold ? 1 : 0) : signal ? r.levels[signal] : 0),
    [pick, signal, meta],
  )
  const withValue = useMemo(() => scoped.filter((r) => valueOf(r) !== null), [scoped, valueOf])

  const listed = useMemo(() => {
    const q = fold(query.trim())
    const sign = lowFirst ? 1 : -1
    return withValue
      .filter((r) => levelFor(r) >= atLeast && (!q || r.nameKey.includes(q) || r.cc.toLowerCase().includes(q)))
      .sort((a, b) =>
        pick === 'combined'
          ? sign * (a.signals - b.signals) || sign * (a.priority - b.priority) || (b.values.income ?? 0) - (a.values.income ?? 0)
          : sign * (valueOf(a)! - valueOf(b)!) || (b.values.income ?? 0) - (a.values.income ?? 0),
      )
  }, [withValue, query, atLeast, lowFirst, pick, levelFor, valueOf])

  // Continuous scroll, as on the annual return checks: more rows load as the end comes into view.
  // A changed list starts again from its first rows.
  const listKey = `${pick}|${size}|${sector}|${atLeast}|${lowFirst}|${query}`
  const [paging, setPaging] = useState({ key: listKey, shown: PAGE })
  const shown = paging.key === listKey ? paging.shown : PAGE
  const boxRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const total = listed.length
  useEffect(() => {
    const end = endRef.current
    if (shown >= total || !end) return
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setPaging((m) => ({ key: listKey, shown: (m.key === listKey ? m.shown : PAGE) + PAGE })),
      { root: boxRef.current, rootMargin: '0px 0px 400px 0px' },
    )
    observer.observe(end)
    return () => observer.disconnect()
  }, [shown, total, listKey])

  const title = info ? info.title : 'All signals combined'
  const format = useMemo(() => (info ? info.format : (v: number) => `${formatCount(v)} ${v === 1 ? 'signal' : 'signals'}`), [info])

  /** The figures above the list: how many the signal picks out, and what a usual figure is. */
  const tiles = useMemo(() => {
    const share = (n: number) => (scoped.length ? ` · ${((n / scoped.length) * 100).toFixed(1)}%` : '')
    if (pick === 'combined') {
      const on = scoped.filter((r) => r.signals >= meta.combined_threshold).length
      const more = scoped.filter((r) => r.signals > meta.combined_threshold).length
      const high = scoped.filter((r) => r.priority > 0).length
      return [
        { label: `On the watchlist: ${meta.combined_threshold} or more signals`, value: formatCount(on), foot: `of ${formatCount(scoped.length)} charities${share(on)}`, level: 1 as Level },
        { label: `${meta.combined_threshold + 1} or more signals`, value: formatCount(more), foot: 'the shortest list to start from', level: 0 as Level },
        { label: 'With a signal at priority', value: formatCount(high), foot: 'whatever their number of signals', level: 2 as Level },
      ]
    }
    const sorted = withValue.map((r) => valueOf(r)!).sort((a, b) => a - b)
    const at = (p: number) => {
      const v = quantile(sorted, p)
      return v === null ? '—' : format(v)
    }
    const usual = [
      { label: 'A usual figure', value: at(0.5), foot: 'half of charities are above it, half below', level: 0 as Level },
      rule?.low
        ? { label: 'The lowest tenth', value: `under ${at(0.1)}`, foot: `of ${formatCount(sorted.length)} charities with a figure`, level: 0 as Level }
        : { label: 'The highest tenth', value: `over ${at(0.9)}`, foot: `of ${formatCount(sorted.length)} charities with a figure`, level: 0 as Level },
    ]
    if (!signal) return [{ label: 'The lowest quarter', value: `under ${at(0.25)}`, foot: 'a quarter of charities are below it', level: 0 as Level }, ...usual]
    const look = scoped.filter((r) => r.levels[signal] === 1).length
    const high = scoped.filter((r) => r.levels[signal] === 2).length
    return [
      { label: 'Worth a look', value: formatCount(look), foot: `of ${formatCount(scoped.length)} charities${share(look)}`, level: 1 as Level },
      { label: 'Priority', value: formatCount(high), foot: `of ${formatCount(scoped.length)} charities${share(high)}`, level: 2 as Level },
      ...usual,
    ]
  }, [pick, scoped, withValue, valueOf, format, signal, rule, meta])

  const download = () => {
    const head = ['Rank', 'CC number', 'Charity', 'Size', 'Tier on latest return', 'Sector', 'Income', title, 'Level', 'Signals', 'Signals tripped']
    const lines = listed.map((r, i) =>
      [
        i + 1, r.cc, r.name, bandName(r.band), r.tier, r.sector, r.values.income, valueOf(r),
        signal ? ['', 'Worth a look', 'Priority'][r.levels[signal]] : '',
        r.signals,
        meta.signal_order.filter((k) => r.levels[k] > 0).map((k) => MEASURE[k].chip ?? MEASURE[k].title).join('; '),
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
  const choose = (next: Pick) => set({ m: next === 'combined' ? null : next, order: null, flagged: null })

  return (
    <div className={s.layout}>
      {narrow ? (
        <div>
          <Label htmlFor={measureId} size="small">
            Ranked by
          </Label>
          <Select id={measureId} value={pick} onChange={(_, d) => choose(d.value as Pick)}>
            <option value="combined">All signals combined ({formatCount(counts.get('combined') ?? 0)})</option>
            {GROUP_ORDER.map((g) => (
              <optgroup key={g} label={GROUPS[g]}>
                {MEASURES.filter((m) => m.group === g).map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.title}
                    {counts.has(m.key) ? ` (${formatCount(counts.get(m.key)!)})` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
      ) : (
        <Card className={s.rail}>
          <nav aria-label="Rank the list by">
            <RailItem label="All signals combined" count={counts.get('combined')} on={pick === 'combined'} onClick={() => choose('combined')} />
            {GROUP_ORDER.map((g) => (
              <div key={g}>
                <div className={s.railGroup}>{GROUPS[g]}</div>
                {MEASURES.filter((m) => m.group === g).map((m) => (
                  <RailItem key={m.key} label={m.title} count={counts.get(m.key)} on={pick === m.key} onClick={() => choose(m.key)} />
                ))}
              </div>
            ))}
          </nav>
          <Caption1 className={s.muted} style={{ padding: '10px 8px 0' }}>
            The number is how many charities a signal picks out. Measures without one are for context: they don't count
            towards a charity's signals.
          </Caption1>
        </Card>
      )}

      <div className={s.main}>
        <Card className={s.card}>
          <div className={s.headText}>
            <Caption1 className={s.muted}>Ranked by</Caption1>
            <Subtitle2 as="h2">{title}</Subtitle2>
            <Body1>
              {info
                ? info.description
                : 'How many signals a charity trips at “worth a look” or above. A charity with several is more likely to repay a look than one with a single high figure.'}
            </Body1>
            {signal && <Body1 className={s.muted}>{ruleText(meta, signal)}</Body1>}
          </div>
          <div className={s.tiles}>
            {tiles.map((t) => (
              <div key={t.label} className={s.tile} style={{ borderInlineStartColor: t.level === 2 ? '#b3261e' : t.level === 1 ? '#d98300' : 'transparent' }}>
                <Caption1 className={s.muted}>{t.label}</Caption1>
                <span className={s.tileValue}>{t.value}</span>
                <Caption1 className={s.muted}>{t.foot}</Caption1>
              </div>
            ))}
          </div>
        </Card>

        <Card className={s.card}>
          <div className={s.toolbar}>
            <div className={s.pills} role="group" aria-label="Size">
              <ToggleButton size="small" shape="circular" checked={!size} onClick={() => set({ size: null })}>
                All sizes
              </ToggleButton>
              {BANDS.map((b) => (
                <ToggleButton key={b} size="small" shape="circular" checked={size === b} onClick={() => set({ size: size === b ? null : String(b) })}>
                  {bandName(b)}
                </ToggleButton>
              ))}
            </div>
            <Select aria-label="Sector" value={sector ?? ''} onChange={(_, d) => set({ sector: d.value || null })} style={{ minWidth: '12rem' }}>
              <option value="">All sectors</option>
              {meta.sectors.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
            {levelled && (
              <div className={s.pills} role="group" aria-label="Which charities">
                <ToggleButton size="small" shape="circular" checked={atLeast === 0} onClick={() => set({ flagged: null })}>
                  Every charity
                </ToggleButton>
                <ToggleButton size="small" shape="circular" checked={atLeast === 1} onClick={() => set({ flagged: '1' })}>
                  {pick === 'combined' ? 'On the watchlist' : 'Worth a look or priority'}
                </ToggleButton>
                {signal && (
                  <ToggleButton size="small" shape="circular" checked={atLeast === 2} onClick={() => set({ flagged: '2' })}>
                    Priority only
                  </ToggleButton>
                )}
              </div>
            )}
          </div>
          <div className={s.toolbar}>
            <SearchBox className={s.search} placeholder="Search name or CC number" aria-label="Search the list" value={query} onChange={(_, d) => set({ q: d.value || null })} />
            <Button
              appearance="subtle"
              icon={lowFirst ? <ArrowSortUp20Regular /> : <ArrowSortDown20Regular />}
              onClick={() => set({ order: lowFirst ? 'high' : 'low' })}
              title="Change the order"
            >
              {lowFirst ? 'Lowest first' : 'Highest first'}
            </Button>
            <Body1 className={mergeClasses(s.muted, s.spacer)} aria-live="polite">
              {formatCount(listed.length)} {listed.length === 1 ? 'charity' : 'charities'}
            </Body1>
            <Button appearance="secondary" icon={<ArrowDownload20Regular />} onClick={download} disabled={!listed.length}>
              Download CSV
            </Button>
          </div>

          {/* Keyed by what is listed, so a changed list is a new box, scrolled to its top. */}
          <div key={listKey} ref={boxRef} className={s.gridBox}>
            <Table aria-label={`Charities ranked by ${title.toLowerCase()}`}>
              <TableHeader className={s.gridHead}>
                <TableRow>
                  <TableHeaderCell className={s.rank}>#</TableHeaderCell>
                  <TableHeaderCell>Charity</TableHeaderCell>
                  {!compact && <TableHeaderCell className={s.income}>Income</TableHeaderCell>}
                  <TableHeaderCell className={s.figure}>{pick === 'combined' ? 'Signals' : title}</TableHeaderCell>
                  {!narrow && <TableHeaderCell>{pick === 'combined' ? 'Which signals' : 'All its signals'}</TableHeaderCell>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {listed.slice(0, shown).map((r, i) => {
                  const v = valueOf(r)!
                  const lv = levelFor(r)
                  return (
                    <TableRow key={r.cc}>
                      <TableCell className={s.rank}>{i + 1}</TableCell>
                      <TableCell>
                        <span className={s.name}>
                          <CharityLink cc={r.cc}>{r.name}</CharityLink>
                          <Caption1 className={s.muted}>{[r.cc, bandName(r.band), r.sector].filter(Boolean).join(' · ')}</Caption1>
                        </span>
                      </TableCell>
                      {!compact && <TableCell className={s.income}>{r.values.income === null ? '—' : money(r.values.income)}</TableCell>}
                      <TableCell className={s.figure}>
                        {pick === 'combined' ? (
                          v ? <LevelBadge level={r.priority ? 2 : 1}>{formatCount(v)}</LevelBadge> : '0'
                        ) : lv ? (
                          <LevelBadge level={lv}>{format(v)}</LevelBadge>
                        ) : (
                          format(v)
                        )}
                      </TableCell>
                      {!narrow && (
                        <TableCell className={s.signalCell}>
                          <SignalChips intel={intel} row={r} max={4} />
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            {!listed.length && (
              <Body1 className={s.muted} style={{ display: 'block', padding: '24px', textAlign: 'center' }}>
                No charity matches. Clear the search or a filter.
              </Body1>
            )}
            <div ref={endRef} className={s.end} aria-hidden="true" />
          </div>
          {listed.length > shown && (
            <Body1 className={s.muted}>
              Showing {formatCount(shown)} of {formatCount(listed.length)}. Scroll the list for more.
            </Body1>
          )}
        </Card>
      </div>
    </div>
  )
}

function RailItem({ label, count, on, onClick }: { label: string; count: number | undefined; on: boolean; onClick: () => void }) {
  const s = useStyles()
  return (
    <button type="button" className={mergeClasses(s.item, on && s.itemOn)} aria-current={on ? 'true' : undefined} onClick={onClick}>
      <span>{label}</span>
      {count !== undefined && <span className={s.itemCount}>{formatCount(count)}</span>}
    </button>
  )
}
