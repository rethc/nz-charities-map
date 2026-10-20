import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Netlify sets COMMIT_REF during builds; shown in the browser console so you can check which deploy is live.
const build = `${(process.env.COMMIT_REF ?? '').slice(0, 7) || 'local'}, built ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`

// Link previews need an absolute image address. Netlify sets URL to the site's main address
// during builds; without it (local builds) the address stays relative.
const siteUrl = (process.env.URL ?? '').replace(/\/+$/, '')

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    { name: 'site-url', transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', siteUrl) },
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
