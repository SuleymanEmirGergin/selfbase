import { config } from '../config.ts'
import type { SessionJson } from './sessions.ts'

/** target with its fragment replaced by params (how GoTrue hands tokens and errors to the browser). */
export const withFragment = (target: string, params: Record<string, string>) =>
  `${target.split('#')[0]}#${new URLSearchParams(params)}`

export const sessionParams = (s: SessionJson): Record<string, string> => ({
  access_token: s.access_token,
  expires_at: String(s.expires_at),
  expires_in: String(s.expires_in),
  refresh_token: s.refresh_token,
  token_type: s.token_type,
})

// "*" matches within one path segment, "**" (and a "*" at the very end) any suffix
function pathRegex(path: string): RegExp {
  const parts = path.split(/(\*\*?)/) // 'a/*' -> ['a/', '*', '']
  const last = parts.length - 2
  const re = parts.map((p, i) =>
    p === '**' || (p === '*' && i === last && parts[i + 1] === '') ? '.*'
      : p === '*' ? '[^/]*'
        : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${re.join('')}$`)
}

function matches(url: URL, pattern: string): boolean {
  // wildcards only in the path: the origin part is compared exactly, as parsed URLs
  // no path ("http://localhost:3000") means the origin's root, with or without the trailing slash
  const m = pattern.match(/^(https?:\/\/[^/*?#]+)(\/.*)?$/)
  if (!m) return false
  m[2] ??= '/'
  let origin: string
  try {
    origin = new URL(m[1]).origin
  } catch {
    return false
  }
  return url.origin === origin && pathRegex(m[2]).test(url.pathname + url.search)
}

/** `requested` when it is in AUTH_REDIRECT_ALLOWLIST (exact, or a pattern with * / ** in the path), else SITE_URL. */
export function safeRedirect(requested?: string): string {
  if (!requested) return config.siteUrl
  const list = config.authRedirectAllowlist
  if (list.includes(requested)) return requested
  let url: URL
  try {
    url = new URL(requested)
  } catch {
    return config.siteUrl
  }
  if (url.username || url.password || !/^https?:$/.test(url.protocol)) return config.siteUrl
  if (!list.some((p) => matches(url, p))) return config.siteUrl
  url.hash = ''
  return url.href
}
