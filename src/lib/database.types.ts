/**
 * Database types for the NZ Charities Map.
 *
 * The `Database` shape mirrors `supabase gen types typescript` output so it can be
 * swapped for generated types at any time:
 *   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
 * (then keep the app-level types at the bottom in a separate file).
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type GeocodeStatus = 'SUCCESS' | 'NEEDS_REVIEW' | 'MANUALLY_VERIFIED' | 'FAILED'

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '13.0.5'
  }
  public: {
    Tables: {
      charities: {
        Row: {
          id: string
          cc_number: string
          name: string
          sector: string | null
          address_raw: string | null
          street: string | null
          suburb: string | null
          city: string | null
          postcode: string | null
          /** PostGIS geometry(Point, 4326). PostgREST returns hex EWKB — use the RPCs for lon/lat. */
          coordinates: unknown
          /** null = queued for geocoding by the next sync run */
          geocode_status: GeocodeStatus | null
          geocode_error: string | null
          last_synced_at: string
          /** What it does and how to reach it: filled in by the sync, null where the register has nothing. */
          purpose: string | null
          activity: string | null
          beneficiary: string | null
          phone: string | null
          email: string | null
          /** Always an http(s) address (checked by the database). */
          website: string | null
          /** https links to its social pages, one per platform (checked by the database). Added by charity_socials. */
          socials: string[] | null
          /** A registered group: a parent charity and its members under one registration. */
          is_group: boolean
          /** For a member charity, the cc_number of its registered group. */
          group_cc: string | null
        }
        Insert: {
          id?: string
          cc_number: string
          name: string
          sector?: string | null
          address_raw?: string | null
          street?: string | null
          suburb?: string | null
          city?: string | null
          postcode?: string | null
          coordinates?: unknown
          geocode_status?: GeocodeStatus | null
          geocode_error?: string | null
          last_synced_at?: string
          purpose?: string | null
          activity?: string | null
          beneficiary?: string | null
          phone?: string | null
          email?: string | null
          website?: string | null
          socials?: string[] | null
          is_group?: boolean
          group_cc?: string | null
        }
        Update: {
          id?: string
          cc_number?: string
          name?: string
          sector?: string | null
          address_raw?: string | null
          street?: string | null
          suburb?: string | null
          city?: string | null
          postcode?: string | null
          coordinates?: unknown
          geocode_status?: GeocodeStatus | null
          geocode_error?: string | null
          last_synced_at?: string
          purpose?: string | null
          activity?: string | null
          beneficiary?: string | null
          phone?: string | null
          email?: string | null
          website?: string | null
          socials?: string[] | null
          is_group?: boolean
          group_cc?: string | null
        }
        Relationships: []
      }
      sync_runs: {
        Row: SyncRun
        Insert: Partial<SyncRun> & { mode: 'incremental' | 'full' }
        Update: Partial<SyncRun>
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: {
      get_charities_in_view: {
        Args: {
          min_lon: number
          min_lat: number
          max_lon: number
          max_lat: number
          format?: 'compact' | 'geojson'
        }
        Returns: Json
      }
      charity_group_names: {
        Args: never
        Returns: Json
      }
      get_review_queue: {
        Args: { p_limit?: number }
        Returns: ReviewQueueItem[]
      }
      verify_charity_location: {
        Args: { p_id: string; p_lon: number; p_lat: number }
        Returns: undefined
      }
      mark_charity_unlocatable: {
        Args: { p_id: string; p_reason?: string }
        Returns: undefined
      }
      get_sync_status: {
        Args: never
        Returns: Json
      }
      is_admin: {
        Args: never
        Returns: boolean
      }
      apply_geocode_results: {
        Args: { p_results: Json }
        Returns: number
      }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

// ---------------------------------------------------------------------------
// App-level types (type aliases, not interfaces: supabase-js requires rows to be
// assignable to Record<string, unknown>, which interfaces are not)
// ---------------------------------------------------------------------------

export type CharityRow = Database['public']['Tables']['charities']['Row']

/**
 * Public detail view: the columns the popup/drawer reads for one charity. What it does and
 * how to reach it are missing from a database without the charity_details_and_groups migration.
 */
export type CharityDetail = Pick<
  CharityRow,
  'cc_number' | 'name' | 'sector' | 'street' | 'suburb' | 'city' | 'postcode'
> &
  Partial<Pick<CharityRow, 'purpose' | 'activity' | 'beneficiary' | 'phone' | 'email' | 'website' | 'socials'>>

/** One row of `get_charities_in_view(..., format => 'compact')`. `group_cc` arrived with v2. */
export type CharityTuple = [
  cc_number: string,
  name: string,
  sector: string | null,
  lon: number,
  lat: number,
  place: string | null,
  group_cc?: string | null,
]

export type CharitiesInViewCompact = {
  v: 1 | 2
  generated_at: string
  count: number
  /** v2: every registered group's name by cc_number, whether or not it has a pin. */
  groups?: Record<string, string>
  rows: CharityTuple[]
}

export type CharityFeatureProperties = {
  cc_number: string
  name: string
  sector: string | null
  place: string | null
  group_cc?: string | null
}

/** `get_charities_in_view(..., format => 'geojson')` */
export type CharitiesInViewGeoJSON = GeoJSON.FeatureCollection<GeoJSON.Point, CharityFeatureProperties>

export type ReviewQueueItem = {
  id: string
  cc_number: string
  name: string
  sector: string | null
  address_raw: string | null
  street: string | null
  suburb: string | null
  city: string | null
  postcode: string | null
  geocode_error: string | null
  /** Best-guess location from the geocoder (if any) — a starting point, not a verified pin. */
  lon: number | null
  lat: number | null
  last_synced_at: string
  queue_total: number
}

export type SyncRun = {
  id: number
  started_at: string
  finished_at: string | null
  mode: 'incremental' | 'full'
  status: 'running' | 'succeeded' | 'failed'
  source_watermark: string | null
  fetched: number
  upserted: number
  deleted: number
  geocoded: number
  succeeded: number
  needs_review: number
  error: string | null
}

export type SyncStatus = {
  counts: Partial<Record<GeocodeStatus | 'PENDING', number>>
  last_run: SyncRun | null
}
