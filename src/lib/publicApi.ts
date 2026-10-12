/**
 * Read-only PostgREST calls for the public map. Visitors never sign in, so the public
 * page doesn't need supabase-js (auth, realtime, storage): two plain GET requests keep
 * all of that out of the main bundle. The admin pages load supabase-js on demand.
 */
import type { CharityDetail } from './database.types'
import { env } from './env'

function headers(): Record<string, string> {
  const h: Record<string, string> = { apikey: env.supabaseKey, Accept: 'application/json' }
  // Legacy anon keys are JWTs and also go in Authorization; new sb_publishable_ keys must not.
  if (env.supabaseKey.startsWith('eyJ')) h.Authorization = `Bearer ${env.supabaseKey}`
  return h
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/${path}`, { headers: headers(), signal })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = (body as { message?: unknown } | null)?.message
    throw new Error(typeof message === 'string' ? message : `Supabase request failed (HTTP ${res.status})`)
  }
  return body as T
}

/** Calls a Postgres function with GET, so browsers and CDNs can reuse the response. */
export function rpcGet<T>(fn: string, args: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
  const params = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)]))
  return getJson<T>(`rpc/${fn}?${params}`, signal)
}

const BASIC_COLUMNS = 'cc_number,name,sector,street,suburb,city,postcode'
const DETAIL_COLUMNS = `${BASIC_COLUMNS},purpose,activity,beneficiary,phone,email,website`
/** Turned off for the visit if the database turns out not to have the detail columns yet. */
let withDetails = true

export async function selectCharity(cc: string, signal?: AbortSignal): Promise<CharityDetail | null> {
  const select = (columns: string) =>
    getJson<CharityDetail[]>(
      `charities?${new URLSearchParams({ select: columns, cc_number: `eq.${cc}`, limit: '1' })}`,
      signal,
    )
  if (withDetails) {
    try {
      return (await select(DETAIL_COLUMNS))[0] ?? null
    } catch (err) {
      if (signal?.aborted) throw err
      // Before the charity_details_and_groups migration the newer columns are refused: ask for the basics.
      const rows = await select(BASIC_COLUMNS)
      withDetails = false
      return rows[0] ?? null
    }
  }
  return (await select(BASIC_COLUMNS))[0] ?? null
}
