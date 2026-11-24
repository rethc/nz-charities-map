import { Charity } from './Charity'
import { Overview } from './Overview'
import { IntelShell } from './shell'
import { Watchlist } from './Watchlist'

/**
 * Intelligence (scripts/intelligence.py), for admins only, in Microsoft's Fluent UI like the
 * site's other reports: the sector at a glance, every charity ranked by a measure, and one
 * charity in full. The three pages share one download of every charity's measures.
 */

export function OverviewPage() {
  return (
    <IntelShell view="overview" title="Intelligence">
      {(intel) => <Overview intel={intel} />}
    </IntelShell>
  )
}

export function WatchlistPage() {
  return (
    <IntelShell view="watchlist" title="Watchlist">
      {(intel) => <Watchlist intel={intel} />}
    </IntelShell>
  )
}

export function CharityPage() {
  return (
    <IntelShell view="charity" title="Charity profile">
      {(intel) => <Charity intel={intel} />}
    </IntelShell>
  )
}
