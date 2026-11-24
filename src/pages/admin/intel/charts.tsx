import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
import { useState, type KeyboardEvent } from 'react'
import { useElementBox } from '../../../hooks/useElementBox'
import type { Level } from '../../../lib/intel'

/**
 * The intelligence pages' charts: plain SVG in Fluent's chart style, as on the other admin
 * reports. Every chart has a tooltip on hover and sits in a card that can show it as a table.
 */

/** Series colours: income, spending, net assets. Checked together for colour-blind readers. */
export const SERIES = { income: '#007ea8', spend: '#4f8a10', funds: '#6b4fbb' } as const
/** Signal levels, light to dark so they also read without colour. Warm colours mean nothing else here. */
export const LEVEL_COLOUR: Record<Level, string> = { 0: '#9fb4be', 1: '#d98300', 2: '#b3261e' }
/** One series on its own: the site's blue, as on the other admin charts. */
export const PLAIN = '#007ea8'

const LABEL = 14
const TICK = 13
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

/** Round numbers along an axis from `low` (0 or below) to `high`. */
function niceScale(low: number, high: number, count: number) {
  const span = high - low || 1
  const step0 = span / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= step0) ?? mag * 10
  const bottom = Math.floor(low / step + 1e-9) * step
  const top = Math.ceil(high / step - 1e-9) * step || step
  const ticks: number[] = []
  for (let t = bottom; t <= top + step * 1e-6; t += step) ticks.push(Math.abs(t) < step * 1e-6 ? 0 : t)
  return { ticks, bottom, top }
}

const useStyles = makeStyles({
  chart: { position: 'relative', minWidth: 0 },
  focusable: {
    borderRadius: tokens.borderRadiusMedium,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
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
    width: 'max-content',
    maxWidth: '20rem',
    color: tokens.colorNeutralForeground1,
  },
  tipHead: { color: tokens.colorNeutralForeground3 },
  tipRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  tipValue: { fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  tipName: { color: tokens.colorNeutralForeground3 },
  key: { width: '14px', height: 0, borderTopWidth: '2px', borderTopStyle: 'solid', flex: 'none' },
  legend: { display: 'flex', flexWrap: 'wrap', gap: '4px 16px', color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
  swatch: { width: '12px', height: '12px', borderRadius: '2px', flex: 'none' },
  clickable: { cursor: 'pointer' },
  track: { position: 'relative', height: '8px', borderRadius: '4px', backgroundColor: '#e1eaee', margin: '6px 7px' },
  trackFill: { position: 'absolute', insetBlock: 0, left: 0, borderRadius: '4px', opacity: 0.45 },
  trackMark: {
    position: 'absolute',
    top: '50%',
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    transform: 'translate(-50%, -50%)',
    boxShadow: `0 0 0 2px ${tokens.colorNeutralBackground1}`,
  },
})

export interface TipRow {
  colour?: string
  value: string
  name?: string
}
interface Tip {
  x: number
  y: number
  head: string
  rows: TipRow[]
}

function TipBox({ tip, width }: { tip: Tip | null; width: number }) {
  const s = useStyles()
  if (!tip) return null
  const right = tip.x > width / 2
  return (
    <div
      className={s.tip}
      style={{ top: Math.max(0, tip.y - 12), ...(right ? { right: Math.max(0, width - tip.x + 14) } : { left: tip.x + 14 }) }}
    >
      <div className={s.tipHead}>{tip.head}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className={s.tipRow}>
          {r.colour && <span className={s.key} style={{ borderTopColor: r.colour }} />}
          <span className={s.tipValue}>{r.value}</span>
          {r.name && <span className={s.tipName}>{r.name}</span>}
        </div>
      ))}
    </div>
  )
}

/** Names the colours of a chart with two or more series. */
export function Legend({ items, marks = 'line' }: { items: { label: string; colour: string }[]; marks?: 'line' | 'box' }) {
  const s = useStyles()
  return (
    <div className={s.legend}>
      {items.map((item) => (
        <span key={item.label} className={s.legendItem}>
          {marks === 'line' ? (
            <span className={s.key} style={{ borderTopColor: item.colour }} />
          ) : (
            <span className={s.swatch} style={{ backgroundColor: item.colour }} />
          )}
          {item.label}
        </span>
      ))}
    </div>
  )
}

// ---- Lines over the years ---------------------------------------------------------------------

export interface LineSeries {
  key: string
  label: string
  colour: string
  values: (number | null)[]
}

/** One line per series across the years. Hover, or focus and use the arrow keys, for a year's figures. */
export function LineChart({
  years,
  series,
  format,
  tick,
  label,
  height = 210,
  top: fixedTop,
}: {
  years: (number | string)[]
  series: LineSeries[]
  /** A figure in the tooltip and at the end of a line. */
  format: (v: number) => string
  /** A figure along the axis. */
  tick: (v: number) => string
  label: string
  height?: number
  /** The top of the axis, for a share that should run to 100%. */
  top?: number
}) {
  const s = useStyles()
  const [ref, box] = useElementBox<HTMLDivElement>()
  const [at, setAt] = useState<number | null>(null)
  const width = Math.max(240, box.width)
  const all = series.flatMap((x) => x.values.filter((v): v is number => v !== null))
  const scale = niceScale(Math.min(0, ...all), fixedTop ?? Math.max(0, ...all), 4)
  const yTop = fixedTop ?? scale.top
  const ticks = scale.ticks.filter((t) => t <= yTop + 1e-9)
  const ends = series.map((x) => {
    let i = x.values.length - 1
    while (i >= 0 && x.values[i] === null) i--
    return i
  })
  const endLabels = series.map((x, i) => (ends[i]! >= 0 ? format(x.values[ends[i]!]!) : ''))
  const left = Math.max(...ticks.map((t) => textWidth(tick(t), TICK))) + 10
  const right = Math.max(12, ...endLabels.map((t) => textWidth(t, TICK, 600) + 14))
  const padTop = 10
  const padBottom = 26
  const plotW = Math.max(40, width - left - right)
  const plotH = height - padTop - padBottom
  const x = (i: number) => left + (years.length > 1 ? (i / (years.length - 1)) * plotW : plotW / 2)
  const y = (v: number) => padTop + (1 - (v - scale.bottom) / (yTop - scale.bottom || 1)) * plotH

  // End labels sit beside their lines; where two would overlap, the tooltip and table carry them.
  const endY = series.map((sx, i) => (ends[i]! >= 0 ? y(sx.values[ends[i]!]!) : null))
  const showEnd = series.map((_, i) => endY[i] !== null && endY.every((other, j) => j === i || other === null || Math.abs(other - endY[i]!) >= TICK + 2))

  const tipFor = (i: number): Tip => ({
    x: x(i),
    y: padTop,
    head: String(years[i]),
    rows: series
      .filter((sx) => sx.values[i] !== null && sx.values[i] !== undefined)
      .map((sx) => ({ colour: sx.colour, value: format(sx.values[i]!), name: series.length > 1 ? sx.label : undefined })),
  })
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    setAt((cur) => Math.max(0, Math.min(years.length - 1, (cur ?? (e.key === 'ArrowLeft' ? years.length : -1)) + (e.key === 'ArrowLeft' ? -1 : 1))))
  }
  // To a screen reader the chart is a slider over the years: each step reads that year's figures.
  const reading = at ?? years.length - 1
  const read = tipFor(reading)

  return (
    <div
      ref={ref}
      className={mergeClasses(s.chart, s.focusable)}
      role="slider"
      aria-label={`${label}. Left and right arrow keys read each year.`}
      aria-valuemin={0}
      aria-valuemax={years.length - 1}
      aria-valuenow={reading}
      aria-valuetext={`${read.head}: ${read.rows.map((r) => (r.name ? `${r.name} ${r.value}` : r.value)).join(', ')}`}
      tabIndex={0}
      onKeyDown={onKey}
      onBlur={() => setAt(null)}
      onMouseLeave={() => setAt(null)}
      onMouseMove={(e) => {
        const b = e.currentTarget.getBoundingClientRect()
        const px = ((e.clientX - b.left) / b.width) * width
        const i = years.length > 1 ? Math.round(((px - left) / plotW) * (years.length - 1)) : 0
        setAt(Math.max(0, Math.min(years.length - 1, i)))
      }}
    >
      {box.width > 0 && (
        <svg width="100%" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ fontFamily: tokens.fontFamilyBase, display: 'block', overflow: 'visible' }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} style={{ stroke: t === 0 ? tokens.colorNeutralStroke1 : tokens.colorNeutralStroke2 }} />
              <text x={left - 8} y={y(t)} dy="0.35em" textAnchor="end" fontSize={TICK} style={{ fill: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' }}>
                {tick(t)}
              </text>
            </g>
          ))}
          {years.map((yr, i) => (
            <text key={yr} x={x(i)} y={height - 7} textAnchor="middle" fontSize={TICK} style={{ fill: tokens.colorNeutralForeground3 }}>
              {yr}
            </text>
          ))}
          {at !== null && <line x1={x(at)} x2={x(at)} y1={padTop} y2={padTop + plotH} style={{ stroke: tokens.colorNeutralForeground3 }} />}
          {series.map((sx, si) => {
            // A year with no figure breaks the line rather than joining the years either side.
            const runs: string[] = []
            let run = ''
            sx.values.forEach((v, i) => {
              if (v === null) {
                if (run) runs.push(run)
                run = ''
              } else run += `${run ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
            })
            if (run) runs.push(run)
            const end = ends[si]!
            return (
              <g key={sx.key}>
                {runs.map((d) => (
                  <path key={d} d={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: sx.colour }} />
                ))}
                {sx.values.map((v, i) =>
                  v !== null ? (
                    <circle key={i} cx={x(i)} cy={y(v)} r={i === at ? 5 : 4} strokeWidth={2} style={{ fill: sx.colour, stroke: tokens.colorNeutralBackground1 }} />
                  ) : null,
                )}
                {showEnd[si] && end >= 0 && (
                  <text x={x(end) + 9} y={endY[si]!} dy="0.35em" fontSize={TICK} fontWeight={600} style={{ fill: tokens.colorNeutralForeground1, fontVariantNumeric: 'tabular-nums' }}>
                    {endLabels[si]}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
      <TipBox tip={at === null ? null : tipFor(at)} width={width} />
    </div>
  )
}

// ---- Bars -------------------------------------------------------------------------------------

/** A bar from x0 to x1 with its data end rounded and its baseline end square. */
function barPath(x0: number, x1: number, y: number, h: number, roundEnd: boolean) {
  const w = Math.abs(x1 - x0)
  const r = roundEnd ? Math.min(4, w, h / 2) : 0
  if (x1 >= x0) return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 - r},${y + h}H${x0}Z`
  return `M${x0},${y}H${x1 + r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 + r},${y + h}H${x0}Z`
}

export interface BarRow {
  key: string
  label: string
  /** One bar, or the parts of a stacked one. */
  parts: { value: number; colour: string; name?: string }[]
  /** At the end of the bar. Defaults to the total, formatted. */
  shown?: string
  tip?: TipRow[]
}

/** Horizontal bars: a name, a bar and its figure a row. Negative values run left from a shared zero. */
export function Bars({
  rows,
  format,
  label,
  onPick,
}: {
  rows: BarRow[]
  format: (v: number) => string
  label: string
  /** Makes each row a link: for a list that opens somewhere. */
  onPick?: (key: string) => void
}) {
  const s = useStyles()
  const [ref, box] = useElementBox<HTMLDivElement>()
  const [tip, setTip] = useState<Tip | null>(null)
  const [hot, setHot] = useState<string | null>(null)
  const width = Math.max(240, box.width)
  const rowH = 32
  const bar = 18
  const totals = rows.map((r) => r.parts.reduce((sum, p) => sum + p.value, 0))
  const shown = rows.map((r, i) => r.shown ?? format(totals[i]!))
  const labelW = Math.min(width * 0.42, Math.max(0, ...rows.map((r) => textWidth(r.label, LABEL))))
  const valueW = Math.max(0, ...shown.map((t) => textWidth(t, TICK, 600)))
  const low = Math.min(0, ...totals)
  const high = Math.max(0, ...totals) || 1
  const left = labelW + 12
  const plotW = Math.max(40, width - left - valueW - 12 - (low < 0 ? valueW + 8 : 0))
  const plotLeft = left + (low < 0 ? valueW + 8 : 0)
  const x = (v: number) => plotLeft + ((v - low) / (high - low)) * plotW
  const height = rows.length * rowH + 2

  return (
    <div ref={ref} className={s.chart} onMouseLeave={() => { setTip(null); setHot(null) }}>
      {box.width > 0 && (
        <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ fontFamily: tokens.fontFamilyBase, display: 'block', overflow: 'visible' }}>
          <line x1={x(0)} x2={x(0)} y1={0} y2={rows.length * rowH} style={{ stroke: tokens.colorNeutralStroke1 }} />
          {rows.map((r, i) => {
            const y = i * rowH + (rowH - bar) / 2
            const total = totals[i]!
            let from = 0
            const lastPart = r.parts.findLastIndex((p) => p.value !== 0)
            return (
              <g key={r.key} opacity={hot && hot !== r.key ? 0.55 : 1}>
                <text x={left - 12} y={y + bar / 2} dy="0.35em" textAnchor="end" fontSize={LABEL} style={{ fill: tokens.colorNeutralForeground2 }}>
                  {clip(r.label, LABEL, labelW)}
                </text>
                {r.parts.map((p, pi) => {
                  if (!p.value) return null
                  const x0 = x(from) + (pi > 0 && from !== 0 ? 2 : 0) // a gap in the card's colour between parts
                  from += p.value
                  const x1 = x(from)
                  if (Math.abs(x1 - x0) < 1) return null
                  return <path key={pi} d={barPath(x0, x1, y, bar, pi === lastPart)} style={{ fill: p.colour }} />
                })}
                <text
                  x={total < 0 ? x(total) - 6 : Math.max(x(0), x(total)) + 6}
                  y={y + bar / 2}
                  dy="0.35em"
                  textAnchor={total < 0 ? 'end' : 'start'}
                  fontSize={TICK}
                  fontWeight={600}
                  style={{ fill: tokens.colorNeutralForeground1, fontVariantNumeric: 'tabular-nums' }}
                >
                  {shown[i]}
                </text>
                <rect
                  x={0}
                  y={i * rowH}
                  width={width}
                  height={rowH}
                  style={{ fill: 'transparent' }}
                  className={onPick ? s.clickable : undefined}
                  onClick={onPick ? () => onPick(r.key) : undefined}
                  onMouseMove={(e) => {
                    const b = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                    setHot(r.key)
                    setTip({
                      x: ((e.clientX - b.left) / b.width) * width,
                      y: i * rowH + rowH,
                      head: r.label,
                      rows: r.tip ?? r.parts.map((p) => ({ colour: r.parts.length > 1 ? p.colour : undefined, value: format(p.value), name: p.name })),
                    })
                  }}
                />
              </g>
            )
          })}
        </svg>
      )}
      <TipBox tip={tip} width={width} />
    </div>
  )
}

// ---- A bar a year ----------------------------------------------------------------------------

/**
 * A few years, one bar a series in each, with its figure at the end: easier to read off than a
 * line when there are only five years and the figures matter more than the shape.
 */
export function YearBars({
  years,
  series,
  format,
  label,
  top,
}: {
  years: (number | string)[]
  series: { key: string; label: string; colour: string; values: (number | null)[] }[]
  format: (v: number) => string
  label: string
  /** The value a full-width bar stands for, such as 1 for a share. Defaults to the largest value. */
  top?: number
}) {
  const s = useStyles()
  const [ref, box] = useElementBox<HTMLDivElement>()
  const width = Math.max(240, box.width)
  const bar = 16
  const gapInside = 3
  const gapBetween = 12
  const groupH = series.length * bar + (series.length - 1) * gapInside
  const height = years.length * groupH + (years.length - 1) * gapBetween + 2
  const all = series.flatMap((x) => x.values.filter((v): v is number => v !== null))
  const max = top ?? (Math.max(0, ...all) || 1)
  const labelW = Math.max(0, ...years.map((y) => textWidth(String(y), LABEL)))
  const valueW = Math.max(0, ...all.map((v) => textWidth(format(v), TICK, 600)))
  const left = labelW + 12
  const plotW = Math.max(40, width - left - valueW - 10)
  return (
    <div ref={ref} className={s.chart}>
      {box.width > 0 && (
        <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ fontFamily: tokens.fontFamilyBase, display: 'block', overflow: 'visible' }}>
          <line x1={left} x2={left} y1={0} y2={height - 2} style={{ stroke: tokens.colorNeutralStroke1 }} />
          {years.map((year, yi) => {
            const y0 = yi * (groupH + gapBetween)
            return (
              <g key={year}>
                <text x={left - 12} y={y0 + groupH / 2} dy="0.35em" textAnchor="end" fontSize={LABEL} style={{ fill: tokens.colorNeutralForeground2 }}>
                  {year}
                </text>
                {series.map((sx, si) => {
                  const v = sx.values[yi]
                  const y = y0 + si * (bar + gapInside)
                  if (v === null || v === undefined) {
                    return (
                      <text key={sx.key} x={left + 6} y={y + bar / 2} dy="0.35em" fontSize={TICK} style={{ fill: tokens.colorNeutralForeground3 }}>
                        —
                      </text>
                    )
                  }
                  const x1 = left + (Math.max(0, v) / max) * plotW
                  return (
                    <g key={sx.key}>
                      <title>{`${year}, ${sx.label}: ${format(v)}`}</title>
                      <path d={barPath(left, Math.max(left + 2, x1), y, bar, true)} style={{ fill: sx.colour }} />
                      <text x={Math.max(left + 2, x1) + 6} y={y + bar / 2} dy="0.35em" fontSize={TICK} fontWeight={600} style={{ fill: tokens.colorNeutralForeground1, fontVariantNumeric: 'tabular-nums' }}>
                        {format(v)}
                      </text>
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

// ---- Where one figure sits -------------------------------------------------------------------

/**
 * Where one charity's figure sits among charities of its size: a track from the lowest on the
 * left to the highest on the right, filled up to a marker at its place. The words beside it say
 * the same thing, so the bar is never the only way to read it.
 */
export function PositionBar({ share, level, label }: { share: number | null; level: Level; label: string }) {
  const s = useStyles()
  if (share === null) return <div className={s.track} role="img" aria-label={label} style={{ opacity: 0.5 }} />
  const at = Math.max(0, Math.min(1, share)) * 100
  const colour = level ? LEVEL_COLOUR[level] : PLAIN
  return (
    <div className={s.track} role="img" aria-label={label} title={label}>
      <div className={s.trackFill} style={{ width: `${at}%`, backgroundColor: colour }} />
      <div className={s.trackMark} style={{ left: `${at}%`, backgroundColor: colour }} />
    </div>
  )
}
