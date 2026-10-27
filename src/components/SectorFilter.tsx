import { useId, useState } from 'react'
import { formatCount } from '../lib/dom'
import type { SectorInfo } from '../lib/sectors'
import { ChevronDownIcon } from './Icons'

interface SectorFilterProps {
  sectors: SectorInfo[]
  /** Matches per sector for the current search (all charities when there's no search). */
  counts: Map<string, number>
  selected: ReadonlySet<string>
  onToggle: (sector: string) => void
  onClear: () => void
}

const pill =
  'inline-flex h-9 flex-none items-center gap-2 rounded-full border px-3 text-base whitespace-nowrap transition-colors'
const pillOff = 'border-ink-line text-white hover:border-mist hover:bg-ink-soft'
const pillOn = 'border-brand bg-brand text-white font-semibold'
const textButton =
  'inline-flex h-9 items-center px-1 text-base font-semibold text-white underline decoration-mist underline-offset-4 hover:decoration-white'

/** Holds the filter's place while the charities load, so the header doesn't jump when they arrive. */
export function SectorFilterSkeleton() {
  return <span className="block h-9 w-32 animate-pulse rounded-full bg-ink-soft motion-reduce:animate-none" aria-hidden="true" />
}

/**
 * One button opens the sector pills below it, wrapped over several lines, on every screen: the
 * header stays small and the map keeps its space. Open, the pills double as the map's legend.
 */
export function SectorFilter({ sectors, counts, selected, onToggle, onClear }: SectorFilterProps) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const chosen = sectors.filter((s) => selected.has(s.name))
  const summary =
    chosen.length === 0 ? 'All sectors' : chosen.length === 1 ? chosen[0]!.name : `${chosen.length} sectors`

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className={`${pill} ${chosen.length ? pillOn : pillOff} max-w-full`}
      >
        {chosen.slice(0, 3).map((s) => (
          <span key={s.name} className="sector-dot" style={{ backgroundColor: s.colour }} aria-hidden="true" />
        ))}
        <span className="sr-only">Sector filter: </span>
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDownIcon size={16} className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <div
        id={listId}
        role="group"
        aria-label="Filter by sector"
        // The list scrolls and fades out at the bottom edge to show there is more.
        className={`${open ? 'flex' : 'hidden'} mt-3 max-h-[min(45dvh,calc(100dvh-16rem))] flex-wrap gap-2 overflow-y-auto overscroll-contain pb-3 [mask-image:linear-gradient(to_bottom,#000_calc(100%-1.25rem),transparent)]`}
      >
        <button
          type="button"
          aria-pressed={selected.size === 0}
          onClick={onClear}
          className={`${pill} ${selected.size === 0 ? pillOn : pillOff}`}
        >
          All sectors
        </button>

        {sectors.map((s) => {
          const on = selected.has(s.name)
          const count = counts.get(s.name) ?? 0
          return (
            <button
              key={s.name}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(s.name)}
              className={`${pill} ${on ? pillOn : pillOff} ${count === 0 && !on ? 'opacity-60' : ''}`}
            >
              <span className="sector-dot" style={{ backgroundColor: s.colour }} aria-hidden="true" />
              {s.name}
              <span className="tabular-nums opacity-80">{formatCount(count)}</span>
            </button>
          )
        })}

        <button type="button" onClick={() => setOpen(false)} className={textButton}>
          Done
        </button>
      </div>
    </div>
  )
}
