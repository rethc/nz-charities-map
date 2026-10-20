const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, '') ?? ''
const supabaseKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

export const env = {
  supabaseUrl,
  supabaseKey,
  dataSource: import.meta.env.VITE_DATA_SOURCE === 'snapshot' ? 'snapshot' : 'rpc',
  /** OpenFreeMap Liberty: colourful, with house numbers and buildings close up. */
  basemapStyle: import.meta.env.VITE_BASEMAP_STYLE?.trim() || 'https://tiles.openfreemap.org/styles/liberty',
  triageStyle: import.meta.env.VITE_BASEMAP_STYLE?.trim() || 'https://tiles.openfreemap.org/styles/liberty',
  linzBasemapsKey: import.meta.env.VITE_LINZ_BASEMAPS_KEY?.trim() || null,
} as const

/** Names of required variables that are missing — the app shows a setup screen instead of crashing. */
export const missingEnv = [
  !supabaseUrl && 'VITE_SUPABASE_URL',
  !supabaseKey && 'VITE_SUPABASE_PUBLISHABLE_KEY',
].filter((v): v is string => Boolean(v))

export const snapshotUrl = `${supabaseUrl}/storage/v1/object/public/public-data/charities.json`
