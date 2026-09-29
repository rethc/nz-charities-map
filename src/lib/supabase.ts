import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { env, missingEnv } from './env'

// With missing configuration we still create a client (pointing nowhere) so imports
// don't throw; <App> renders a setup screen instead of making requests.
export const supabase = createClient<Database>(
  missingEnv.length ? 'https://example.invalid' : env.supabaseUrl,
  missingEnv.length ? 'missing-key' : env.supabaseKey,
  {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
)
