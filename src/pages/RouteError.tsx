import { isRouteErrorResponse, Link, useRouteError } from 'react-router'
import { FullScreenMessage } from '../components/StatusScreens'

export function RouteError() {
  const error = useRouteError()
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error)
  // A new deploy renames the lazy admin chunks; a stale tab then fails to fetch them.
  const staleChunk = /dynamically imported module|Importing a module script failed/i.test(detail)

  return (
    <FullScreenMessage title={staleChunk ? 'A newer version of the site is available' : 'This page failed to load'}>
      <p>
        {staleChunk
          ? 'Reload to get the latest version.'
          : 'Reload to try again. If it keeps happening, the details below will help whoever maintains the site.'}
      </p>
      {!staleChunk && <pre className="overflow-x-auto rounded-lg bg-line p-3 text-sm whitespace-pre-wrap">{detail}</pre>}
      <div className="flex gap-4">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center justify-center gap-1.5 rounded px-3 text-base font-semibold transition-colors h-9 bg-brand text-white hover:bg-brand-hover active:bg-brand-pressed"
        >
          Reload
        </button>
        <Link to="/" className="self-center text-link underline-offset-2 hover:text-brand-pressed hover:underline">
          Go to the map
        </Link>
      </div>
    </FullScreenMessage>
  )
}
