/**
 * A charity's social pages, named by their address. The sync (scripts/sync_charities.py)
 * cleans them up from the register's free-text fields; a platform added there needs adding here.
 * Shared by the map's popup and the static pages.
 */

export type SocialKey =
  | 'facebook'
  | 'instagram'
  | 'x'
  | 'linkedin'
  | 'youtube'
  | 'tiktok'
  | 'bluesky'
  | 'linktree'
  | 'givealittle'

export interface SocialLink {
  /** Which platform, for its logo (src/lib/socialIcons.ts). */
  key: SocialKey
  /** The platform, as people know it: "Facebook", "X (Twitter)". */
  name: string
  href: string
}

/** In the order they're shown. */
const PLATFORMS: Array<{ key: SocialKey; name: string; host: RegExp }> = [
  { key: 'facebook', name: 'Facebook', host: /(^|\.)(facebook\.com|facebook\.co\.nz|fb\.com|fb\.me)$/ },
  { key: 'instagram', name: 'Instagram', host: /(^|\.)(instagram\.com|instagr\.am)$/ },
  { key: 'x', name: 'X (Twitter)', host: /(^|\.)(x\.com|twitter\.com)$/ },
  { key: 'linkedin', name: 'LinkedIn', host: /(^|\.)linkedin\.com$/ },
  { key: 'youtube', name: 'YouTube', host: /(^|\.)(youtube\.com|youtu\.be)$/ },
  { key: 'tiktok', name: 'TikTok', host: /(^|\.)tiktok\.com$/ },
  { key: 'bluesky', name: 'Bluesky', host: /(^|\.)bsky\.app$/ },
  { key: 'linktree', name: 'Linktree', host: /(^|\.)linktr\.ee$/ },
  { key: 'givealittle', name: 'Givealittle', host: /(^|\.)givealittle\.co\.nz$/ },
]

/** The platform's place in PLATFORMS and its link, for an http(s) address on one with a page given; else null. */
function platformOf(value: unknown): { rank: number; href: string } | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.pathname.replace(/\/+$/, '') === '') return null // the site's front page isn't anyone's
  const rank = PLATFORMS.findIndex((p) => p.host.test(url.hostname.toLowerCase()))
  if (rank < 0) return null
  url.protocol = 'https:' // every one of these sites serves https
  return { rank, href: url.href }
}

/** True for a website that is really a social page ("www.facebook.com/ourtrust"): it's shown with the socials instead. */
export function isSocialPage(website: string | null | undefined): boolean {
  return platformOf(website) !== null
}

/**
 * One link per platform, in a fixed order. `socials` comes from the database; a website that is a
 * social page fills in its platform when the socials don't have it (or before the sync has run).
 */
export function socialLinks(socials: unknown, website?: string | null): SocialLink[] {
  const values: unknown[] = [...(Array.isArray(socials) ? socials : []), website]
  const byRank = new Map<number, string>()
  for (const value of values) {
    const found = platformOf(value)
    if (found && !byRank.has(found.rank)) byRank.set(found.rank, found.href)
  }
  return [...byRank]
    .sort(([a], [b]) => a - b)
    .map(([rank, href]) => ({ key: PLATFORMS[rank]!.key, name: PLATFORMS[rank]!.name, href }))
}
