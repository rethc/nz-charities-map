import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { Insets } from '../../components/CharityMap'
import { BrandMark, ExternalIcon, PinIcon, Spinner } from '../../components/Icons'
import { RequireAdmin } from '../../components/RequireAdmin'
import { Toasts, useToasts } from '../../components/Toasts'
import { useElementBox } from '../../hooks/useElementBox'
import { formatAddress, registerUrl } from '../../lib/charities'
import type { ReviewQueueItem, SyncStatus } from '../../lib/database.types'
import { formatCount, isTypingTarget } from '../../lib/dom'
import { boundsOf, type LonLat } from '../../lib/geo'
import { geocodeAddress, type GeocodeCandidate } from '../../lib/geocode'
import { fold } from '../../lib/search'
import { supabase } from '../../lib/supabase'
import { TriageMap, type CameraTarget } from './TriageMap'

const QUEUE_LIMIT = 500
/** Results spread wider than this (≈2 km) are framed together rather than flying to the first. */
const SPREAD_DEG = 0.02
const NO_CANDIDATES: GeocodeCandidate[] = []
const ignorePin = () => {}

type Pin = { lonLat: LonLat; source: 'suggested' | 'candidate' | 'placed' }
type GeoState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; query: string; candidates: GeocodeCandidate[]; notice?: string }
  | { status: 'error'; message: string }
type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }

const dateTime = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

const sameSpot = (a: LonLat, b: LonLat) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7

function joinSentence(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

function describeCandidate(c: GeocodeCandidate): string {
  const source = c.source === 'linz' ? 'LINZ' : 'OpenStreetMap'
  const precision = c.precision === 'locality' ? 'area' : c.precision
  return c.score === null ? `${source} ${precision}` : `${source} ${precision}, ${Math.round(c.score * 100)}% match`
}

function describeSync(sync: SyncStatus | null): string | null {
  if (!sync) return null
  const c = sync.counts
  const run = sync.last_run
  let when = 'No sync has run yet.'
  if (run) {
    const at = dateTime.format(new Date(run.finished_at ?? run.started_at))
    when =
      run.status === 'running'
        ? `A sync has been running since ${at}.`
        : run.status === 'failed'
          ? `The last sync failed (${at}).`
          : `Last synced ${at}.`
  }
  const parts = [`${formatCount((c.SUCCESS ?? 0) + (c.MANUALLY_VERIFIED ?? 0))} on the map`]
  if (c.PENDING) parts.push(`${formatCount(c.PENDING)} waiting to be geocoded`)
  if (c.FAILED) parts.push(`${formatCount(c.FAILED)} marked not locatable`)
  return `${when} ${joinSentence(parts)}.`
}

export default function TriagePage() {
  return (
    <>
      <title>Location review – NZ Charities Map</title>
      <RequireAdmin>{(session) => <Triage email={session.user.email ?? null} />}</RequireAdmin>
    </>
  )
}

function Triage({ email }: { email: string | null }) {
  const [queue, setQueue] = useState<ReviewQueueItem[]>([])
  const [queueTotal, setQueueTotal] = useState(0)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [address, setAddress] = useState('')
  const [pin, setPin] = useState<Pin | null>(null)
  const [geo, setGeo] = useState<GeoState>({ status: 'idle' })
  const [target, setTarget] = useState<CameraTarget | null>(null)
  const [mode, setMode] = useState<'review' | 'unlocatable'>('review')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const { toasts, push, dismiss } = useToasts()
  const [cardRef, cardBox] = useElementBox<HTMLElement>()
  const [mainRef, mainBox] = useElementBox<HTMLElement>()
  const geoAbort = useRef<AbortController | null>(null)
  const targetKey = useRef(0)

  // The queue (first 500, alphabetical) and the sync summary; runs whenever `load` is reset to loading.
  const loading = load.status === 'loading'
  useEffect(() => {
    if (!loading) return
    let active = true
    Promise.all([supabase.rpc('get_review_queue', { p_limit: QUEUE_LIMIT }), supabase.rpc('get_sync_status')])
      .then(([queueRes, syncRes]) => {
        if (!active) return
        if (queueRes.error) {
          setLoad({ status: 'error', message: queueRes.error.message })
          return
        }
        const items = queueRes.data ?? []
        setQueue(items)
        setQueueTotal(items[0]?.queue_total ?? 0)
        setSync(syncRes.error ? null : (syncRes.data as unknown as SyncStatus))
        setLoad({ status: 'ready' })
        setSelectedId((current) => (current && items.some((i) => i.id === current) ? current : (items[0]?.id ?? null)))
      })
      .catch((err: unknown) => {
        if (active) setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      active = false
    }
  }, [loading])

  const retryLoad = () => setLoad({ status: 'loading' })

  const visibleQueue = useMemo(() => {
    const f = fold(filter.trim())
    if (!f) return queue
    return queue.filter((i) =>
      fold([i.name, i.cc_number, i.address_raw ?? '', i.geocode_error ?? ''].join(' ')).includes(f),
    )
  }, [queue, filter])
  const item = queue.find((i) => i.id === selectedId) ?? null

  const aim = useCallback((points: LonLat[], zoom?: number) => {
    targetKey.current += 1
    setTarget({ key: targetKey.current, points, zoom })
  }, [])

  /** Look up an address; if nothing matches, at least show the suburb or town. */
  const runGeocode = useCallback(
    async (query: string, fallbackArea?: string) => {
      geoAbort.current?.abort()
      const controller = new AbortController()
      geoAbort.current = controller
      const q = query.trim()
      try {
        if (q.length >= 3) {
          setGeo({ status: 'loading' })
          const res = await geocodeAddress(q, controller.signal)
          if (controller.signal.aborted) return
          setGeo({ status: 'done', query: q, candidates: res.candidates, notice: res.notice })
          if (res.candidates.length) {
            const points = res.candidates.map((c) => c.lonLat)
            const [[west, south], [east, north]] = boundsOf(points)!
            const spread = east - west > SPREAD_DEG || north - south > SPREAD_DEG
            aim(spread ? points : [points[0]!], 17)
            return
          }
        }
        const area = fallbackArea?.trim() ?? ''
        if (area.length < 3) {
          if (q.length < 3)
            setGeo({
              status: 'error',
              message: 'The register has no street address for this charity. Check its profile, or place the pin by hand.',
            })
          return
        }
        const res = await geocodeAddress(area, controller.signal)
        if (controller.signal.aborted) return
        const first = res.candidates[0]
        if (!first) return
        aim([first.lonLat], 14)
        setGeo({
          status: 'done',
          query: q,
          candidates: [],
          notice:
            q.length >= 3
              ? `No match for the street address, so the map shows ${first.label}.`
              : `The register has no street address, so the map shows ${first.label}.`,
        })
      } catch (err) {
        if (controller.signal.aborted) return
        setGeo({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [aim],
  )

  // Start fresh whenever a different charity is selected.
  const itemId = item?.id ?? null
  useEffect(() => {
    setMode('review')
    setReason('')
    geoAbort.current?.abort()
    setGeo({ status: 'idle' })
    if (!item) {
      setPin(null)
      setAddress('')
      return
    }
    const addr = formatAddress(item) ?? item.address_raw ?? ''
    setAddress(addr)
    if (item.lon !== null && item.lat !== null) {
      // The sync's best guess: a starting point to check, not a verified location.
      const lonLat: LonLat = [item.lon, item.lat]
      setPin({ lonLat, source: 'suggested' })
      aim([lonLat], 17)
    } else {
      setPin(null)
      void runGeocode(item.street ? addr : '', [item.suburb, item.city].filter(Boolean).join(', '))
    }
    // Only a change of charity should reset — not every update to the queue array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  useEffect(() => {
    if (selectedId) document.getElementById(`queue-${selectedId}`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const placePin = useCallback((lonLat: LonLat) => setPin({ lonLat, source: 'placed' }), [])

  function chooseCandidate(c: GeocodeCandidate) {
    setPin({ lonLat: c.lonLat, source: 'candidate' })
    aim([c.lonLat], 18)
  }

  function move(delta: number) {
    if (!visibleQueue.length) return
    const idx = visibleQueue.findIndex((i) => i.id === selectedId)
    const nextIdx = idx < 0 ? 0 : (idx + delta + visibleQueue.length) % visibleQueue.length
    setSelectedId(visibleQueue[nextIdx]?.id ?? null)
  }

  function removeAndAdvance(id: string) {
    const idx = visibleQueue.findIndex((i) => i.id === id)
    const next = visibleQueue[idx + 1] ?? visibleQueue[idx - 1] ?? null
    setQueue((all) => all.filter((i) => i.id !== id))
    setQueueTotal((n) => Math.max(0, n - 1))
    setSelectedId(next && next.id !== id ? next.id : null)
  }

  async function save() {
    if (!item || !pin || busy) return
    setBusy(true)
    const { error } = await supabase.rpc('verify_charity_location', {
      p_id: item.id,
      p_lon: pin.lonLat[0],
      p_lat: pin.lonLat[1],
    })
    setBusy(false)
    if (error) {
      push('error', `Couldn't save ${item.name}. ${error.message}`)
      return
    }
    push('success', `Saved and verified ${item.name}`)
    removeAndAdvance(item.id)
  }

  async function markUnlocatable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!item || busy) return
    setBusy(true)
    const { error } = await supabase.rpc('mark_charity_unlocatable', {
      p_id: item.id,
      p_reason: reason.trim() || undefined,
    })
    setBusy(false)
    if (error) {
      push('error', `Couldn't update ${item.name}. ${error.message}`)
      return
    }
    push('success', `Marked ${item.name} as not locatable`)
    removeAndAdvance(item.id)
  }

  function testGeocode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    void runGeocode(address)
  }

  // Shortcuts: J / K move through the queue, Ctrl or ⌘ + Enter saves.
  const actions = useRef({ save: () => {}, move: (_delta: number) => {} })
  useEffect(() => {
    actions.current = { save: () => void save(), move }
  })
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        actions.current.save()
        return
      }
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return
      if (e.key === 'j') {
        e.preventDefault()
        actions.current.move(1)
      } else if (e.key === 'k') {
        e.preventDefault()
        actions.current.move(-1)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Keep camera moves clear of the review card: beside it on wide screens, below it on narrow ones.
  const mapPadding = useMemo<Insets>(() => {
    const stacked = mainBox.width > 0 && cardBox.width > mainBox.width * 0.6
    return stacked
      ? { top: Math.min(cardBox.height + 36, mainBox.height * 0.6), right: 24, bottom: 36, left: 24 }
      : { top: 48, right: 64, bottom: 48, left: cardBox.width + 48 }
  }, [cardBox.width, cardBox.height, mainBox.width, mainBox.height])

  const syncLine = describeSync(sync)
  const queueCountText =
    visibleQueue.length !== queue.length
      ? `${formatCount(visibleQueue.length)} of ${formatCount(queue.length)} match the filter`
      : queueTotal > queue.length
        ? `Showing the first ${formatCount(queue.length)} of ${formatCount(queueTotal)}`
        : `${formatCount(queue.length)} ${queue.length === 1 ? 'charity' : 'charities'} to place`

  return (
    <div className="flex h-full flex-col">
      <header className="on-ink flex flex-none flex-wrap items-center gap-x-4 gap-y-2 bg-ink px-4 py-3 text-paper">
        <div className="flex items-center gap-2.5">
          <BrandMark size={26} />
          <h1 className="text-lg leading-tight font-bold">Location review</h1>
        </div>
        {load.status === 'ready' && <p className="text-sm text-mist">{formatCount(queueTotal)} to review</p>}
        <nav aria-label="Account" className="ml-auto flex items-center gap-4 text-sm">
          <Link to="/" className="font-semibold underline decoration-ink-line underline-offset-4 hover:decoration-kowhai">
            Public map
          </Link>
          {email && <span className="hidden text-mist sm:inline">{email}</span>}
          <button
            type="button"
            onClick={() => void supabase.auth.signOut()}
            className="rounded-lg border border-ink-line px-3 py-1.5 font-semibold hover:border-mist"
          >
            Sign out
          </button>
        </nav>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Review queue"
          className="flex max-h-[38dvh] min-h-0 flex-none flex-col border-b border-line bg-white md:max-h-none md:w-[22rem] md:border-r md:border-b-0"
        >
          <div className="space-y-3 border-b border-line p-4">
            {syncLine && <p className="text-sm text-muted">{syncLine}</p>}
            <label htmlFor="queue-filter" className="sr-only">
              Filter the queue
            </label>
            <input
              id="queue-filter"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, CC number or address"
              className="h-10 w-full rounded-lg border border-line px-3 text-[0.9375rem] placeholder:text-muted focus:border-ink"
            />
            {load.status === 'ready' && queue.length > 0 && <p className="text-sm text-muted">{queueCountText}</p>}
          </div>
          <ul aria-label="Charities to review" className="min-h-0 flex-1 overflow-y-auto">
            {visibleQueue.map((q) => {
              const current = q.id === selectedId
              return (
                <li key={q.id} id={`queue-${q.id}`}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(q.id)}
                    aria-current={current ? 'true' : undefined}
                    className={`block w-full border-b border-l-4 border-b-line px-4 py-3 text-left focus-visible:-outline-offset-2 ${
                      current ? 'border-l-kowhai bg-paper' : 'border-l-transparent hover:bg-paper'
                    }`}
                  >
                    <span className="block leading-snug font-semibold break-words">{q.name}</span>
                    <span className="block text-sm text-muted">{q.cc_number}</span>
                    <span className="mt-1 block text-sm break-words">{q.address_raw || 'No street address'}</span>
                    {q.geocode_error && <span className="mt-1 block text-sm text-alert">{q.geocode_error}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          {load.status === 'ready' && queue.length > 0 && visibleQueue.length === 0 && (
            <p className="p-4 text-[0.9375rem]">No charities match “{filter.trim()}”.</p>
          )}
        </aside>

        <main ref={mainRef} aria-label="Map" className="relative min-h-[18rem] flex-1">
          <TriageMap
            pin={pin?.lonLat ?? null}
            candidates={geo.status === 'done' ? geo.candidates : NO_CANDIDATES}
            target={target}
            padding={mapPadding}
            onPlacePin={item ? placePin : ignorePin}
          />

          <section
            ref={cardRef}
            aria-labelledby={item ? 'review-title' : undefined}
            className="absolute top-3 left-3 z-10 flex max-h-[calc(100%-1.5rem)] w-[min(26rem,calc(100%-1.5rem))] flex-col rounded-2xl bg-white shadow-float"
          >
            {item ? (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h2 id="review-title" className="text-lg leading-snug font-bold break-words">
                        {item.name}
                      </h2>
                      <p className="text-sm text-muted">
                        {item.sector ? `${item.cc_number}, ${item.sector}` : item.cc_number}
                      </p>
                    </div>
                    <a
                      href={registerUrl(item.cc_number)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex flex-none items-center gap-1 rounded text-sm font-semibold underline underline-offset-4"
                    >
                      Charity summary
                      <ExternalIcon size={14} />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  </div>

                  <dl className="mt-3 space-y-2 text-[0.9375rem]">
                    <div>
                      <dt className="text-sm text-muted">Address on the register</dt>
                      <dd className="break-words">{item.address_raw || 'None given'}</dd>
                    </div>
                    {item.geocode_error && (
                      <div>
                        <dt className="text-sm text-muted">Why it needs review</dt>
                        <dd className="text-alert">{item.geocode_error}</dd>
                      </div>
                    )}
                  </dl>

                  <form onSubmit={testGeocode} className="mt-4">
                    <label htmlFor="geocode-address" className="block text-sm font-semibold">
                      Address to look up
                    </label>
                    <div className="mt-1 flex gap-2">
                      <input
                        id="geocode-address"
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        onKeyDown={(e) => {
                          // Ctrl/⌘ + Enter means "save", not "look up".
                          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') e.preventDefault()
                        }}
                        autoComplete="off"
                        spellCheck={false}
                        className="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 text-[0.9375rem] focus:border-ink"
                      />
                      <button
                        type="submit"
                        disabled={geo.status === 'loading'}
                        className="inline-flex h-10 flex-none items-center gap-2 rounded-lg border border-ink px-3 text-sm font-semibold hover:bg-paper disabled:opacity-60"
                      >
                        {geo.status === 'loading' && <Spinner size={14} />}
                        Test geocode
                      </button>
                    </div>
                  </form>

                  {geo.status === 'done' && geo.candidates.length > 0 && (
                    <ol aria-label="Geocoder results" className="mt-3 space-y-1">
                      {geo.candidates.map((c, i) => {
                        const chosen = pin !== null && pin.source !== 'placed' && sameSpot(pin.lonLat, c.lonLat)
                        return (
                          <li key={`${c.source}-${c.lonLat.join()}`}>
                            <button
                              type="button"
                              aria-pressed={chosen}
                              onClick={() => chooseCandidate(c)}
                              className={`flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-paper ${chosen ? 'bg-paper' : ''}`}
                            >
                              <span
                                className={`grid size-6 flex-none place-items-center rounded-full border-2 border-ink text-xs font-bold ${chosen ? 'bg-kowhai' : 'bg-white'}`}
                              >
                                {i + 1}
                              </span>
                              <span className="min-w-0">
                                <span className="block text-[0.9375rem] leading-snug break-words">{c.label}</span>
                                <span className="block text-sm text-muted">{describeCandidate(c)}</span>
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                  {geo.status === 'done' && geo.candidates.length === 0 && geo.query && (
                    <p className="mt-3 text-[0.9375rem]">
                      No matches for that address. Try dropping the unit or building name, or place the pin by hand.
                    </p>
                  )}
                  {geo.status === 'done' && geo.notice && <p className="mt-2 text-sm text-muted">{geo.notice}</p>}
                  {geo.status === 'error' && (
                    <p role="alert" className="mt-3 text-[0.9375rem] text-alert">
                      {geo.message}
                    </p>
                  )}
                </div>

                <div className="flex-none border-t border-line p-4">
                  {mode === 'unlocatable' ? (
                    <form onSubmit={markUnlocatable} className="space-y-3">
                      <label htmlFor="unlocatable-reason" className="block text-sm font-semibold">
                        Why can't it be located? (optional)
                      </label>
                      <input
                        id="unlocatable-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="For example: PO Box only, no street address"
                        className="h-10 w-full rounded-lg border border-line px-3 text-[0.9375rem] placeholder:text-muted focus:border-ink"
                      />
                      <p className="text-sm text-muted">
                        It leaves the queue and stays off the map until its address changes on the register.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="submit"
                          disabled={busy}
                          className="inline-flex items-center gap-2 rounded-lg bg-alert px-4 py-2 font-semibold text-white hover:bg-[#962019] disabled:opacity-60"
                        >
                          {busy && <Spinner size={14} />}
                          Mark as not locatable
                        </button>
                        <button
                          type="button"
                          onClick={() => setMode('review')}
                          className="rounded-lg px-3 py-2 text-sm font-semibold hover:bg-paper"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="flex items-start gap-2 text-sm" aria-live="polite">
                        <PinIcon size={16} className="mt-0.5 flex-none text-muted" />
                        {pin ? (
                          <p>
                            Pin at{' '}
                            <span className="font-semibold tabular-nums">
                              {pin.lonLat[1].toFixed(5)}, {pin.lonLat[0].toFixed(5)}
                            </span>
                            {pin.source === 'suggested' && (
                              <span className="block text-muted">
                                This is the geocoder's guess. Check it before saving.
                              </span>
                            )}
                          </p>
                        ) : (
                          <p>Click the map where this charity is to place the pin.</p>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void save()}
                          disabled={!pin || busy}
                          className="inline-flex items-center gap-2 rounded-lg bg-fern px-4 py-2 font-semibold text-white hover:bg-fern-dark disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {busy && <Spinner size={14} />}
                          Save &amp; verify
                        </button>
                        <button
                          type="button"
                          onClick={() => move(1)}
                          className="rounded-lg px-3 py-2 text-sm font-semibold hover:bg-paper"
                        >
                          Skip
                        </button>
                        <button
                          type="button"
                          onClick={() => setMode('unlocatable')}
                          className="rounded-lg px-3 py-2 text-sm font-semibold text-alert hover:bg-alert-tint"
                        >
                          Can't locate
                        </button>
                      </div>
                      <p className="mt-3 hidden text-xs text-muted md:block">
                        Shortcuts: J for next, K for previous, Ctrl + Enter to save.
                      </p>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="p-5">
                {load.status === 'loading' && (
                  <p role="status" className="flex items-center gap-2">
                    <Spinner size={18} />
                    Loading the review queue…
                  </p>
                )}
                {load.status === 'error' && (
                  <>
                    <h2 className="text-lg font-bold">Couldn't load the review queue</h2>
                    <p className="mt-1 text-[0.9375rem]">{load.message}</p>
                    <button
                      type="button"
                      onClick={retryLoad}
                      className="mt-3 rounded-lg bg-ink px-4 py-2 font-semibold text-paper hover:bg-ink-soft"
                    >
                      Try again
                    </button>
                  </>
                )}
                {load.status === 'ready' && queue.length === 0 && queueTotal > 0 && (
                  <>
                    <h2 className="text-lg font-bold">This batch is done</h2>
                    <p className="mt-1 text-[0.9375rem]">{formatCount(queueTotal)} more are waiting.</p>
                    <button
                      type="button"
                      onClick={retryLoad}
                      className="mt-3 rounded-lg bg-ink px-4 py-2 font-semibold text-paper hover:bg-ink-soft"
                    >
                      Load the next batch
                    </button>
                  </>
                )}
                {load.status === 'ready' && queue.length === 0 && queueTotal === 0 && (
                  <>
                    <h2 className="text-lg font-bold">Nothing to review</h2>
                    <p className="mt-1 text-[0.9375rem]">
                      Every charity with a street address has a place on the map. The nightly sync adds any it can't
                      place with confidence.
                    </p>
                  </>
                )}
                {load.status === 'ready' && queue.length > 0 && (
                  <p className="text-[0.9375rem]">Choose a charity from the list to place it.</p>
                )}
              </div>
            )}
          </section>
        </main>
      </div>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
