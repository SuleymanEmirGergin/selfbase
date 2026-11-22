import { dirname, join } from 'node:path'

export const functionsDir = Deno.env.get('FUNCTIONS_DIR') || '/functions'
export const port = Number(Deno.env.get('PORT') || 8000)
export const jwtSecret = Deno.env.get('JWT_SECRET') ?? ''
// Supabase layout: supabase/config.toml sits next to supabase/functions.
export const configToml = join(dirname(functionsDir), 'config.toml')

/** `[functions.<name>] verify_jwt = true|false` from config.toml; a missing file means every function defaults to true. */
export function parseVerifyJwt(toml: string): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  let fn: string | null = null
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const section = line.match(/^\[([^\]]+)\]$/)
    if (section) {
      fn = section[1].trim().match(/^functions\.["']?([^"']+)["']?$/)?.[1] ?? null
      continue
    }
    const kv = line.match(/^verify_jwt\s*=\s*(true|false)$/)
    if (fn && kv) out[fn] = kv[1] === 'true'
  }
  return out
}

function readToml(): string {
  try {
    return Deno.readTextFileSync(configToml)
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return ''
    throw e
  }
}

export const verifyJwt = parseVerifyJwt(readToml())
