import type { Feature, FeatureCollection, Point } from 'geojson'
import {
  AttributionControl,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type IControl,
} from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Insets } from '../../components/CharityMap'
import { LayersIcon } from '../../components/Icons'
import type { CharitiesInViewCompact } from '../../lib/database.types'
import { env } from '../../lib/env'
import { boundsOf, boundsToRpcArgs, DEFAULT_VIEW, prefersReducedMotion, type LonLat } from '../../lib/geo'
import type { GeocodeCandidate } from '../../lib/geocode'
import { DATA_ATTRIBUTION, LABEL_FONT, LABEL_FONT_BOLD, triageStyle, withStyleFallback } from '../../lib/maplibre'
import { supabase } from '../../lib/supabase'

/** A camera move requested by the page; a new `key` means "move again", even to the same place. */
export interface CameraTarget {
  key: number
  points: LonLat[]
  zoom?: number
}

interface TriageMapProps {
  pin: LonLat | null
  candidates: GeocodeCandidate[]
  target: CameraTarget | null
  /** Space covered by the review card, so camera moves land in the visible part of the map. */
  padding: Insets
  onPlacePin: (lonLat: LonLat) => void
}

const INK = '#12333a'
const KOWHAI = '#f2b705'
const GREY = '#7A8589'
const AERIAL = 'linz-aerial'
/** Nearby charities already on the map are loaded from this zoom in (to spot neighbours and duplicates). */
const CONTEXT_MIN_ZOOM = 12
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

const coords = (f: Feature): LonLat => {
  const [lon, lat] = (f.geometry as Point).coordinates
  return [lon!, lat!]
}

export function TriageMap({ pin, candidates, target, padding, onPlacePin }: TriageMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [aerial, setAerial] = useState(false)
  const latest = useRef({ onPlacePin, padding })
  useEffect(() => {
    latest.current = { onPlacePin, padding }
  })

  // The aerial switch is a MapLibre control whose button React renders through a portal.
  const aerialControl = useMemo(() => {
    const el = document.createElement('div')
    el.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    return el
  }, [])

  useEffect(() => {
    const map = new MapLibreMap({
      container: containerRef.current!,
      style: triageStyle,
      center: DEFAULT_VIEW.center,
      zoom: 5,
      maxZoom: 20,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
    })
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    map.getCanvas().setAttribute('aria-label', 'Map. Click to place the pin for the selected charity.')
    map.addControl(new AttributionControl({ compact: true, customAttribution: DATA_ATTRIBUTION }), 'bottom-right')
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    if (env.linzBasemapsKey) {
      const control: IControl = { onAdd: () => aerialControl, onRemove: () => aerialControl.remove() }
      map.addControl(control, 'top-right')
    }
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')
    withStyleFallback(map)

    map.once('load', () => {
      if (env.linzBasemapsKey) {
        map.addSource(AERIAL, {
          type: 'raster',
          tiles: [
            `https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/{z}/{x}/{y}.webp?api=${encodeURIComponent(env.linzBasemapsKey)}`,
          ],
          tileSize: 256,
          maxzoom: 20,
          attribution:
            'Imagery © <a href="https://www.linz.govt.nz/" target="_blank" rel="noopener">Toitū Te Whenua LINZ</a> (CC BY 4.0)',
        })
        // Photos go under the basemap's labels so street names stay readable.
        const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
        map.addLayer({ id: AERIAL, type: 'raster', source: AERIAL, layout: { visibility: 'none' } }, firstLabel)
      }

      map.addSource('context', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'context-points',
        type: 'circle',
        source: 'context',
        paint: {
          'circle-color': GREY,
          'circle-radius': 5,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      })
      map.addLayer({
        id: 'context-labels',
        type: 'symbol',
        source: 'context',
        minzoom: 15,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': LABEL_FONT,
          'text-size': 11.5,
          'text-max-width': 9,
          'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
          'text-radial-offset': 0.8,
        },
        paint: { 'text-color': '#3f4b4e', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      })

      map.addSource('candidates', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'candidate-points',
        type: 'circle',
        source: 'candidates',
        paint: { 'circle-color': '#ffffff', 'circle-radius': 11, 'circle-stroke-width': 2, 'circle-stroke-color': INK },
      })
      map.addLayer({
        id: 'candidate-labels',
        type: 'symbol',
        source: 'candidates',
        layout: {
          'text-field': ['get', 'n'],
          'text-font': LABEL_FONT_BOLD,
          'text-size': 12,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': INK },
      })
      setLoaded(true)
    })

    // A click places the pin; clicking a numbered candidate snaps to it exactly.
    map.on('click', (e) => {
      const hit = map.getLayer('candidate-points')
        ? map.queryRenderedFeatures(e.point, { layers: ['candidate-points'] })[0]
        : undefined
      const ll = e.lngLat.wrap()
      latest.current.onPlacePin(hit ? coords(hit) : [ll.lng, ll.lat])
    })

    mapRef.current = map
    return () => {
      markerRef.current?.remove()
      markerRef.current = null
      map.remove()
      mapRef.current = null
      setLoaded(false)
    }
  }, [aerialControl])

  // The pin: MapLibre's default marker, draggable with the mouse or (when focused) the arrow keys.
  const [pinLon, pinLat] = pin ?? []
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (pinLon === undefined || pinLat === undefined) {
      markerRef.current?.remove()
      markerRef.current = null
      return
    }
    if (markerRef.current) {
      markerRef.current.setLngLat([pinLon, pinLat])
      return
    }
    const marker = new Marker({ color: KOWHAI, draggable: true }).setLngLat([pinLon, pinLat]).addTo(map)
    marker.getElement().setAttribute('aria-label', 'Charity location pin. Drag it, or focus it and use the arrow keys.')
    marker.on('dragend', () => {
      const ll = marker.getLngLat().wrap()
      latest.current.onPlacePin([ll.lng, ll.lat])
    })
    markerRef.current = marker
  }, [pinLon, pinLat])

  useEffect(() => {
    if (!loaded) return
    const data: FeatureCollection = {
      type: 'FeatureCollection',
      features: candidates.map((c, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: c.lonLat },
        properties: { n: String(i + 1) },
      })),
    }
    void mapRef.current?.getSource<GeoJSONSource>('candidates')?.setData(data)
  }, [loaded, candidates])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !target) return
    const { padding: pad } = latest.current
    const duration = prefersReducedMotion() ? 0 : 900
    const [only] = target.points
    if (target.points.length === 1 && only) {
      map.flyTo({ center: only, zoom: target.zoom ?? 17, padding: pad, duration, essential: true })
      return
    }
    const bounds = boundsOf(target.points)
    if (bounds) map.fitBounds(bounds, { padding: pad, maxZoom: target.zoom ?? 17, duration })
  }, [target])

  useEffect(() => {
    const map = mapRef.current
    if (loaded && map?.getLayer(AERIAL)) map.setLayoutProperty(AERIAL, 'visibility', aerial ? 'visible' : 'none')
  }, [loaded, aerial])

  // Charities already on the map near here, refreshed as the view moves.
  useEffect(() => {
    const map = mapRef.current
    if (!loaded || !map) return
    let timer = 0
    let controller: AbortController | null = null

    const refresh = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(async () => {
        const source = map.getSource<GeoJSONSource>('context')
        if (!source) return
        controller?.abort()
        if (map.getZoom() < CONTEXT_MIN_ZOOM) {
          void source.setData(EMPTY)
          return
        }
        controller = new AbortController()
        const { data, error } = await supabase
          .rpc('get_charities_in_view', boundsToRpcArgs(map.getBounds()), { get: true })
          .abortSignal(controller.signal)
        if (error) return
        const rows = (data as unknown as CharitiesInViewCompact | null)?.rows ?? []
        void source.setData({
          type: 'FeatureCollection',
          features: rows.map(([cc, name, , lon, lat]) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { cc, name },
          })),
        })
      }, 300)
    }

    map.on('moveend', refresh)
    refresh()
    return () => {
      map.off('moveend', refresh)
      window.clearTimeout(timer)
      controller?.abort()
    }
  }, [loaded])

  return (
    <>
      {/* maplibre-gl.css sets .maplibregl-map { position: relative } unlayered, which beats Tailwind's
          layered `absolute` — so a wrapper does the positioning and the map fills it. */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {env.linzBasemapsKey &&
        createPortal(
          <button
            type="button"
            aria-pressed={aerial}
            aria-label="Aerial photos"
            title={aerial ? 'Show the street map' : 'Show aerial photos'}
            onClick={() => setAerial((v) => !v)}
            className="grid place-items-center"
          >
            <LayersIcon size={18} />
          </button>,
          aerialControl,
        )}
    </>
  )
}
