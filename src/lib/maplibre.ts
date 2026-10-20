/**
 * MapLibre v6 ships an ES-module worker that imports a shared chunk. Its default
 * worker URL is computed at runtime, which bundlers can't follow — so hand Vite the
 * worker explicitly. `?worker&url` bundles it (with its imports) as a same-origin file.
 */
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  setWorkerUrl,
  type Map as MapLibreMap,
  type RequestTransformFunction,
  type StyleSpecification,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { whenFirstPainted } from './dom'
import { env } from './env'

setWorkerUrl(workerUrl)

/**
 * Credit for the charity data (CC BY 3.0 NZ) and the LINZ address points most locations
 * come from (CC BY 4.0). Basemap credits come from
 * the style itself — MapLibre shows each source's attribution automatically, which
 * covers OpenFreeMap / OpenMapTiles / OpenStreetMap and the LINZ aerial layer.
 */
export const DATA_ATTRIBUTION =
  'Charity data © <a href="https://www.charities.govt.nz/" target="_blank" rel="noopener">Charities Services</a> ' +
  '(<a href="https://creativecommons.org/licenses/by/3.0/nz/" target="_blank" rel="noopener">CC BY 3.0 NZ</a>). ' +
  'Addresses from <a href="https://data.linz.govt.nz/" target="_blank" rel="noopener">LINZ</a> (CC BY 4.0)'

export const basemapStyle = env.basemapStyle
export const triageStyle = env.triageStyle

/** OpenFreeMap's credit, character for character as its tiles state it (so MapLibre doesn't add it twice). */
const OPENFREEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'

/**
 * Credits for the public map. With the default OpenFreeMap basemap its credit is listed up front,
 * so the full line shows as soon as the map does instead of growing once the tiles' description
 * arrives. Lighthouse treats this line as the page's main content, so that late change was
 * scored as a slow page.
 */
export const MAP_ATTRIBUTION: string | string[] = basemapStyle.startsWith('https://tiles.openfreemap.org/')
  ? [OPENFREEMAP_ATTRIBUTION, DATA_ATTRIBUTION]
  : DATA_ATTRIBUTION

/**
 * For MapLibre's `transformRequest`: holds back the basemap style, and so every tile, sprite and
 * font it leads to, until the page has first painted (see `whenFirstPainted`).
 */
export const styleAfterFirstPaint: RequestTransformFunction = (url, type) =>
  String(type) === 'Style' ? whenFirstPainted().then(() => ({ url })) : undefined

/** Glyph stacks for our own labels — both exist on OpenFreeMap's glyph server. */
export const LABEL_FONT = ['Noto Sans Regular']
export const LABEL_FONT_BOLD = ['Noto Sans Bold']

const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } }],
}

/**
 * The basemap's own shop, bus-stop and park icons look like charity pins, so the public map
 * leaves them out. Roads, place names and colours stay as they are.
 */
export function hideBasemapPlaces(map: MapLibreMap) {
  map.on('style.load', () => {
    for (const layer of map.getStyle().layers) {
      if ('source-layer' in layer && layer['source-layer'] === 'poi') map.removeLayer(layer.id)
    }
  })
}

/** If the basemap style can't be fetched, swap in a plain background so the charity layers still load. */
export function withStyleFallback(map: MapLibreMap) {
  let styleReady = false
  map.once('styledata', () => {
    styleReady = true
  })
  map.on('error', (e) => {
    if (styleReady) {
      console.debug('Map error', e.error)
      return
    }
    console.warn('Basemap style failed to load; using a plain background instead.', e.error)
    styleReady = true
    map.setStyle(FALLBACK_STYLE)
  })
}
