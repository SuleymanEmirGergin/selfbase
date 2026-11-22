import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import * as mod from 'https://esm.sh/@supabase/supabase-js@2.108.2'

Deno.serve(() =>
  Response.json({ selfbase: (mod as Record<string, unknown>).__selfbase === true, client: typeof createClient('http://x', 'k') }),
)
