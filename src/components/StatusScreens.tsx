import type { ReactNode } from 'react'
import { BrandMark, Spinner } from './Icons'

export function FullScreenMessage({
  title,
  children,
  busy = false,
}: {
  title: string
  children?: ReactNode
  busy?: boolean
}) {
  return (
    <main className="grid min-h-full place-items-center px-6 py-12">
      <div className="w-full max-w-md" role={busy ? 'status' : undefined} aria-live={busy ? 'polite' : undefined}>
        <div className="mb-5 flex items-center gap-3">
          {busy ? <Spinner size={28} className="text-ink" /> : <BrandMark />}
          <h1 className="text-xl font-bold text-balance">{title}</h1>
        </div>
        {children && <div className="space-y-4 text-[0.9375rem] leading-relaxed text-ink">{children}</div>}
      </div>
    </main>
  )
}

export function FullScreenLoader() {
  return <FullScreenMessage title="Loading…" busy />
}

/** Shown instead of the app when the Supabase connection details are missing. */
export function SetupScreen({ missing }: { missing: string[] }) {
  return (
    <FullScreenMessage title="Connect a Supabase project to load the map">
      <p>The site was built without these environment variables:</p>
      <ul className="space-y-1">
        {missing.map((name) => (
          <li key={name}>
            <code className="rounded bg-line px-1.5 py-0.5 text-sm">{name}</code>
          </li>
        ))}
      </ul>
      <p>
        For local development, copy <code className="text-sm">.env.example</code> to{' '}
        <code className="text-sm">.env.local</code>, fill in the values from Supabase (Project Settings, API Keys)
        and restart <code className="text-sm">npm run dev</code>. On Netlify, add them under Site configuration,
        Environment variables, then redeploy.
      </p>
    </FullScreenMessage>
  )
}
