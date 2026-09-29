import type { Session } from '@supabase/supabase-js'
import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useSession } from '../hooks/useSession'
import { supabase } from '../lib/supabase'
import { FullScreenMessage } from './StatusScreens'

type Access = { userId: string; result: 'admin' | 'denied' } | { userId: string; result: 'error'; message: string }

const button = 'rounded-lg bg-ink px-4 py-2 font-semibold text-paper hover:bg-ink-soft'

/**
 * Admins only. This is a courtesy for the UI — the database enforces the same rule
 * in every admin RPC (is_admin()), so a crafted request gets nowhere either.
 */
export function RequireAdmin({ children }: { children: (session: Session) => ReactNode }) {
  const auth = useSession()
  const location = useLocation()
  const [access, setAccess] = useState<Access | null>(null)
  const userId = auth.session?.user.id ?? null
  const needsCheck = userId !== null && access?.userId !== userId

  useEffect(() => {
    if (!needsCheck || !userId) return
    let active = true
    supabase.rpc('is_admin').then(({ data, error }) => {
      if (!active) return
      setAccess(error ? { userId, result: 'error', message: error.message } : { userId, result: data ? 'admin' : 'denied' })
    })
    return () => {
      active = false
    }
  }, [needsCheck, userId])

  if (auth.status === 'loading') return <FullScreenMessage title="Checking your sign-in…" busy />

  if (auth.status === 'signed-out') {
    const params = new URLSearchParams({ next: location.pathname })
    // An expired or reused magic link comes back with an error description.
    const linkError =
      new URLSearchParams(location.search).get('error_description') ??
      new URLSearchParams(location.hash.slice(1)).get('error_description')
    if (linkError) params.set('error', linkError)
    return <Navigate to={`/admin/login?${params}`} replace />
  }

  // Drop the one-time ?code= left by the magic-link redirect once the session exists.
  if (new URLSearchParams(location.search).has('code')) return <Navigate to={location.pathname} replace />

  if (!access || access.userId !== auth.session.user.id) return <FullScreenMessage title="Checking your access…" busy />

  if (access.result === 'denied') {
    return (
      <FullScreenMessage title="This account can't review locations">
        <p>
          You're signed in as <strong>{auth.session.user.email}</strong>, which isn't on the admin list. Ask whoever
          runs the site to add this email address.
        </p>
        <button type="button" className={button} onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </FullScreenMessage>
    )
  }

  if (access.result === 'error') {
    return (
      <FullScreenMessage title="Couldn't check your access">
        <p>{access.message}</p>
        <button
          type="button"
          className={button}
          onClick={() => setAccess(null)}
        >
          Try again
        </button>
      </FullScreenMessage>
    )
  }

  return <>{children(auth.session)}</>
}
