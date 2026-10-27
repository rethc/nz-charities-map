import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { BrandMark, Spinner } from '../../components/Icons'
import { FullScreenLoader } from '../../components/StatusScreens'
import { useSession } from '../../hooks/useSession'
import { supabase } from '../../lib/supabase'

type Mode = 'link' | 'password'
type Status =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'sent'; email: string }
  | { state: 'error'; message: string }

/** Only ever send people back into the admin area after signing in. */
function safeNext(value: string | null): string {
  return value && value.startsWith('/admin') && !value.startsWith('//') ? value : '/admin/triage'
}

function friendlyError(message: string): string {
  if (/signups? not allowed|user not found/i.test(message))
    return 'No admin account uses that email address. Check it, or ask an existing admin to add you.'
  if (/invalid login credentials/i.test(message)) return "That email and password don't match an admin account."
  if (/rate limit|too many|only request this after/i.test(message))
    return 'Too many sign-in emails were sent recently. Wait a few minutes, or sign in with a password.'
  if (/email not confirmed/i.test(message)) return 'Confirm your email address first, using the message in your inbox.'
  return message
}

const input =
  'mt-1 h-10 w-full rounded border border-stroke border-b-stroke-strong bg-white px-3 text-base placeholder:text-muted hover:border-mist focus:border-b-brand focus:shadow-[inset_0_-1px_0_var(--color-brand)] focus:outline-none'

export default function LoginPage() {
  const auth = useSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [mode, setMode] = useState<Mode>('link')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<Status>(() => {
    const linkError = params.get('error')
    return linkError
      ? { state: 'error', message: `That sign-in link didn't work (${linkError}). Request a new one.` }
      : { state: 'idle' }
  })

  if (auth.status === 'loading') return <FullScreenLoader />
  if (auth.status === 'signed-in') return <Navigate to={next} replace />

  async function sendLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const address = email.trim()
    setStatus({ state: 'busy' })
    const { error } = await supabase.auth.signInWithOtp({
      email: address,
      // Existing accounts only: nobody can sign themselves up from this form.
      options: { shouldCreateUser: false, emailRedirectTo: new URL(next, window.location.origin).href },
    })
    setStatus(error ? { state: 'error', message: friendlyError(error.message) } : { state: 'sent', email: address })
  }

  async function signInWithPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus({ state: 'busy' })
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setStatus({ state: 'error', message: friendlyError(error.message) })
    else navigate(next, { replace: true })
  }

  const busy = status.state === 'busy'

  return (
    <main className="grid min-h-full place-items-center px-5 py-12">
      <title>Sign in – NZ Charities Map</title>
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <BrandMark size={30} />
          <p className="font-semibold">NZ Charities Map</p>
        </div>
        <h1 className="font-display text-2xl leading-tight font-semibold text-balance">Sign in to review locations</h1>
        <p className="mt-2 text-base text-muted">
          For admins: put charities on the map when their address couldn't be matched automatically.
        </p>

        <div role="group" aria-label="Sign-in method" className="mt-6 grid grid-cols-2 gap-1 rounded bg-paper p-1">
          {(['link', 'password'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                setMode(m)
                setStatus({ state: 'idle' })
              }}
              className={`rounded py-2 text-base font-semibold ${mode === m ? 'bg-white shadow-sm' : 'text-muted hover:text-ink'}`}
            >
              {m === 'link' ? 'Email link' : 'Password'}
            </button>
          ))}
        </div>

        {status.state === 'sent' ? (
          <div role="status" className="mt-6 rounded-2xl bg-white p-4 shadow-card">
            <p className="font-semibold">Check your inbox</p>
            <p className="mt-1 text-base">
              We sent a sign-in link to {status.email}. Open it in this browser on this device, because the link only
              works where it was requested.
            </p>
            <button
              type="button"
              onClick={() => setStatus({ state: 'idle' })}
              className="mt-3 text-base font-semibold underline underline-offset-4"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={mode === 'link' ? sendLink : signInWithPassword} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="block text-base font-semibold">
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={input}
              />
            </div>
            {mode === 'password' && (
              <div>
                <label htmlFor="password" className="block text-base font-semibold">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={input}
                />
              </div>
            )}
            {status.state === 'error' && (
              <p role="alert" className="rounded border border-[#eeacb2] bg-alert-tint px-3 py-2 text-base text-alert">
                {status.message}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="flex h-10 w-full items-center justify-center gap-2 rounded bg-brand text-base font-semibold text-white hover:bg-brand-hover active:bg-brand-pressed disabled:opacity-70"
            >
              {busy && <Spinner size={16} />}
              {mode === 'link' ? 'Email me a sign-in link' : 'Sign in'}
            </button>
          </form>
        )}

        <p className="mt-8 text-base">
          <Link to="/" className="font-semibold underline underline-offset-4">
            Back to the map
          </Link>
        </p>
      </div>
    </main>
  )
}
