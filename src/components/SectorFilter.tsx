import { useId, useState } from 'react'
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

/** Sectors with their own colour; where the pills are always on show the long tail sits behind "More". */
const PRIMARY = 8

const pill =
  'inline-flex h-8 flex-none items-center gap-2 rounded-full border px-3 text-sm whitespace-nowrap transition-colors'
const pillOff = 'border-ink-line text-paper hover:border-mist'
const pillOn = 'border-paper bg-paper text-ink font-semibold'
const textButton =
  'inline-flex h-8 items-center px-1 text-sm font-semibold text-mist underline decoration-ink-line underline-offset-4 hover:text-paper'

/** Holds the filter's place while the charities load, so the header doesn't jump when they arrive. */
export function SectorFilterSkeleton() {
  return (
    <div className="flex flex-wrap gap-2" aria-hidden="true">
      {[6.5, 13.5, 17, 14, 8.5, 14.5, 10.5, 11.5, 15].map((rem, i) => (
        <span
          key={rem}
          className={`h-8 animate-pulse rounded-full bg-ink-soft motion-reduce:animate-none ${i ? 'hidden pills:block' : ''}`}
          style={{ width: `${rem}rem` }}
        />
      ))}
    </div>
  )
}

/**
 * Roomy screens (`pills:`): the pills are always on show and double as the map legend.
 * Phones and short windows: one button opens the pills below it, wrapped over several
 * lines, so no pill is ever cut off at the screen edge and the map keeps its space.
 */
export function SectorFilter({ sectors, counts, selected, onToggle, onClear }: SectorFilterProps) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const hiddenCount = Math.max(0, sectors.length - PRIMARY)
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
        className={`${pill} ${chosen.length ? pillOn : pillOff} max-w-full pills:hidden`}
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
        // Behind the button, the list scrolls and fades out at the bottom edge to show there is more.
        className={`${open ? 'flex' : 'hidden'} mt-3 max-h-[min(45dvh,calc(100dvh-16rem))] flex-wrap gap-2 overflow-y-auto overscroll-contain pb-3 [mask-image:linear-gradient(to_bottom,#000_calc(100%-1.25rem),transparent)] pills:mt-0 pills:flex pills:max-h-none pills:overflow-visible pills:pb-0 pills:[mask-image:none]`}
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
          // With the pills always on show the long tail is tucked away; behind the button, everything is listed.
          const tucked = i >= PRIMARY && !expanded && !on
          return (
            <button
              key={s.name}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(s.name)}
              className={`${pill} ${on ? pillOn : pillOff} ${count === 0 && !on ? 'opacity-60' : ''} ${tucked ? 'pills:hidden' : ''}`}
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
            className={`${textButton} hidden pills:inline-flex`}
          >
            {expanded ? 'Fewer sectors' : `${hiddenCount} more sectors`}
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)} className={`${textButton} pills:hidden`}>
          Done
        </button>
      </div>
    </div>
  )
}
