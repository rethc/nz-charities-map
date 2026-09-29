import type { LonLat } from './geo'
import { supabase } from './supabase'

export interface GeocodeCandidate {
  lonLat: LonLat
  label: string
  source: 'linz' | 'photon'
  precision: 'address' | 'street' | 'locality'
  score: number | null
}

export interface GeocodeResponse {
  candidates: GeocodeCandidate[]
  notice?: string
}

/**
 * Admin-only live geocoding. Production goes through /api/geocode (a Netlify Function
 * that keeps the LINZ key server-side and checks the caller is an admin). Under plain
 * `vite` there are no functions, so it falls back to calling Photon directly.
 */
export async function geocodeAddress(query: string, signal?: AbortSignal): Promise<GeocodeResponse> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  let res: Response | null = null
  try {
    res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
  }
  if (res && res.headers.get('content-type')?.includes('application/json')) {
    const body = (await res.json()) as GeocodeResponse & { error?: string }
    if (!res.ok) throw new Error(body.error ?? `Geocoder error (HTTP ${res.status})`)
    return body
  }
  return {
    candidates: await photonDirect(query, signal),
    notice: 'Local dev: showing Photon results only. Run `netlify dev` to include LINZ.',
  }
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] }
  properties?: Record<string, string | undefined>
}

async function photonDirect(query: string, signal?: AbortSignal): Promise<GeocodeCandidate[]> {
  const params = new URLSearchParams({ q: query, limit: '6', lang: 'en', bbox: '165.8,-47.4,178.9,-34.0' })
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal })
  if (!res.ok) throw new Error(`Photon error (HTTP ${res.status})`)
  const json = (await res.json()) as { features?: PhotonFeature[] }
  return (json.features ?? [])
    .filter((f) => f.properties?.countrycode?.toUpperCase() === 'NZ' && f.geometry?.coordinates)
    .map((f) => {
      const p = f.properties ?? {}
      const first = p.housenumber ? `${p.housenumber} ${p.street ?? ''}`.trim() : (p.street ?? p.name)
      return {
        lonLat: f.geometry!.coordinates!,
        label: [first, p.district ?? p.locality, p.city].filter(Boolean).join(', '),
        source: 'photon' as const,
        precision: p.type === 'house' ? 'address' : p.type === 'street' ? 'street' : 'locality',
        score: null,
      }
    })
}
