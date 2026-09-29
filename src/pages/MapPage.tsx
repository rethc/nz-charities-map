import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { BottomSheet } from '../components/BottomSheet'
import { CharityDetails, CharityGroup } from '../components/CharityDetails'
import { CharityMap, type CharityMapHandle, type Insets, type MapPick } from '../components/CharityMap'
import { BrandMark, CloseIcon, Spinner } from '../components/Icons'
import { SearchBox } from '../components/SearchBox'
import { SectorFilter } from '../components/SectorFilter'
import { useCharities } from '../hooks/useCharities'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useElementBox } from '../hooks/useElementBox'
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/useMediaQuery'
import { toFeatureCollection, type CharityPoint } from '../lib/charities'
import { formatCount, isTypingTarget } from '../lib/dom'
import { DEFAULT_VIEW, MOBILE_ZOOM, type LonLat } from '../lib/geo'
import { searchCharities } from '../lib/search'
import { OTHER_COLOUR } from '../lib/sectors'

interface Group {
  ccs: string[]
  lonLat: LonLat
}

type Selection =
  | { kind: 'charity'; cc: string; group: Group | null; focus: boolean }
  | { kind: 'group'; group: Group; focus: boolean }

/** Room below a dot for its name label, so the label isn't hidden under the bottom sheet. */
const LABEL_ROOM = 56

/** "Zoom to these" is offered when the matches are few enough to be worth framing. */
const MAX_FIT = 5000

const linkButton =
  'font-semibold text-paper underline decoration-ink-line underline-offset-4 hover:decoration-kowhai'

function selectionFromUrl(params: URLSearchParams): Selection | null {
  const cc = params.get('cc')?.trim().toUpperCase()
  return cc && /^CC\d+$/.test(cc) ? { kind: 'charity', cc, group: null, focus: false } : null
}

export function MapPage() {
  const charities = useCharities()
  const dataset = charities.data
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const [searchParams, setSearchParams] = useSearchParams()

  // The URL seeds the initial state; after that, state is mirrored back into it (replace, not push).
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '')
  const [sectors, setSectors] = useState<ReadonlySet<string>>(() => new Set(searchParams.getAll('sector')))
  const [selection, setSelection] = useState<Selection | null>(() => selectionFromUrl(searchParams))
  const [notice, setNotice] = useState<string | null>(null)
  const [sheetHeight, setSheetHeight] = useState(0)
  const [initialZoom] = useState(() => (window.matchMedia(DESKTOP_QUERY).matches ? DEFAULT_VIEW.zoom : MOBILE_ZOOM))
  const [headerRef, headerBox] = useElementBox<HTMLElement>()
  const mapRef = useRef<CharityMapHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pendingDeepLink = useRef(selection?.kind === 'charity' ? selection.cc : null)
  const titleId = useId()

  const debouncedQuery = useDebouncedValue(query, 200)
  const search = useMemo(
    () => (dataset ? searchCharities(dataset.points, debouncedQuery) : null),
    [dataset, debouncedQuery],
  )

  // Sector counts follow the search, so the pills show where the matches are.
  const sectorCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of dataset?.points ?? []) {
      if (!search || search.matches.has(p.index)) counts.set(p.sector, (counts.get(p.sector) ?? 0) + 1)
    }
    return counts
  }, [dataset, search])

  const visible = useMemo(
    () =>
      (dataset?.points ?? []).filter(
        (p) => (!search || search.matches.has(p.index)) && (sectors.size === 0 || sectors.has(p.sector)),
      ),
    [dataset, search, sectors],
  )
  const features = useMemo(
    () => (dataset ? toFeatureCollection(visible, dataset.colourBySector) : null),
    [dataset, visible],
  )
  const colourOf = useCallback(
    (sector: string) => dataset?.colourBySector.get(sector) ?? OTHER_COLOUR,
    [dataset],
  )

  // Mirror state into the URL so any view can be shared or bookmarked.
  const urlCc = selection?.kind === 'charity' ? selection.cc : null
  const sectorKey = [...sectors].sort().join('\n')
  useEffect(() => {
    const next = new URLSearchParams()
    const q = debouncedQuery.trim()
    if (q) next.set('q', q)
    for (const s of sectorKey ? sectorKey.split('\n') : []) next.append('sector', s)
    if (urlCc) next.set('cc', urlCc)
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
  }, [debouncedQuery, sectorKey, urlCc, searchParams, setSearchParams])

  // A shared link (?cc=CC12345) flies to that charity once the data arrives.
  useEffect(() => {
    const cc = pendingDeepLink.current
    if (!dataset || !cc) return
    pendingDeepLink.current = null
    const point = dataset.byCc.get(cc)
    if (point) {
      mapRef.current?.flyTo(point.lonLat, 15)
    } else {
      setSelection(null)
      setNotice(`${cc} isn't on the map. It may be deregistered, or its address hasn't been placed yet.`)
    }
  }, [dataset])

  const selectedPoint = selection?.kind === 'charity' ? (dataset?.byCc.get(selection.cc) ?? null) : null
  const selectedLonLat = selection?.kind === 'group' ? selection.group.lonLat : (selectedPoint?.lonLat ?? null)

  const closeSelection = useCallback((returnFocus: boolean) => {
    setSelection(null)
    if (returnFocus) searchRef.current?.focus()
  }, [])

  const handlePick = useCallback((pick: MapPick) => {
    setNotice(null)
    if (pick.type === 'none') setSelection(null)
    else if (pick.type === 'charity') setSelection({ kind: 'charity', cc: pick.cc, group: null, focus: false })
    else setSelection({ kind: 'group', group: { ccs: pick.ccs, lonLat: pick.lonLat }, focus: false })
  }, [])

  const pickFromSearch = useCallback((point: CharityPoint) => {
    setNotice(null)
    setSectors((prev) => (prev.size && !prev.has(point.sector) ? new Set() : prev))
    setSelection({ kind: 'charity', cc: point.cc, group: null, focus: true })
    mapRef.current?.flyTo(point.lonLat, 15)
  }, [])

  const toggleSector = useCallback((name: string) => {
    setSectors((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])
  const clearSectors = useCallback(() => setSectors(new Set()), [])
  const clearFilters = () => {
    setQuery('')
    setSectors(new Set())
  }

  // "/" jumps to search; Escape closes the details.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/' && !isTypingTarget(e.target)) {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape' && selection) {
        closeSelection(selection.focus)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selection, closeSelection])

  // Phones: keep the selected place clear of the header and the bottom sheet.
  const [selLon, selLat] = selectedLonLat ?? []
  useEffect(() => {
    if (isDesktop || selLon === undefined || selLat === undefined || sheetHeight === 0) return
    mapRef.current?.ensureVisible([selLon, selLat], { top: headerBox.bottom, right: 0, bottom: sheetHeight + LABEL_ROOM, left: 0 })
  }, [isDesktop, selLon, selLat, sheetHeight, headerBox.bottom])

  const fitPadding = useMemo<Insets>(
    () =>
      isDesktop
        ? { top: 48, right: 48, bottom: 48, left: headerBox.right + 24 }
        : { top: headerBox.bottom + 16, right: 32, bottom: 40, left: 32 },
    [isDesktop, headerBox.right, headerBox.bottom],
  )

  let panel: ReactNode = null
  if (dataset && selection?.kind === 'charity' && selectedPoint) {
    const { group, focus } = selection
    panel = (
      <CharityDetails
        key={selectedPoint.cc}
        point={selectedPoint}
        colour={colourOf(selectedPoint.sector)}
        titleId={titleId}
        focusOnMount={focus}
        onClose={() => closeSelection(focus)}
        onBack={group ? () => setSelection({ kind: 'group', group, focus: true }) : undefined}
        backLabel={group ? `All ${group.ccs.length} at this location` : undefined}
      />
    )
  } else if (dataset && selection?.kind === 'group') {
    const { group, focus } = selection
    panel = (
      <CharityGroup
        key={group.ccs.join()}
        points={group.ccs.map((cc) => dataset.byCc.get(cc)).filter((p): p is CharityPoint => p !== undefined)}
        colourOf={colourOf}
        titleId={titleId}
        focusOnMount={focus}
        onClose={() => closeSelection(focus)}
        onPick={(p) => setSelection({ kind: 'charity', cc: p.cc, group, focus: true })}
      />
    )
  }

  const filtered = search !== null || sectors.size > 0
  const total = dataset?.points.length ?? 0
  let status: ReactNode
  if (charities.status === 'loading') {
    status = (
      <p role="status" className="flex items-center gap-2">
        <Spinner size={16} />
        Loading charities…
      </p>
    )
  } else if (charities.status === 'error') {
    status = (
      <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-paper">Couldn't load the charities. {charities.error}</p>
        <button type="button" onClick={charities.retry} className={linkButton}>
          Try again
        </button>
      </div>
    )
  } else {
    status = (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p aria-live="polite">
          {visible.length === 0
            ? 'No charities match these filters.'
            : filtered
              ? `Showing ${formatCount(visible.length)} of ${formatCount(total)} charities`
              : `Showing all ${formatCount(total)} charities`}
        </p>
        {filtered && visible.length > 0 && visible.length <= MAX_FIT && (
          <button
            type="button"
            onClick={() => mapRef.current?.fitPoints(visible.map((p) => p.lonLat))}
            className={linkButton}
          >
            Zoom to these
          </button>
        )}
        {filtered && (
          <button type="button" onClick={clearFilters} className={linkButton}>
            Clear filters
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-hidden bg-[#e9efed]">
      <header
        ref={headerRef}
        className="on-ink absolute inset-x-0 top-0 z-20 rounded-b-2xl bg-ink px-4 pt-[max(env(safe-area-inset-top),0.875rem)] pb-3.5 text-paper shadow-float md:inset-x-auto md:top-4 md:left-4 md:w-[27rem] md:rounded-2xl md:p-4"
      >
        <div className="mb-3 flex items-center gap-2.5">
          <BrandMark size={26} />
          <h1 className="text-[1.0625rem] leading-tight font-bold">NZ Charities Map</h1>
        </div>
        <SearchBox
          value={query}
          onChange={setQuery}
          results={search?.top ?? null}
          totalMatches={search?.matches.size ?? 0}
          onPick={pickFromSearch}
          colourOf={colourOf}
          inputRef={searchRef}
        />
        {dataset && (
          <div className="mt-3">
            <SectorFilter
              sectors={dataset.sectors}
              counts={sectorCounts}
              selected={sectors}
              onToggle={toggleSector}
              onClear={clearSectors}
            />
          </div>
        )}
        <div className="mt-3 text-sm text-mist">{status}</div>
        {notice && (
          <div role="status" className="mt-3 flex items-start gap-2 rounded-lg bg-ink-soft px-3 py-2 text-sm">
            <p className="min-w-0 flex-1">{notice}</p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              className="-mr-1 grid size-6 flex-none place-items-center rounded text-mist hover:text-paper"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        )}
      </header>

      <main className="absolute inset-0" aria-label="Map of registered charities">
        <CharityMap
          ref={mapRef}
          data={features}
          selectedCc={selectedPoint?.cc ?? null}
          popup={isDesktop && panel && selectedLonLat ? { lonLat: selectedLonLat, content: panel } : null}
          initialZoom={initialZoom}
          fitPadding={fitPadding}
          onPick={handlePick}
        />
        {!isDesktop && panel && (
          <BottomSheet
            labelledBy={titleId}
            onClose={() => closeSelection(selection?.focus ?? false)}
            onHeightChange={setSheetHeight}
          >
            {panel}
          </BottomSheet>
        )}
      </main>
    </div>
  )
}
