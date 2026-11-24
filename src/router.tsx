import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router'
import { FullScreenLoader, SetupScreen } from './components/StatusScreens'
import { missingEnv } from './lib/env'
import { MapPage } from './pages/MapPage'
import { NotFound } from './pages/NotFound'
import { RouteError } from './pages/RouteError'

function Root() {
  const { pathname } = useLocation()
  // `npm run dev` can show the intelligence pages from a dry run with no database: they check for themselves.
  const preview = import.meta.env.DEV && pathname.startsWith('/admin/intelligence')
  return missingEnv.length && !preview ? <SetupScreen missing={missingEnv} /> : <Outlet />
}

const intel = () => import('./pages/admin/intel')

export const router = createBrowserRouter([
  {
    path: '/',
    Component: Root,
    ErrorBoundary: RouteError,
    // Shown while a lazy route (the admin pages) loads on a cold start.
    HydrateFallback: FullScreenLoader,
    children: [
      { index: true, Component: MapPage },
      {
        path: 'admin',
        children: [
          { index: true, element: <Navigate to="/admin/triage" replace /> },
          // Admin screens are split out so public visitors never download them.
          { path: 'login', lazy: async () => ({ Component: (await import('./pages/admin/LoginPage')).default }) },
          { path: 'triage', lazy: async () => ({ Component: (await import('./pages/admin/TriagePage')).default }) },
          { path: 'returns', lazy: async () => ({ Component: (await import('./pages/admin/ReturnsPage')).default }) },
          { path: 'usage', lazy: async () => ({ Component: (await import('./pages/admin/UsagePage')).default }) },
          { path: 'intelligence', lazy: async () => ({ Component: (await intel()).OverviewPage }) },
          { path: 'intelligence/watchlist', lazy: async () => ({ Component: (await intel()).WatchlistPage }) },
          { path: 'intelligence/charity/:cc?', lazy: async () => ({ Component: (await intel()).CharityPage }) },
        ],
      },
      { path: '*', Component: NotFound },
    ],
  },
])
