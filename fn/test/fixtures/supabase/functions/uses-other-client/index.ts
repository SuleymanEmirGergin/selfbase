// The bare npm specifier must also load the selfbase client, never the real package.
import * as npmBare from 'npm:@supabase/supabase-js'

Deno.serve(() => Response.json({ npm: (npmBare as Record<string, unknown>).__selfbase === true }))
