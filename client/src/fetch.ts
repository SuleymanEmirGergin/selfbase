import type { Fetch } from './types.ts'

export const resolveFetch = (customFetch?: Fetch): Fetch => customFetch ?? ((...args) => fetch(...args))

/** Adds `apikey` and `Authorization: Bearer <session token ?? key>` unless the caller set them. */
export function fetchWithAuth(key: string, getAccessToken: () => Promise<string | null>, customFetch?: Fetch): Fetch {
  const doFetch = resolveFetch(customFetch)
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('apikey')) headers.set('apikey', key)
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${(await getAccessToken()) ?? key}`)
    return doFetch(input, { ...init, headers })
  }
}
