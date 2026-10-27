import type { Feature, Point } from 'geojson'
import {
  AttributionControl,
  GeolocateControl,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type MapMouseEvent,
} from 'maplibre-gl'
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import type { CharityFeatureCollection } from '../lib/charities'
import { boundsOf, DEFAULT_VIEW, prefersReducedMotion, type LonLat } from '../lib/geo'
import {
  basemapStyle,
  hideBasemapPlaces,
  LABEL_FONT_BOLD,
  MAP_ATTRIBUTION,
  styleAfterFirstPaint,
  withStyleFallback,
} from '../lib/maplibre'

export type MapPick =
  | { type: 'charity'; cc: string; lonLat: LonLat }
  | { type: 'group'; ccs: string[]; lonLat: LonLat }
  | { type: 'none' }

/** The selected place, marked with a pin: one charity, or several that share an address. */
export interface MapSelection {
  lonLat: LonLat
  /**
   * `CharityPoint.spot` of every address the pin stands for — their dots and badges give way to
   * it. Usually one, but a group picked off the map can span addresses a metre or two apart.
   */
  spots: readonly number[]
  colour: string
  count: number
}

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface CharityMapHandle {
  /**
   * Bring a place to the middle of the map that floating UI leaves free, together with the
   * popup beside it when there is one. Zooms in (never out) to at least `minZoom`.
   */
  focusOn: (lonLat: LonLat, insets: Insets, minZoom?: number) => void
  /** Pan just enough to bring a place out from under floating UI (waits for any flight to land). */
  ensureVisible: (lonLat: LonLat, insets: Insets) => void
  /** Zoom to show every given place. */
  fitPoints: (points: LonLat[], animate?: boolean) => void
}

interface CharityMapProps {
  data: CharityFeatureCollection | null
  selected: MapSelection | null
  /** Desktop only: React content shown in a MapLibre popup beside the selected place. */
  popup: ReactNode
  initialZoom: number
  /** Space taken by floating UI, used when zooming to a cluster or to search results. */
  fitPadding: Insets
  onPick: (pick: MapPick) => void
  ref?: Ref<CharityMapHandle>
}

const SOURCE = 'charities'
const LAYER = {
  clusterHalo: 'charity-cluster-halo',
  clusters: 'charity-clusters',
  clusterCount: 'charity-cluster-count',
  shadows: 'charity-point-shadows',
  points: 'charity-points',
  labels: 'charity-labels',
  stackCount: 'charity-stack-count',
} as const
const CLICKABLE = [LAYER.clusters, LAYER.points]

/** Clusters and shared-address stacks: Fluent's brand blue. */
const INK = '#0f6cbd'
/** Points stay clustered up to this zoom; beyond it every charity is drawn. */
const CLUSTER_MAX_ZOOM = 14
/** Clusters up to this size fetch their members so a click can fit them exactly. */
const LEAF_LIMIT = 500
/**
 * A click on a cluster zooms in at least this many levels. A big cluster splits one level in,
 * so stepping in just that far took nine clicks to get from the whole country to a city centre.
 */
const CLUSTER_STEP = 2
/** Clicking a cluster never zooms in further than this. */
const CLUSTER_ZOOM_CAP = 16
/** Members closer together than this (≈20 m) share an address — list them instead of zooming. */
const COLOCATED_DEG = 0.0002
/** The selected-place pin, in CSS pixels; its tip sits on the place. */
const PIN = { width: 30, height: 40 }
/** Breathing room kept between a focused place (with its pin and popup) and the edge of the free area. */
const FOCUS_MARGIN = 24

const EMPTY: CharityFeatureCollection = { type: 'FeatureCollection', features: [] }

const isCluster: ExpressionSpecification = ['has', 'point_count']
/** Several charities at one address: drawn once, as a numbered badge. */
const isStack: ExpressionSpecification = ['has', 'stack']
const isHovered: ExpressionSpecification = ['boolean', ['feature-state', 'hover'], false]
const clusterRadius: ExpressionSpecification = ['step', ['get', 'point_count'], 14, 25, 17, 100, 21, 1000, 26, 5000, 31]
const stackRadius: ExpressionSpecification = ['step', ['get', 'stack'], 10.5, 10, 12, 100, 14]

/** A zoom-scaled radius for single dots (`extra` widens it for the shadow); badges keep their size. */
const pointRadius = (extra = 0): ExpressionSpecification => {
  const at = (dot: number): ExpressionSpecification => [
    '+',
    ['case', isStack, stackRadius, dot],
    ['case', isHovered, 1.5, 0],
    extra,
  ]
  return ['interpolate', ['linear'], ['zoom'], 5, at(3.5), 10, at(4.5), 16, at(6.5)]
}

type Filter = NonNullable<Parameters<MapLibreMap['setFilter']>[1]>
const NO_SPOTS: readonly number[] = []
const notSelected = (spots: readonly number[]): ExpressionSpecification => [
  '!',
  ['in', ['get', 'spot'], ['literal', [...spots]]],
]
const filters = (spots: readonly number[]): Record<'points' | 'stackCount' | 'labels', Filter> => ({
  points: ['all', ['!', isCluster], ['!', ['has', 'stacked']], notSelected(spots)],
  stackCount: ['all', ['!', isCluster], isStack, notSelected(spots)],
  labels: ['all', ['!', isCluster], ['!', isStack], ['!', ['has', 'stacked']], notSelected(spots)],
})

/**
 * The popup opens to the right of the pin, its arrow level with the pin's head: where the arrow
 * points, measured from the place. Beside the pin, not above it, the popup has the whole height
 * of the window to itself, so the details fit without scrolling.
 */
const POPUP_OFFSET: [number, number] = [PIN.width / 2 + 8, -PIN.height * 0.6]
/** MapLibre's arrow, between that point and the popup's edge. */
const POPUP_TIP = 10

const pointCoords = (f: Feature): LonLat => {
  const [lon, lat] = (f.geometry as Point).coordinates
  return [lon!, lat!]
}

function addCharityLayers(map: MapLibreMap, selectedSpots: readonly number[]) {
  map.addSource(SOURCE, {
    type: 'geojson',
    data: EMPTY,
    cluster: true,
    clusterRadius: 50,
    clusterMaxZoom: CLUSTER_MAX_ZOOM,
  })
  const filter = filters(selectedSpots)

  // Clusters: an ink bubble in a soft ring, which reads as "more inside".
  map.addLayer({
    id: LAYER.clusterHalo,
    type: 'circle',
    source: SOURCE,
    filter: isCluster,
    paint: {
      'circle-color': INK,
      'circle-opacity': ['case', isHovered, 0.28, 0.16],
      'circle-radius': ['+', clusterRadius, ['case', isHovered, 8, 6]],
    },
  })
  map.addLayer({
    id: LAYER.clusters,
    type: 'circle',
    source: SOURCE,
    filter: isCluster,
    paint: {
      'circle-color': INK,
      'circle-radius': clusterRadius,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  })
  map.addLayer({
    id: LAYER.clusterCount,
    type: 'symbol',
    source: SOURCE,
    filter: isCluster,
    layout: {
      'text-field': ['to-string', ['get', 'point_count_abbreviated']],
      'text-font': LABEL_FONT_BOLD,
      'text-size': 12.5,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#ffffff' },
  })

  // Single charities: a sector-coloured dot with a white rim, lifted off the basemap by a soft shadow.
  map.addLayer({
    id: LAYER.shadows,
    type: 'circle',
    source: SOURCE,
    filter: filter.points,
    paint: {
      'circle-color': INK,
      'circle-opacity': 0.35,
      'circle-blur': 0.55,
      'circle-radius': pointRadius(4.5),
      'circle-translate': [0, 1.5],
    },
  })
  map.addLayer({
    id: LAYER.points,
    type: 'circle',
    source: SOURCE,
    filter: filter.points,
    paint: {
      'circle-color': ['case', isStack, INK, ['get', 'colour']],
      'circle-radius': pointRadius(),
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 1.25, 14, 2],
      'circle-stroke-color': '#ffffff',
    },
  })
  map.addLayer({
    id: LAYER.labels,
    type: 'symbol',
    source: SOURCE,
    minzoom: 15,
    filter: filter.labels,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': LABEL_FONT_BOLD,
      'text-size': 13,
      'text-max-width': 9,
      'text-line-height': 1.15,
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
      'text-radial-offset': 1.05,
      'text-justify': 'auto',
    },
    paint: { 'text-color': '#000000', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
  })

  // Topmost, so it is placed first: the count always shows and names keep clear of the badge.
  map.addLayer({
    id: LAYER.stackCount,
    type: 'symbol',
    source: SOURCE,
    filter: filter.stackCount,
    layout: {
      'text-field': ['to-string', ['get', 'stack']],
      'text-font': LABEL_FONT_BOLD,
      'text-size': 11.5,
      'text-allow-overlap': true,
      'text-padding': 7,
    },
    paint: { 'text-color': '#ffffff' },
  })
}

/** A pin in the sector colour, or in ink with a count where several charities share the address. */
function SelectedPin({ colour, count }: { colour: string; count: number }) {
  const shared = count > 1
  return (
    <span className="map-pin">
      <svg width={PIN.width} height={PIN.height} viewBox="0 0 30 40" aria-hidden="true" focusable="false">
        <path
          d="M15 39C15 39 28 24.6 28 14.5a13 13 0 1 0-26 0C2 24.6 15 39 15 39Z"
          fill={shared ? INK : colour}
          stroke="#fff"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {shared ? (
          <text
            x="15"
            y="15"
            fill="#fff"
            fontSize={count > 99 ? 10 : 12}
            fontWeight="700"
            textAnchor="middle"
            dominantBaseline="central"
          >
            {count > 999 ? '999+' : count}
          </text>
        ) : (
          <circle cx="15" cy="14.5" r="4.75" fill="#fff" />
        )}
      </svg>
    </span>
  )
}

export function CharityMap({ data, selected, popup, initialZoom, fitPadding, onPick, ref }: CharityMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const [loaded, setLoaded] = useState(false)
  const selectedSpots = selected?.spots ?? NO_SPOTS

  // Latest props for the long-lived MapLibre event handlers.
  const latest = useRef({ onPick, fitPadding, selectedSpots })
  useEffect(() => {
    latest.current = { onPick, fitPadding, selectedSpots }
  })

  // Create the map once.
  useEffect(() => {
    const map = new MapLibreMap({
      container: containerRef.current!,
      style: basemapStyle,
      transformRequest: styleAfterFirstPaint,
      center: DEFAULT_VIEW.center,
      zoom: initialZoom,
      minZoom: 2.5,
      maxZoom: 18,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
    })
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    map.getCanvas().setAttribute('aria-label', 'Map of registered charities. Search above to find one by name.')

    map.addControl(new AttributionControl({ compact: true, customAttribution: MAP_ATTRIBUTION }), 'bottom-right')
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(
      new GeolocateControl({
        positionOptions: { enableHighAccuracy: false, timeout: 10_000 },
        fitBoundsOptions: { maxZoom: 13 },
      }),
      'bottom-right',
    )
    withStyleFallback(map)
    hideBasemapPlaces(map)
    map.once('load', () => {
      addCharityLayers(map, latest.current.selectedSpots)
      setLoaded(true)
    })

    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      setLoaded(false)
    }
    // initialZoom only matters when the map is created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push the (filtered) data into the clustered source.
  useEffect(() => {
    if (!loaded) return
    void mapRef.current?.getSource<GeoJSONSource>(SOURCE)?.setData(data ?? EMPTY)
  }, [loaded, data])

  // The selected place is shown by the pin, so its own dots, badges and labels step aside.
  useEffect(() => {
    const map = mapRef.current
    if (!loaded || !map) return
    const filter = filters(selectedSpots)
    map.setFilter(LAYER.shadows, filter.points)
    map.setFilter(LAYER.points, filter.points)
    map.setFilter(LAYER.stackCount, filter.stackCount)
    map.setFilter(LAYER.labels, filter.labels)
  }, [loaded, selectedSpots])

  // Clicks and hover feedback.
  useEffect(() => {
    const map = mapRef.current
    if (!loaded || !map) return
    const source = map.getSource<GeoJSONSource>(SOURCE)!
    const duration = () => (prefersReducedMotion() ? 0 : 600)

    async function openCluster(feature: MapGeoJSONFeature) {
      const clusterId = Number(feature.properties.cluster_id)
      const count = Number(feature.properties.point_count)
      const expansionZoom = await source.getClusterExpansionZoom(clusterId)

      if (count <= LEAF_LIMIT) {
        const leaves = await source.getClusterLeaves(clusterId, LEAF_LIMIT, 0)
        const bounds = boundsOf(leaves.map(pointCoords))
        if (bounds) {
          const [[west, south], [east, north]] = bounds
          if (east - west < COLOCATED_DEG && north - south < COLOCATED_DEG) {
            latest.current.onPick({
              type: 'group',
              ccs: leaves.map((l) => String(l.properties?.cc)),
              lonLat: pointCoords(leaves[0]!),
            })
            return
          }
          // Fit the members when that actually splits the cluster; otherwise step in.
          const padding = latest.current.fitPadding
          const camera = map!.cameraForBounds(bounds, { padding, maxZoom: CLUSTER_ZOOM_CAP })
          if (camera?.zoom !== undefined && camera.zoom >= expansionZoom) {
            map!.fitBounds(bounds, { padding, maxZoom: CLUSTER_ZOOM_CAP, duration: duration() })
            return
          }
        }
      }
      const zoom = Math.min(Math.max(expansionZoom, map!.getZoom() + CLUSTER_STEP), CLUSTER_ZOOM_CAP)
      map!.easeTo({ center: pointCoords(feature), zoom, duration: duration() })
    }

    function onClick(e: MapMouseEvent) {
      const { x, y } = e.point
      const r = 6
      const hits = map!.queryRenderedFeatures(
        [
          [x - r, y - r],
          [x + r, y + r],
        ],
        { layers: CLICKABLE },
      )
      const cluster = hits.find((f) => f.layer.id === LAYER.clusters)
      if (cluster) {
        openCluster(cluster).catch((err: unknown) => console.warn('Cluster lookup failed', err))
        return
      }

      // Nearest point first; anything drawn on the same spot (same address) joins it.
      const points = hits
        .filter((f) => f.layer.id === LAYER.points)
        .map((f) => ({ f, p: map!.project(pointCoords(f)) }))
        .sort((a, b) => Math.hypot(a.p.x - x, a.p.y - y) - Math.hypot(b.p.x - x, b.p.y - y))
      const nearest = points[0]
      if (!nearest) {
        latest.current.onPick({ type: 'none' })
        return
      }
      const ccs = [
        ...new Set(
          points
            .filter(({ p }) => Math.hypot(p.x - nearest.p.x, p.y - nearest.p.y) <= 3)
            // a badge stands for everyone at its address
            .flatMap(({ f }) => String(f.properties.ccs ?? f.properties.cc).split(',')),
        ),
      ]
      const lonLat = pointCoords(nearest.f)
      latest.current.onPick(
        ccs.length > 1 ? { type: 'group', ccs, lonLat } : { type: 'charity', cc: ccs[0]!, lonLat },
      )
    }

    // Dots and clusters respond to the pointer (mouse only: a tap would leave the state stuck on).
    const canvas = map.getCanvas()
    let hovered: string | number | undefined
    function setHovered(id: string | number | undefined) {
      if (id === hovered) return
      if (hovered !== undefined) map!.setFeatureState({ source: SOURCE, id: hovered }, { hover: false })
      hovered = id
      if (id !== undefined) map!.setFeatureState({ source: SOURCE, id }, { hover: true })
      canvas.style.cursor = id === undefined ? '' : 'pointer'
    }
    const onMove = (e: MapMouseEvent) => setHovered(map.queryRenderedFeatures(e.point, { layers: CLICKABLE })[0]?.id)
    const onOut = () => setHovered(undefined)

    map.on('click', onClick)
    if (window.matchMedia('(hover: hover)').matches) {
      map.on('mousemove', onMove)
      map.on('mouseout', onOut)
    }
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.off('mouseout', onOut)
    }
  }, [loaded])

  // Desktop popup: a MapLibre Popup whose content is rendered by React through a portal.
  const popupNode = useMemo(() => document.createElement('div'), [])
  const popupRef = useRef<Popup | null>(null)
  const hasPopup = Boolean(popup)

  useImperativeHandle(ref, () => {
    const ensureVisible = (lonLat: LonLat, insets: Insets): void => {
      const map = mapRef.current
      if (!map) return
      // Don't interrupt a flight (e.g. from a search pick) — check again once it lands.
      if (map.isMoving()) {
        map.once('moveend', () => ensureVisible(lonLat, insets))
        return
      }
      const { x, y } = map.project(lonLat)
      const { clientWidth: w, clientHeight: h } = map.getContainer()
      const box = {
        left: insets.left + FOCUS_MARGIN,
        right: w - insets.right - FOCUS_MARGIN,
        top: insets.top + FOCUS_MARGIN + PIN.height,
        bottom: h - insets.bottom - FOCUS_MARGIN,
      }
      if (box.right <= box.left || box.bottom <= box.top) return
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return
      // Centre it in the uncovered part of the map.
      const dx = x - (box.left + box.right) / 2
      const dy = y - (box.top + box.bottom) / 2
      map.panBy([dx, dy], { duration: prefersReducedMotion() ? 0 : 350 })
    }

    return {
      focusOn(lonLat, insets, minZoom = 0) {
        const map = mapRef.current
        if (!map) return
        const { clientWidth: w, clientHeight: h } = map.getContainer()
        const left = insets.left + FOCUS_MARGIN
        const right = w - insets.right - FOCUS_MARGIN
        const top = insets.top + FOCUS_MARGIN
        const bottom = h - insets.bottom - FOCUS_MARGIN
        // Aim for the middle (of the pin, so it looks centred), keeping the whole pin in view.
        let x = (left + right) / 2
        let y = Math.min(Math.max((top + bottom + PIN.height) / 2, top + PIN.height), bottom)
        const content = popupRef.current ? popupNode.parentElement : null
        if (content) {
          // On desktop the popup stands to the right of the pin: centre the two as a pair, hugging
          // the left when they don't both fit. The popup grows above and below the pin's head as
          // the details load, so the head goes at mid-height and the place never has to move.
          const reach = POPUP_OFFSET[0] + POPUP_TIP + content.offsetWidth
          x = Math.max(left + PIN.width / 2, (left + right - reach + PIN.width / 2) / 2)
          y = (insets.top + h - insets.bottom) / 2 - POPUP_OFFSET[1]
        }

        const zoom = Math.max(map.getZoom(), minZoom)
        const zooming = zoom > map.getZoom()
        const from = map.project(lonLat)
        const distance = Math.hypot(from.x - x, from.y - y)
        if (!zooming && distance < 2) return
        const target = { center: lonLat, zoom, offset: [x - w / 2, y - h / 2] as [number, number] }
        if (prefersReducedMotion()) map.easeTo({ ...target, duration: 0 })
        // A long trip, or one that zooms: fly, so the journey shows where things are.
        else if (zooming || distance > Math.hypot(w, h)) map.flyTo({ ...target, speed: 1.6, essential: true })
        else map.easeTo({ ...target, duration: 450 })
      },
      ensureVisible,
      fitPoints(points, animate = true) {
        const map = mapRef.current
        const bounds = boundsOf(points)
        if (!map || !bounds) return
        map.fitBounds(bounds, {
          padding: latest.current.fitPadding,
          maxZoom: 15,
          duration: animate && !prefersReducedMotion() ? 800 : 0,
        })
      },
    }
  }, [popupNode])

  // The pin: a MapLibre Marker whose element React fills through a portal.
  const pinNode = useMemo(() => {
    const el = document.createElement('div')
    el.className = 'map-pin-anchor'
    return el
  }, [])
  const pinRef = useRef<Marker | null>(null)
  const [selLon, selLat] = selected?.lonLat ?? []

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (selLon === undefined || selLat === undefined) {
      pinRef.current?.remove()
      pinRef.current = null
      return
    }
    if (pinRef.current) {
      pinRef.current.setLngLat([selLon, selLat])
      return
    }
    pinRef.current = new Marker({ element: pinNode, anchor: 'bottom', subpixelPositioning: true })
      .setLngLat([selLon, selLat])
      .addTo(map)
  }, [selLon, selLat, pinNode])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!hasPopup || selLon === undefined || selLat === undefined) {
      popupRef.current?.remove()
      popupRef.current = null
      return
    }
    if (popupRef.current) {
      popupRef.current.setLngLat([selLon, selLat])
      return
    }
    popupRef.current = new Popup({
      closeButton: false,
      closeOnClick: false, // map clicks are handled above (a click elsewhere selects or clears)
      focusAfterOpen: false,
      anchor: 'left',
      offset: POPUP_OFFSET,
      maxWidth: 'none', // sized in index.css
      className: 'charity-popup',
    })
      .setDOMContent(popupNode)
      .setLngLat([selLon, selLat])
      .addTo(map)
  }, [hasPopup, selLon, selLat, popupNode])

  useEffect(
    () => () => {
      pinRef.current?.remove()
      pinRef.current = null
      popupRef.current?.remove()
      popupRef.current = null
    },
    [],
  )

  return (
    <>
      {/* maplibre-gl.css sets .maplibregl-map { position: relative } unlayered, which beats Tailwind's
          layered `absolute` — so a wrapper does the positioning and the map fills it. */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {selected &&
        createPortal(
          // keyed by place, so the pin drops in afresh each time the selection moves
          <SelectedPin key={selected.lonLat.join()} colour={selected.colour} count={selected.count} />,
          pinNode,
        )}
      {popup && createPortal(popup, popupNode)}
    </>
  )
}
