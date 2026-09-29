import { useId, useState, type KeyboardEvent, type Ref } from 'react'
import type { CharityPoint } from '../lib/charities'
import { CloseIcon, SearchIcon } from './Icons'

interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
  /** Top suggestions for the current (debounced) query, or null when there's no query. */
  results: CharityPoint[] | null
  totalMatches: number
  onPick: (point: CharityPoint) => void
  colourOf: (sector: string) => string
  disabled?: boolean
  inputRef?: Ref<HTMLInputElement>
}

/** ARIA 1.2 combobox: typing filters the map; the list offers the best few matches to jump to. */
export function SearchBox({
  value,
  onChange,
  results,
  totalMatches,
  onPick,
  colourOf,
  disabled,
  inputRef,
}: SearchBoxProps) {
  const id = useId()
  const listId = `${id}-list`
  const optionId = (i: number) => `${id}-opt-${i}`
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const options = results ?? []
  const showList = open && results !== null
  const activeIndex = active < options.length ? active : -1

  function pick(point: CharityPoint) {
    setOpen(false)
    setActive(-1)
    onPick(point)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!options.length) return
        e.preventDefault()
        setOpen(true)
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => (i + step + options.length + (i < 0 && step < 0 ? 1 : 0)) % options.length)
        break
      }
      case 'Enter': {
        const target = options[activeIndex] ?? (options.length === 1 || activeIndex < 0 ? options[0] : undefined)
        if (target && showList) {
          e.preventDefault()
          pick(target)
        }
        break
      }
      case 'Escape':
        if (showList) {
          e.preventDefault()
          e.stopPropagation()
          setOpen(false)
          setActive(-1)
        } else if (value) {
          e.preventDefault()
          e.stopPropagation()
          onChange('')
        }
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        Search charities by name or registration number
      </label>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
      <input
        id={id}
        ref={inputRef}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        placeholder="Search by name or CC number"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="h-11 w-full rounded-xl bg-white pr-11 pl-10 text-base text-ink placeholder:text-muted disabled:opacity-70"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-muted hover:bg-paper hover:text-ink"
        >
          <CloseIcon size={16} />
        </button>
      ) : (
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border border-line px-1.5 text-xs text-muted md:block"
        >
          /
        </kbd>
      )}

      <div
        className={`absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-xl bg-white text-ink shadow-float ${showList ? '' : 'hidden'}`}
      >
        <div id={listId} role="listbox" aria-label="Matching charities" className="max-h-[min(22rem,50dvh)] overflow-y-auto">
          {options.map((p, i) => (
            <div
              key={p.cc}
              id={optionId(i)}
              role="option"
              tabIndex={-1}
              aria-label={p.place ? `${p.name}, ${p.cc}, ${p.place}` : `${p.name}, ${p.cc}`}
              aria-selected={i === activeIndex}
              // mousedown (not click) so the input doesn't blur and close the list first
              onMouseDown={(e) => {
                e.preventDefault()
                pick(p)
              }}
              onMouseMove={() => setActive(i)}
              className={`flex cursor-pointer items-start gap-3 px-4 py-2.5 ${i === activeIndex ? 'bg-paper' : ''}`}
            >
              <span className="sector-dot mt-1.5 text-ink" style={{ backgroundColor: colourOf(p.sector) }} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block leading-snug font-semibold break-words">{p.name}</span>
                <span className="block text-sm text-muted">{p.place ? `${p.cc}, ${p.place}` : p.cc}</span>
              </span>
            </div>
          ))}
        </div>
        {results !== null && options.length === 0 && (
          <p className="px-4 py-3 text-[0.9375rem]">
            No charities match “{value.trim()}”. Try fewer words, or a registration number like CC12345.
          </p>
        )}
        {totalMatches > options.length && (
          <p className="border-t border-line px-4 py-2 text-sm text-muted">
            {totalMatches.toLocaleString('en-NZ')} matches, all shown on the map
          </p>
        )}
      </div>
    </div>
  )
}
