// Is a project's certificate issued yet (spec 7.3 point 4)? A verified HTTPS request to its own host answers.
import { config, HOSTNAME_RE } from './config.ts'

const TTL_MS = 60_000
const cache = new Map<string, { at: number; result: 'ok' | 'pending' }>()

export async function probeCertificate(hostname: string): Promise<'ok' | 'pending'> {
  if (config.certProbe === 'off') return 'ok'
  const hit = cache.get(hostname)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result
  let result: 'ok' | 'pending' = 'pending'
  if (HOSTNAME_RE.test(hostname)) {
    try {
      // any answer means TLS verified; Traefik's default certificate fails verification
      await fetch(`https://${hostname}/health`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      result = 'ok'
    } catch { /* pending */ }
  }
  cache.set(hostname, { at: Date.now(), result })
  return result
}
