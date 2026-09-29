import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export type SessionState =
  | { status: 'loading'; session: null }
  | { status: 'signed-out'; session: null }
  | { status: 'signed-in'; session: Session }

const toState = (session: Session | null): SessionState =>
  session ? { status: 'signed-in', session } : { status: 'signed-out', session: null }

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading', session: null })

  useEffect(() => {
    let active = true
    // getSession() waits for supabase-js to finish initialising, including the PKCE
    // code exchange when arriving from a magic link.
    void supabase.auth.getSession().then(({ data }) => active && setState(toState(data.session)))
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setState(toState(session))
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  return state
}
