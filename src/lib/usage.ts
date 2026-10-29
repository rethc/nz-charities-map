/**
 * Anonymous counts of what people press on the public map, read by admins on /admin/usage.
 * Only the kind of press is sent: never who pressed it, which charity, or what was typed.
 * The database adds one to that kind's count for the day (supabase/migrations/…_usage_counts.sql)
 * and ignores kinds it doesn't list, so a new kind needs adding there too.
 */
import { env, missingEnv } from './env'
import { headers } from './publicApi'

export const USAGE_KINDS = [
  // finding charities
  'search', 'sector', 'zoom_to', 'clear_filters', 'locate', 'cluster', 'browse',
  // opening a charity
  'pin', 'shared_pin', 'shared_list', 'search_pick', 'related', 'shared_link',
  // in a charity's details
  'summary', 'directions', 'copy_link', 'website', 'social', 'phone', 'email', 'show_more',
] as const

export type UsageKind = (typeof USAGE_KINDS)[number]

/** Counts one press. Fire and forget: a failed count never gets in anyone's way. */
export function countUse(kind: UsageKind): void {
  // Local runs (stand-in data, no database) aren't visitors.
  if (import.meta.env.DEV || missingEnv.length) return
  try {
    fetch(`${env.supabaseUrl}/rest/v1/rpc/count_use`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_kind: kind }),
      // Still sent when the press leaves the page (Browse by region).
      keepalive: true,
    }).catch(() => {})
  } catch {
    // fetch itself can throw (a blocked request in some browsers): nothing to do
  }
}
