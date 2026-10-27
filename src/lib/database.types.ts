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
      /** Admins only. Returns ReturnChecks. Added by the return_checks migration. */
      get_return_checks: {
        Args: never
        Returns: Json
      }
      /** Service role only (scripts/return_checks.py). */
      replace_return_checks: {
        Args: { p_findings: Json }
        Returns: number
      }
      /** Admins only. Returns StatementReviews. Added by the statement_reviews migration. */
      get_statement_reviews: {
        Args: never
        Returns: Json
      }
      /** Admins only: adds StatementReviewUpload rows, replacing the same charity and year. */
      upsert_statement_reviews: {
        Args: { p_reviews: Json }
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

/** One finding of the annual return checks (scripts/return_checks.py), as get_return_checks() returns it. */
export type ReturnCheckFinding = {
  check:
    | 'year_end_mismatch'
    | 'tier_over_limit'
    | 'overdue'
    | 'missing_year'
    | 'prior_year_mismatch'
    | 'negative_net_assets'
    | 'deficits'
    | 'big_swing'
    | 'staff_pay_no_staff'
    | 'repeated_figures'
  cc: string
  name: string
  return_id: number | null
  year_ended: string | null
  /** One plain sentence. */
  summary: string
  /** Per check (days_overdue and due for `overdue`; tier, limits and spent for `tier_over_limit`), plus
   *  `value`, a number to sort by, and `shown`, that figure as the page shows it. */
  details: Record<string, unknown>
}

export type ReturnChecks = {
  /** When the checks last ran; null before the first run. */
  checked_at: string | null
  findings: ReturnCheckFinding[]
}

/** fail: worth a look; warn: a small thing; na: not checked. */
export type StatementCheckStatus = 'pass' | 'fail' | 'warn' | 'na'

/** One charity's financial statements, read and checked against the return they were filed with. */
export type StatementReview = {
  cc: string
  year_ended: string
  name: string
  tier: number | null
  verdict: 'look' | 'minor' | 'fine' | 'unread'
  review: {
    /** The main finding, in a short line. */
    top: string
    /** Two or three sentences. */
    assessment: string
    confidence: string
    confidence_why: string
    checks: { label: string; detail: string; status: StatementCheckStatus }[]
    figures: { what: string; declared: string; statement: string; page: string; ok: boolean }[]
    evidence: { quote: string; page: string; where: string }[]
    first_page: string
  }
  reviewed_at?: string
}

export type StatementReviews = {
  /** When the latest review was uploaded; null before the first. */
  reviewed_at: string | null
  reviews: StatementReview[]
}

/** The results file an admin uploads on the Statements tab. */
export type StatementReviewUpload = {
  kind: 'nz-charities-map/statement-reviews'
  version: 1
  reviews: StatementReview[]
}

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
