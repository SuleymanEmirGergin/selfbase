// Stand-in for client/dist/selfbase.deno.mjs (the built client), mounted at the same path /client.
export const __selfbase = true

const tolerant = () =>
  new Proxy(function () {}, {
    get: (_t, p) => (p === 'then' ? undefined : tolerant()),
    apply: () => tolerant(),
  })

export function createClient() {
  return tolerant()
}
