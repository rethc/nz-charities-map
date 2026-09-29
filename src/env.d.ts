/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  /** Legacy name for the publishable key — still accepted. */
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_DATA_SOURCE?: 'rpc' | 'snapshot'
  readonly VITE_BASEMAP_STYLE?: string
  readonly VITE_LINZ_BASEMAPS_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
