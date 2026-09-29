import { createBrowserRouter, Navigate, Outlet } from 'react-router'
import { FullScreenLoader, SetupScreen } from './components/StatusScreens'
import { missingEnv } from './lib/env'
import { MapPage } from './pages/MapPage'
import { NotFound } from './pages/NotFound'
import { RouteError } from './pages/RouteError'

function Root() {
  return missingEnv.length ? <SetupScreen missing={missingEnv} /> : <Outlet />
}

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
        ],
      },
      { path: '*', Component: NotFound },
    ],
  },
])
