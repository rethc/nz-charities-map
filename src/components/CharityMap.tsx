import type { Feature, Point } from 'geojson'
import {
  AttributionControl,
  GeolocateControl,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type MapMouseEvent,
} from 'maplibre-gl'
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import type { CharityFeatureCollection } from '../lib/charities'
import { boundsOf, DEFAULT_VIEW, prefersReducedMotion, type LonLat } from '../lib/geo'
import { basemapStyle, DATA_ATTRIBUTION, LABEL_FONT, LABEL_FONT_BOLD, withStyleFallback } from '../lib/maplibre'

export type MapPick =
  | { type: 'charity'; cc: string; lonLat: LonLat }
  | { type: 'group'; ccs: string[]; lonLat: LonLat }
  | { type: 'none' }

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface CharityMapHandle {
  /** Fly to a place, zooming in (never out) to at least `zoom`. */
  flyTo: (lonLat: LonLat, zoom?: number) => void
  /** Pan just enough to bring a place out from under floating UI (waits for any flight to land). */
  ensureVisible: (lonLat: LonLat, insets: Insets) => void
  /** Zoom to show every given place. */
  fitPoints: (points: LonLat[]) => void
}

interface CharityMapProps {
  data: CharityFeatureCollection | null
  selectedCc: string | null
  /** Desktop only: React content shown in a MapLibre popup anchored at `lonLat`. */
  popup: { lonLat: LonLat; content: ReactNode } | null
  initialZoom: number
  /** Space taken by floating UI, used when zooming to a cluster or to search results. */
  fitPadding: Insets
  onPick: (pick: MapPick) => void
  ref?: Ref<CharityMapHandle>
}

const SOURCE = 'charities'
const LAYER = {
  clusters: 'charity-clusters',
  clusterCount: 'charity-cluster-count',
  halo: 'charity-selected',
  points: 'charity-points',
  labels: 'charity-labels',
} as const

const INK = '#12333a'
const KOWHAI = '#f2b705'
/** Points stay clustered up to this zoom; beyond it every charity is drawn. */
const CLUSTER_MAX_ZOOM = 14
/** Clusters up to this size fetch their members so a click can fit them exactly. */
const LEAF_LIMIT = 500
/** Members closer together than this (≈20 m) share an address — list them instead of zooming. */
const COLOCATED_DEG = 0.0002

const EMPTY: CharityFeatureCollection = { type: 'FeatureCollection', features: [] }

type Filter = NonNullable<Parameters<MapLibreMap['setFilter']>[1]>
const selectedFilter = (cc: string | null): Filter => [
  'all',
  ['!', ['has', 'point_count']],
  ['==', ['get', 'cc'], cc ?? ''],
]

const pointCoords = (f: Feature): LonLat => {
  const [lon, lat] = (f.geometry as Point).coordinates
  return [lon!, lat!]
}

function addCharityLayers(map: MapLibreMap, selectedCc: string | null) {
  map.addSource(SOURCE, {
    type: 'geojson',
    data: EMPTY,
    cluster: true,
    clusterRadius: 50,
    clusterMaxZoom: CLUSTER_MAX_ZOOM,
  })

  map.addLayer({
    id: LAYER.clusters,
    type: 'circle',
    source: SOURCE,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': INK,
      'circle-radius': ['step', ['get', 'point_count'], 14, 25, 17, 100, 21, 1000, 26, 5000, 31],
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-opacity': 0.9,
    },
  })

  map.addLayer({
    id: LAYER.clusterCount,
    type: 'symbol',
    source: SOURCE,
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['to-string', ['get', 'point_count_abbreviated']],
      'text-font': LABEL_FONT_BOLD,
      'text-size': 12.5,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#ffffff' },
  })

  // The selected charity sits in a kōwhai ring — the same mark as the logo.
  map.addLayer({
    id: LAYER.halo,
    type: 'circle',
    source: SOURCE,
    filter: selectedFilter(selectedCc),
    paint: {
      'circle-color': KOWHAI,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 10, 16, 15],
      'circle-stroke-width': 2,
      'circle-stroke-color': INK,
    },
  })

  map.addLayer({
    id: LAYER.points,
    type: 'circle',
    source: SOURCE,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': ['get', 'colour'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 10, 5.5, 16, 8],
      // A dark rim keeps the lighter sector colours visible on the pale basemap.
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 14, 1.5],
      'circle-stroke-color': INK,
      'circle-stroke-opacity': 0.8,
    },
  })

  map.addLayer({
    id: LAYER.labels,
    type: 'symbol',
    source: SOURCE,
    minzoom: 15,
    filter: ['!', ['has', 'point_count']],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': LABEL_FONT,
      'text-size': 12,
      'text-max-width': 9,
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
      'text-radial-offset': 0.9,
      'text-justify': 'auto',
    },
    paint: { 'text-color': INK, 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  })
}

export function CharityMap({ data, selectedCc, popup, initialZoom, fitPadding, onPick, ref }: CharityMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Latest props for the long-lived MapLibre event handlers.
  const latest = useRef({ onPick, fitPadding, selectedCc })
  useEffect(() => {
    latest.current = { onPick, fitPadding, selectedCc }
  })

  // Create the map once.
  useEffect(() => {
    const map = new MapLibreMap({
      container: containerRef.current!,
      style: basemapStyle,
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

    map.addControl(new AttributionControl({ compact: true, customAttribution: DATA_ATTRIBUTION }), 'bottom-right')
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(
      new GeolocateControl({
        positionOptions: { enableHighAccuracy: false, timeout: 10_000 },
        fitBoundsOptions: { maxZoom: 13 },
      }),
      'bottom-right',
    )
    withStyleFallback(map)
    map.once('load', () => {
      addCharityLayers(map, latest.current.selectedCc)
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

  useEffect(() => {
    if (loaded) mapRef.current?.setFilter(LAYER.halo, selectedFilter(selectedCc))
  }, [loaded, selectedCc])

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
          const camera = map!.cameraForBounds(bounds, { padding, maxZoom: 16 })
          if (camera?.zoom !== undefined && camera.zoom >= expansionZoom) {
            map!.fitBounds(bounds, { padding, maxZoom: 16, duration: duration() })
            return
          }
        }
      }
      map!.easeTo({ center: pointCoords(feature), zoom: expansionZoom, duration: duration() })
    }

    function onClick(e: MapMouseEvent) {
      const { x, y } = e.point
      const r = 6
      const hits = map!.queryRenderedFeatures(
        [
          [x - r, y - r],
          [x + r, y + r],
        ],
        { layers: [LAYER.clusters, LAYER.points] },
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
            .map(({ f }) => String(f.properties.cc)),
        ),
      ]
      const lonLat = pointCoords(nearest.f)
      latest.current.onPick(
        ccs.length > 1 ? { type: 'group', ccs, lonLat } : { type: 'charity', cc: ccs[0]!, lonLat },
      )
    }

    const canvas = map.getCanvas()
    const pointer = () => {
      canvas.style.cursor = 'pointer'
    }
    const reset = () => {
      canvas.style.cursor = ''
    }

    map.on('click', onClick)
    const subscriptions = [LAYER.clusters, LAYER.points].flatMap((layer) => [
      map.on('mouseenter', layer, pointer),
      map.on('mouseleave', layer, reset),
    ])
    return () => {
      map.off('click', onClick)
      for (const s of subscriptions) s.unsubscribe()
    }
  }, [loaded])

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
      const margin = 24
      const box = {
        left: insets.left + margin,
        right: w - insets.right - margin,
        top: insets.top + margin,
        bottom: h - insets.bottom - margin,
      }
      if (box.right <= box.left || box.bottom <= box.top) return
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return
      // Centre it in the uncovered part of the map.
      const dx = x - (box.left + box.right) / 2
      const dy = y - (box.top + box.bottom) / 2
      map.panBy([dx, dy], { duration: prefersReducedMotion() ? 0 : 350 })
    }

    return {
      flyTo(lonLat, zoom = 15) {
        const map = mapRef.current
        if (!map) return
        const target = { center: lonLat, zoom: Math.max(map.getZoom(), zoom) }
        if (prefersReducedMotion()) map.jumpTo(target)
        else map.flyTo({ ...target, speed: 1.6, essential: true })
      },
      ensureVisible,
      fitPoints(points) {
        const map = mapRef.current
        const bounds = boundsOf(points)
        if (!map || !bounds) return
        map.fitBounds(bounds, {
          padding: latest.current.fitPadding,
          maxZoom: 15,
          duration: prefersReducedMotion() ? 0 : 800,
        })
      },
    }
  }, [])

  // Desktop popup: a MapLibre Popup whose content is rendered by React through a portal.
  const popupNode = useMemo(() => document.createElement('div'), [])
  const popupRef = useRef<Popup | null>(null)
  const popupLon = popup?.lonLat[0]
  const popupLat = popup?.lonLat[1]

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (popupLon === undefined || popupLat === undefined) {
      popupRef.current?.remove()
      popupRef.current = null
      return
    }
    if (popupRef.current) {
      popupRef.current.setLngLat([popupLon, popupLat])
      return
    }
    popupRef.current = new Popup({
      closeButton: false,
      closeOnClick: false, // map clicks are handled above (a click elsewhere selects or clears)
      focusAfterOpen: false,
      maxWidth: '24rem',
      offset: 16,
      className: 'charity-popup',
      padding: { top: 12, right: 12, bottom: 12, left: 12 },
    })
      .setDOMContent(popupNode)
      .setLngLat([popupLon, popupLat])
      .addTo(map)
  }, [popupLon, popupLat, popupNode])

  useEffect(
    () => () => {
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
      {popup && createPortal(popup.content, popupNode)}
    </>
  )
}
