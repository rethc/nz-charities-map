import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SectorInfo } from '../lib/sectors'

interface SectorFilterProps {
  sectors: SectorInfo[]
  /** Matches per sector for the current search (all charities when there's no search). */
  counts: Map<string, number>
  selected: ReadonlySet<string>
  onToggle: (sector: string) => void
  onClear: () => void
}

/** Sectors with their own colour; the long tail shares grey and sits behind "More". */
const PRIMARY = 8

const pill =
  'inline-flex h-8 flex-none items-center gap-2 rounded-full border px-3 text-sm whitespace-nowrap transition-colors'
const pillOff = 'border-ink-line text-paper hover:border-mist'
const pillOn = 'border-paper bg-paper text-ink font-semibold'

export function SectorFilter({ sectors, counts, selected, onToggle, onClear }: SectorFilterProps) {
  const [expanded, setExpanded] = useState(false)
  const hiddenCount = Math.max(0, sectors.length - PRIMARY)

  // On phones the pills scroll sideways: fade whichever edge has more to see.
  // (On wider screens they wrap, nothing overflows and no fade is drawn.)
  const rowRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })
  const measure = useCallback(() => {
    const row = rowRef.current
    if (!row) return
    const hidden = row.scrollWidth - row.clientWidth
    const next = { start: row.scrollLeft > 1, end: hidden - row.scrollLeft > 1 }
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [])
  useLayoutEffect(() => measure()) // pill widths change with the counts and selection
  useEffect(() => {
    const row = rowRef.current
    if (!row) return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [measure])
  const fade =
    edges.start || edges.end
      ? `linear-gradient(to right, ${edges.start ? 'transparent, #000 2.5rem' : '#000'}, ${edges.end ? '#000 calc(100% - 3rem), transparent' : '#000'})`
      : undefined

  return (
    <div
      ref={rowRef}
      onScroll={measure}
      style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
      role="group"
      aria-label="Filter by sector"
      // Phones: one swipeable row. Wider screens: wrap, with the long tail behind "More".
      className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
    >
      <button
        type="button"
        aria-pressed={selected.size === 0}
        onClick={onClear}
        className={`${pill} ${selected.size === 0 ? pillOn : pillOff}`}
      >
        All sectors
      </button>

      {sectors.map((s, i) => {
        const on = selected.has(s.name)
        const count = counts.get(s.name) ?? 0
        const tucked = i >= PRIMARY && !expanded && !on
        return (
          <button
            key={s.name}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(s.name)}
            className={`${pill} ${on ? pillOn : pillOff} ${count === 0 && !on ? 'opacity-60' : ''} ${tucked ? 'md:hidden' : ''}`}
          >
            <span className="sector-dot" style={{ backgroundColor: s.colour }} aria-hidden="true" />
            {s.name}
            <span className="tabular-nums opacity-80">{count.toLocaleString('en-NZ')}</span>
          </button>
        )
      })}

      {hiddenCount > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={`${pill} hidden border-transparent font-semibold text-mist underline decoration-ink-line underline-offset-4 hover:text-paper md:inline-flex`}
        >
          {expanded ? 'Fewer sectors' : `${hiddenCount} more sectors`}
        </button>
      )}
    </div>
  )
}
