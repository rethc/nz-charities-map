import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// https://vite.dev/config/
// Netlify sets COMMIT_REF during builds; shown in the browser console so you can check which deploy is live.
const build = `${(process.env.COMMIT_REF ?? '').slice(0, 7) || 'local'}, built ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`

// Link previews need an absolute image address. Netlify sets URL to the site's main address
// during builds; without it (local builds) the address stays relative.
const siteUrl = (process.env.URL ?? '').replace(/\/+$/, '')

/**
 * `npm run dev` only: serves a dry run of scripts/intelligence.py (the .intel-preview folder) to
 * the intelligence pages, so they can be tried with no database and no sign-in. The folder holds
 * findings about charities: it is never in git and, served only by the dev server, never in a build.
 */
function intelPreview(): Plugin {
  return {
    name: 'intel-preview',
    apply: 'serve',
    configureServer(server) {
      const dir = resolve(server.config.root, '.intel-preview')
      let details: { read: number; byCc: Record<string, unknown> } | null = null
      server.middlewares.use('/__intel', (req, res) => {
        const path = (req.url ?? '/').split('?')[0]!
        const json = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        try {
          const snapshot = resolve(dir, 'snapshot.json')
          if (!existsSync(snapshot)) return json(404, { error: 'No dry run in .intel-preview' })
          if (path === '/snapshot') {
            res.setHeader('Content-Type', 'application/json')
            if (req.method === 'HEAD') return void res.end()
            return void createReadStream(snapshot).pipe(res)
          }
          const cc = /^\/charity\/(CC\d+)$/i.exec(decodeURIComponent(path))?.[1]?.toUpperCase()
          if (!cc) return json(404, { error: 'Not found' })
          const file = resolve(dir, 'details.json')
          const changed = statSync(file).mtimeMs
          if (details?.read !== changed) details = { read: changed, byCc: JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> }
          const detail = details.byCc[cc]
          // As get_intel_charity() answers, without what only the database knows.
          return detail ? json(200, { detail, purpose: null, on_map: false, checks: [] }) : json(404, { error: 'No such charity' })
        } catch (err) {
          return json(500, { error: err instanceof Error ? err.message : String(err) })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    { name: 'site-url', transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', siteUrl) },
    intelPreview(),
  ],
  define: { APP_BUILD: JSON.stringify(build) },
  // The source is public on GitHub anyway; maps make errors on the live site readable.
  build: { sourcemap: true },
  // MapLibre 6 starts its worker with `new Worker(url, { type: 'module' })`, so emit
  // the worker (imported via `?worker&url` in src/lib/maplibre.ts) as an ES module.
  worker: { format: 'es' },
  server: {
    // `netlify dev` (port 8888) proxies to this server and adds the /api/* functions.
    port: 5173,
  },
})
