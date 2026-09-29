import { useState } from 'react'
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

  return (
    <div
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
