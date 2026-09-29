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
          className="rounded-lg bg-ink px-4 py-2 font-semibold text-paper hover:bg-ink-soft"
        >
          Reload
        </button>
        <Link to="/" className="self-center font-semibold underline underline-offset-4">
          Go to the map
        </Link>
      </div>
    </FullScreenMessage>
  )
}
