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

export async function selectCharity(cc: string, signal?: AbortSignal): Promise<CharityDetail | null> {
  const params = new URLSearchParams({
    select: 'cc_number,name,sector,street,suburb,city,postcode',
    cc_number: `eq.${cc}`,
    limit: '1',
  })
  const rows = await getJson<CharityDetail[]>(`charities?${params}`, signal)
  return rows[0] ?? null
}
