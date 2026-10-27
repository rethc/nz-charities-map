import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { BottomSheet, SidePanel, type PanelSize } from '../components/BottomSheet'
import { CharityDetails, CharityGroup, type PartOf } from '../components/CharityDetails'
import {
  CharityMap,
  type CharityMapHandle,
  type Insets,
  type MapPick,
  type MapSelection,
} from '../components/CharityMap'
import { BrandMark, CloseIcon, ListIcon, Spinner } from '../components/Icons'
import { SearchBox } from '../components/SearchBox'
import { SectorFilter, SectorFilterSkeleton } from '../components/SectorFilter'
import { useCharities } from '../hooks/useCharities'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useElementBox } from '../hooks/useElementBox'
import { CARD_QUERY, POPUP_QUERY, PORTRAIT_QUERY, SHORT_QUERY, useMediaQuery } from '../hooks/useMediaQuery'
import { toFeatureCollection, type CharityPoint } from '../lib/charities'
import { formatCount, isTypingTarget } from '../lib/dom'
import { DEFAULT_VIEW, MOBILE_ZOOM, NZ_MAINLAND, type LonLat } from '../lib/geo'
import { searchCharities } from '../lib/search'
import { OTHER_COLOUR } from '../lib/sectors'

interface Group {
  ccs: string[]
  lonLat: LonLat
}

type Selection =
  | { kind: 'charity'; cc: string; group: Group | null; focus: boolean }
  | { kind: 'group'; group: Group; focus: boolean }

/** How far in a search result or shared link is shown. */
const PLACE_ZOOM = 15

/** Kept free between the header and a bottom sheet, so the selected place's pin always shows. */
const ROOM_FOR_PIN = 112

/** The zoom and locate buttons down the right edge, and the attribution along the bottom, which the popup keeps clear of. */
const ROOM_FOR_CONTROLS = 64
const ROOM_FOR_ATTRIBUTION = 28

/** "Zoom to these" is offered when the matches are few enough to be worth framing. */
const MAX_FIT = 5000

/** On the dark header: white, underlined, so it reads as a link without a link colour. */
const linkButton = 'font-semibold text-white underline decoration-mist underline-offset-4 hover:decoration-white'

function selectionFromUrl(params: URLSearchParams): Selection | null {
  const cc = params.get('cc')?.trim().toUpperCase()
  // a registered group can carry a suffixed number (CC11026-0)
  return cc && /^CC\d+(-\d+)?$/.test(cc) ? { kind: 'charity', cc, group: null, focus: false } : null
}

export function MapPage() {
  const charities = useCharities()
  const dataset = charities.data
  const cardHeader = useMediaQuery(CARD_QUERY)
  const portrait = useMediaQuery(PORTRAIT_QUERY)
  const roomForPopup = useMediaQuery(POPUP_QUERY)
  const short = useMediaQuery(SHORT_QUERY)
  /** Where the details go: a popup beside the pin, a panel down the left edge, or a sheet along the bottom. */
  const layout = roomForPopup ? 'popup' : short ? 'side' : 'sheet'
  const [searchParams, setSearchParams] = useSearchParams()

  // The URL seeds the initial state; after that, state is mirrored back into it (replace, not push).
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '')
  const [sectors, setSectors] = useState<ReadonlySet<string>>(() => new Set(searchParams.getAll('sector')))
  const [selection, setSelection] = useState<Selection | null>(() => selectionFromUrl(searchParams))
  // A new `key` asks the map to centre on the selected place; a shared link starts with one pending.
  const [camera, setCamera] = useState<{ key: number; zoom?: number }>(() =>
    selection ? { key: 1, zoom: PLACE_ZOOM } : { key: 0 },
  )
  const [notice, setNotice] = useState<string | null>(null)
  // The sheet or side panel, once it has measured itself.
  const [panelSize, setPanelSize] = useState<PanelSize>({ width: 0, height: 0 })
  const [initialZoom] = useState(() => (window.matchMedia(CARD_QUERY).matches ? DEFAULT_VIEW.zoom : MOBILE_ZOOM))
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
    // A search for the open charity's own number adds nothing but a map with every other pin hidden,
    // so the address is just ?cc=CC47935, as the copy-link button gives.
    if (q && q.replace(/\s/g, '').toUpperCase() !== urlCc) next.set('q', q)
    for (const s of sectorKey ? sectorKey.split('\n') : []) next.append('sector', s)
    if (urlCc) next.set('cc', urlCc)
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
  }, [debouncedQuery, sectorKey, urlCc, searchParams, setSearchParams])

  // A shared link (?cc=CC12345) to a charity that isn't in the data gets an explanation instead.
  useEffect(() => {
    const cc = pendingDeepLink.current
    if (!dataset || !cc) return
    pendingDeepLink.current = null
    if (!dataset.byCc.has(cc)) {
      setSelection(null)
      setNotice(`${cc} isn't on the map. It may be deregistered, or its address hasn't been placed yet.`)
    }
  }, [dataset])

  const selectedPoint = selection?.kind === 'charity' ? (dataset?.byCc.get(selection.cc) ?? null) : null
  // Reached directly (a search, a shared link), a charity still offers the others at its address.
  const neighbours = useMemo<Group | null>(() => {
    if (!selectedPoint) return null
    const ccs = visible.filter((p) => p.spot === selectedPoint.spot).map((p) => p.cc)
    return ccs.length > 1 ? { ccs, lonLat: selectedPoint.lonLat } : null
  }, [selectedPoint, visible])
  // The pin takes the charity's own colour, or shows a count for several at one address.
  const groupPoint = selection?.kind === 'group' ? (dataset?.byCc.get(selection.group.ccs[0] ?? '') ?? null) : null
  const pinPoint = selectedPoint ?? groupPoint
  const pinColour = pinPoint ? colourOf(pinPoint.sector) : OTHER_COLOUR
  const pinCount = selection?.kind === 'group' ? selection.group.ccs.length : 1
  // A group picked off the map can span addresses a metre or two apart: the pin stands for all of
  // them (also while one of its members is open), so none of their badges peek out from under it.
  const pinGroup = selection?.group ?? null
  const pinSpots = useMemo(() => {
    if (!pinPoint) return null
    const spots = new Set([pinPoint.spot])
    for (const cc of pinGroup?.ccs ?? []) {
      const p = dataset?.byCc.get(cc)
      if (p) spots.add(p.spot)
    }
    return [...spots]
  }, [pinPoint, pinGroup, dataset])
  const selected = useMemo<MapSelection | null>(
    () =>
      pinPoint && pinSpots
        ? { lonLat: pinPoint.lonLat, spots: pinSpots, colour: pinColour, count: pinCount }
        : null,
    [pinPoint, pinSpots, pinColour, pinCount],
  )

  const closeSelection = useCallback((returnFocus: boolean) => {
    setSelection(null)
    if (returnFocus) searchRef.current?.focus()
  }, [])

  const handlePick = useCallback((pick: MapPick) => {
    setNotice(null)
    if (pick.type === 'none') {
      setSelection(null)
      return
    }
    if (pick.type === 'charity') setSelection({ kind: 'charity', cc: pick.cc, group: null, focus: false })
    else setSelection({ kind: 'group', group: { ccs: pick.ccs, lonLat: pick.lonLat }, focus: false })
    setCamera((c) => ({ key: c.key + 1 }))
  }, [])

  /** Show a charity chosen by name (a search result, a group's member) and move the map to it. */
  const showCharity = useCallback((point: CharityPoint) => {
    setNotice(null)
    setSectors((prev) => (prev.size && !prev.has(point.sector) ? new Set() : prev))
    setSelection({ kind: 'charity', cc: point.cc, group: null, focus: true })
    setCamera((c) => ({ key: c.key + 1, zoom: PLACE_ZOOM }))
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

  const framed = useRef(false)
  // The part of the map that the header and the details leave free: where the selected place belongs.
  const freeArea = useMemo<Insets | null>(() => {
    if (layout === 'popup') {
      return { top: 0, right: ROOM_FOR_CONTROLS, bottom: ROOM_FOR_ATTRIBUTION, left: headerBox.right }
    }
    if (panelSize.height === 0) return null // the sheet or side panel hasn't measured itself yet
    if (layout === 'side') return { top: 0, right: 0, bottom: 0, left: panelSize.width }
    return cardHeader
      ? { top: 0, right: 0, bottom: panelSize.height, left: headerBox.right }
      : { top: headerBox.bottom, right: 0, bottom: panelSize.height, left: 0 }
  }, [layout, cardHeader, panelSize, headerBox.right, headerBox.bottom])

  // Centre the selected place there.
  const [selLon, selLat] = selected?.lonLat ?? []
  const centred = useRef(0)
  useEffect(() => {
    if (selLon === undefined || selLat === undefined || !freeArea) return
    if (centred.current !== camera.key) {
      centred.current = camera.key
      framed.current = true // too late to open on the whole country
      mapRef.current?.focusOn([selLon, selLat], freeArea, camera.zoom)
    } else if (layout !== 'popup') {
      // The header or the panel changed size: move only if the place is now covered.
      mapRef.current?.ensureVisible([selLon, selLat], freeArea)
    }
  }, [camera, selLon, selLat, freeArea, layout])

  const fitPadding = useMemo<Insets>(() => {
    if (!cardHeader) return { top: headerBox.bottom + 16, right: 32, bottom: 40, left: 32 }
    // Beside the header card; on an upright tablet there is more room below it.
    return portrait
      ? { top: headerBox.bottom + 24, right: 48, bottom: 48, left: 48 }
      : { top: 48, right: 48, bottom: 48, left: headerBox.right + 24 }
  }, [cardHeader, portrait, headerBox.right, headerBox.bottom])

  // Open on the whole country, framed in the part of the map the header leaves free.
  useEffect(() => {
    if (framed.current || headerBox.height === 0) return
    framed.current = true
    mapRef.current?.fitPoints(NZ_MAINLAND, false)
  }, [headerBox.height])

  let panel: ReactNode = null
  if (dataset && selection?.kind === 'charity' && selectedPoint) {
    const { focus } = selection
    const group = selection.group ?? neighbours
    // Registered groups: a member names its group, and a group lists its members.
    const groupName = selectedPoint.partOf ? dataset.groupNames.get(selectedPoint.partOf) : undefined
    const partOf: PartOf | null =
      selectedPoint.partOf && groupName
        ? { name: groupName, point: dataset.byCc.get(selectedPoint.partOf) ?? null }
        : null
    panel = (
      <CharityDetails
        key={selectedPoint.cc}
        point={selectedPoint}
        colour={colourOf(selectedPoint.sector)}
        partOf={partOf}
        members={selectedPoint.isGroup ? dataset.members.get(selectedPoint.cc) : undefined}
        colourOf={colourOf}
        onGoTo={showCharity}
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
        <p className="text-white">Couldn't load the charities. {charities.error}</p>
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
    <div className="relative h-full overflow-hidden bg-[#f8f4f0]">
      <header
        ref={headerRef}
        // The side panel takes the header's place while it is open.
        className={`on-ink absolute inset-x-0 top-0 z-20 rounded-b-2xl bg-ink px-4 pt-[max(env(safe-area-inset-top),0.875rem)] pb-3.5 text-white shadow-float card:inset-x-auto card:top-4 card:left-[max(1rem,env(safe-area-inset-left))] card:w-[min(27rem,56vw)] card:rounded-2xl card:p-4 ${layout === 'side' && panel ? 'hidden' : ''}`}
      >
        <div className="mb-3 flex items-center gap-2.5">
          <BrandMark size={26} />
          <h1 className="font-display text-base leading-tight font-semibold">NZ Charities Map</h1>
          {/* A plain link, not a router one: the browse pages are static files built after the app (scripts/seo).
              Square-cornered with an icon, so it reads as a way to another page, not one of the round filter pills. */}
          <a
            href="/browse/"
            className="ml-auto inline-flex h-9 flex-none items-center justify-center gap-1.5 rounded border border-ink-line px-3 text-base font-semibold text-white transition-colors hover:border-mist hover:bg-ink-soft active:bg-ink"
          >
            <ListIcon size={16} />
            {/* One piece of text, so the flex gap doesn't open up between the words. */}
            <span>
              Browse<span className="max-[23rem]:hidden"> by region</span>
            </span>
          </a>
        </div>
        <SearchBox
          value={query}
          onChange={setQuery}
          results={search?.top ?? null}
          totalMatches={search?.matches.size ?? 0}
          onPick={showCharity}
          colourOf={colourOf}
          inputRef={searchRef}
        />
        {dataset ? (
          <div className="mt-3">
            <SectorFilter
              sectors={dataset.sectors}
              counts={sectorCounts}
              selected={sectors}
              onToggle={toggleSector}
              onClear={clearSectors}
            />
          </div>
        ) : (
          charities.status === 'loading' && (
            <div className="mt-3">
              <SectorFilterSkeleton />
            </div>
          )
        )}
        <div className="mt-3 text-sm text-mist">{status}</div>
        {notice && (
          <div role="status" className="mt-3 flex items-start gap-2 rounded bg-ink-soft px-3 py-2 text-base">
            <p className="min-w-0 flex-1">{notice}</p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              className="-mr-1 grid size-6 flex-none place-items-center rounded text-mist hover:bg-ink-line hover:text-white"
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
          selected={selected}
          popup={layout === 'popup' ? panel : null}
          initialZoom={initialZoom}
          fitPadding={fitPadding}
          onPick={handlePick}
        />
        {panel && layout === 'sheet' && (
          <BottomSheet
            labelledBy={titleId}
            onClose={() => closeSelection(selection?.focus ?? false)}
            onSizeChange={setPanelSize}
            // Under a header bar the pin needs the gap; beside a header card it only has to stay off the card.
            clearTop={headerBox.bottom + (cardHeader ? 16 : ROOM_FOR_PIN)}
          >
            {panel}
          </BottomSheet>
        )}
        {panel && layout === 'side' && (
          <SidePanel labelledBy={titleId} onSizeChange={setPanelSize}>
            {panel}
          </SidePanel>
        )}
      </main>
    </div>
  )
}
