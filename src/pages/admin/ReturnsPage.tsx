import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { BrandMark, ExternalIcon, PinIcon, Spinner } from '../../components/Icons'
import { RequireAdmin } from '../../components/RequireAdmin'
import { registerUrl } from '../../lib/charities'
import type { ReturnCheckFinding, ReturnChecks } from '../../lib/database.types'
import { formatCount } from '../../lib/dom'
import { fold } from '../../lib/search'
import { supabase } from '../../lib/supabase'

/**
 * Annual return checks (scripts/return_checks.py), for admins only. Automated findings from the
 * register's public data: a lead to check on the register, never a verdict.
 */

type CheckName = ReturnCheckFinding['check']
type LoadState = { status: 'loading' } | { status: 'ready'; data: ReturnChecks } | { status: 'error'; message: string }

const CHECKS: Array<{ name: CheckName; label: string; about: string }> = [
  {
    name: 'overdue',
    label: 'Overdue',
    about:
      "The next return was due 6 months after the balance date and none has been filed. The public data has no extensions, so a charity with one can show here, and day counts can be off: the register page shows the real due dates. Charities with no return of their own in recent years aren't listed, as a group may file for them.",
  },
  {
    name: 'year_end_mismatch',
    label: 'Year end differs',
    about:
      "The latest return's year end isn't the charity's registered balance date. Expected when a charity changes its balance date; otherwise the return may use the wrong one.",
  },
  {
    name: 'tier_over_limit',
    label: 'Over tier limit',
    about:
      "Filed under the same tier for three returns running while over that tier's limit (Tier 2: two). The rules allow two years over before moving up. Uses today's limits for every year.",
  },
]

/** Overdue returns this late or more are shown by default: earlier ones are often still being processed. */
const LATE_DAYS = 60
const PAGE = 200

const dateFormat = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' })
const linkClass = 'font-semibold underline decoration-ink/30 underline-offset-4 hover:decoration-ink'

const daysOverdue = (f: ReturnCheckFinding) => Number(f.details.days_overdue ?? 0)

export default function ReturnsPage() {
  return (
    <>
      <title>Annual return checks – NZ Charities Map</title>
      <RequireAdmin>{(session) => <Returns email={session.user.email ?? null} />}</RequireAdmin>
    </>
  )
}

function Returns({ email }: { email: string | null }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [check, setCheck] = useState<CheckName>('overdue')
  const [allOverdue, setAllOverdue] = useState(false)
  const [filter, setFilter] = useState('')
  const [shown, setShown] = useState(PAGE)

  const loading = load.status === 'loading'
  useEffect(() => {
    if (!loading) return
    let active = true
    supabase.rpc('get_return_checks').then(({ data, error }) => {
      if (!active) return
      if (error) {
        // Before the return_checks migration the function doesn't exist yet.
        const missing = error.code === 'PGRST202' || /could not find the function/i.test(error.message)
        setLoad({
          status: 'error',
          message: missing
            ? 'The database has no annual return checks yet. Run the return_checks migration in Supabase, then the "Annual return checks" workflow.'
            : error.message,
        })
      } else {
        setLoad({ status: 'ready', data: data as unknown as ReturnChecks })
      }
    })
    return () => {
      active = false
    }
  }, [loading])

  const findings = useMemo(() => (load.status === 'ready' ? load.data.findings : []), [load])
  const counts = useMemo(() => {
    const c = new Map<CheckName, number>()
    for (const f of findings) {
      if (f.check === 'overdue' && daysOverdue(f) <= LATE_DAYS) continue
      c.set(f.check, (c.get(f.check) ?? 0) + 1)
    }
    return c
  }, [findings])
  const overdueAll = useMemo(() => findings.filter((f) => f.check === 'overdue').length, [findings])

  const list = useMemo(() => {
    const q = fold(filter.trim())
    const rows = findings.filter(
      (f) =>
        f.check === check &&
        (check !== 'overdue' || allOverdue || daysOverdue(f) > LATE_DAYS) &&
        (!q || fold(f.name).includes(q) || f.cc.toLowerCase().includes(q)),
    )
    return check === 'overdue'
      ? rows.sort((a, b) => daysOverdue(b) - daysOverdue(a))
      : rows.sort((a, b) => a.name.localeCompare(b.name))
  }, [findings, check, allOverdue, filter])

  const about = CHECKS.find((c) => c.name === check)!.about
  const checkedAt = load.status === 'ready' && load.data.checked_at ? new Date(load.data.checked_at) : null

  return (
    <div className="flex h-full flex-col">
      <header className="on-ink flex flex-none flex-wrap items-center gap-x-4 gap-y-2 bg-ink px-4 py-3 text-paper">
        <div className="flex items-center gap-2.5">
          <BrandMark size={26} />
          <h1 className="text-lg leading-tight font-bold">Annual return checks</h1>
        </div>
        <nav aria-label="Account" className="ml-auto flex items-center gap-4 text-sm">
          <Link to="/admin/triage" className="font-semibold underline decoration-ink-line underline-offset-4 hover:decoration-kowhai">
            Location review
          </Link>
          <Link to="/" className="font-semibold underline decoration-ink-line underline-offset-4 hover:decoration-kowhai">
            Public map
          </Link>
          {email && <span className="hidden text-mist sm:inline">{email}</span>}
          <button
            type="button"
            onClick={() => void supabase.auth.signOut()}
            className="rounded-lg border border-ink-line px-3 py-1.5 font-semibold hover:border-mist"
          >
            Sign out
          </button>
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
          <p className="text-sm text-muted">
            From the Charities Register's public data
            {checkedAt ? `, checked ${dateFormat.format(checkedAt)}` : ''}. Automated, and only shown to admins: confirm
            on the register before acting on anything here.
          </p>

          {load.status === 'loading' && (
            <p className="mt-8 flex items-center gap-2 text-muted">
              <Spinner /> Loading the checks…
            </p>
          )}
          {load.status === 'error' && (
            <div className="mt-6 rounded-xl border border-alert/30 bg-alert-tint p-4">
              <p>{load.message}</p>
              <button
                type="button"
                onClick={() => setLoad({ status: 'loading' })}
                className="mt-3 rounded-lg bg-ink px-4 py-2 font-semibold text-paper hover:bg-ink-soft"
              >
                Try again
              </button>
            </div>
          )}

          {load.status === 'ready' && (
            <>
              <div role="tablist" aria-label="Checks" className="mt-5 flex flex-wrap gap-2">
                {CHECKS.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    role="tab"
                    aria-selected={check === c.name}
                    onClick={() => {
                      setCheck(c.name)
                      setShown(PAGE)
                    }}
                    className={`rounded-full border px-3.5 py-1.5 text-[0.9375rem] font-semibold ${
                      check === c.name ? 'border-ink bg-ink text-paper' : 'border-line bg-white hover:border-ink/40'
                    }`}
                  >
                    {c.label}{' '}
                    <span className={check === c.name ? 'text-mist' : 'text-muted'}>
                      {formatCount(counts.get(c.name) ?? 0)}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[0.9375rem] text-muted">{about}</p>

              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
                <label htmlFor="returns-filter" className="sr-only">
                  Filter by name or CC number
                </label>
                <input
                  id="returns-filter"
                  type="search"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value)
                    setShown(PAGE)
                  }}
                  placeholder="Filter by name or CC number"
                  className="h-10 w-full max-w-sm rounded-lg border border-line bg-white px-3 text-[0.9375rem] placeholder:text-muted focus:border-ink"
                />
                {check === 'overdue' && (
                  <label className="flex items-center gap-2 text-[0.9375rem]">
                    <input type="checkbox" checked={allOverdue} onChange={(e) => setAllOverdue(e.target.checked)} />
                    Include returns up to {LATE_DAYS} days late ({formatCount(overdueAll)} in all)
                  </label>
                )}
              </div>

              <p className="mt-4 text-sm text-muted" aria-live="polite">
                {formatCount(list.length)} {list.length === 1 ? 'charity' : 'charities'}
              </p>
              <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-white">
                {list.slice(0, shown).map((f) => (
                  <li key={`${f.check}-${f.cc}`} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <p className="font-semibold">
                        {f.name} <span className="font-normal text-muted tabular-nums">{f.cc}</span>
                      </p>
                      <p className="flex flex-none items-center gap-4 text-sm">
                        <a
                          href={registerUrl(f.cc)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`${linkClass} inline-flex items-center gap-1`}
                        >
                          Register
                          <ExternalIcon size={14} />
                          <span className="sr-only">(opens in a new tab)</span>
                        </a>
                        <a href={`/?${new URLSearchParams({ cc: f.cc })}`} className={`${linkClass} inline-flex items-center gap-1`}>
                          <PinIcon size={14} />
                          Map
                        </a>
                      </p>
                    </div>
                    <p className="mt-1 text-[0.9375rem]">{f.summary}</p>
                  </li>
                ))}
                {list.length === 0 && <li className="px-4 py-6 text-muted">Nothing to show here.</li>}
              </ul>
              {list.length > shown && (
                <button
                  type="button"
                  onClick={() => setShown((n) => n + PAGE)}
                  className="mt-3 rounded-lg border border-line bg-white px-4 py-2 font-semibold hover:border-ink/40"
                >
                  Show {formatCount(Math.min(PAGE, list.length - shown))} more
                </button>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
