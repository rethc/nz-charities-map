import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // MapLibre 6 starts its worker with `new Worker(url, { type: 'module' })`, so emit
  // the worker (imported via `?worker&url` in src/lib/maplibre.ts) as an ES module.
  worker: { format: 'es' },
  server: {
    // `netlify dev` (port 8888) proxies to this server and adds the /api/* functions.
    port: 5173,
  },
})
