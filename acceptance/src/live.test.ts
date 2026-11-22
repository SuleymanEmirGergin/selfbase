// ACCEPTANCE_MODE=live: a project in use (project #1). No sign-up and no schema change: reads, a realtime connection
// and, only when ACCEPTANCE_LOGIN_EMAIL and ACCEPTANCE_LOGIN_PASSWORD are set, one sign-in (its session is signed out
// again, that session only).
import { afterAll, describe, expect } from 'vitest'
import { client, env, hiddenPaths, http, kase, mgmtGet, mgmtHealth, mgmtKeys, sql, summary } from './helpers.ts'

describe.skipIf(env.mode !== 'live')('live', () => {
  afterAll(() => summary())

  kase('health', async () => {
    const res = await http('/health')
    expect(res.status).toBe(200)
  })

  kase('/rest/v1/ with the anon key', async () => {
    const res = await http('/rest/v1/', { headers: { apikey: env.anon, authorization: `Bearer ${env.anon}` } })
    expect(res.status).toBe(200)
  })

  kase('storage: an object of a public bucket reads 200', async (skip) => {
    const [o] = await sql(`select o.bucket_id, o.name from storage.objects o join storage.buckets b on b.id = o.bucket_id where b.public order by o.bucket_id, o.name limit 1`)
    if (!o) skip('no object in a public bucket')
    const res = await fetch(client().storage.from(o.bucket_id).getPublicUrl(o.name).data.publicUrl, { signal: AbortSignal.timeout(15_000) })
    await res.body?.cancel()
    expect(res.status, `${o.bucket_id}/${o.name}`).toBe(200)
  })

  kase('realtime: a connection is accepted', async () => {
    const ws = new WebSocket(`${client().realtime.endPoint}?token=${encodeURIComponent(env.anon)}`)
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no pong within 10 s')), 10_000)
        ws.onopen = () => ws.send(JSON.stringify({ type: 'ping' }))
        ws.onmessage = (e) => JSON.parse(String(e.data)).type === 'pong' && (clearTimeout(t), resolve())
        ws.onclose = (e) => reject(new Error(`closed with ${e.code} ${e.reason}`))
      })
    } finally {
      ws.close()
    }
  })

  kase('the admin and panel paths are not on the project host', hiddenPaths)
  kase('management: get project', mgmtGet)
  kase('management: services health', mgmtHealth)
  kase('management: api-keys, service_role masked', mgmtKeys)

  kase('auth: sign-in with the login variables', async (skip) => {
    if (!env.loginEmail || !env.loginPassword) skip('ACCEPTANCE_LOGIN_EMAIL / ACCEPTANCE_LOGIN_PASSWORD not set')
    const sb = client()
    const r = await sb.auth.signInWithPassword({ email: env.loginEmail, password: env.loginPassword })
    expect(r.error).toBeNull()
    expect((await sb.auth.getUser()).data.user?.email).toBe(env.loginEmail.toLowerCase())
    expect((await sb.auth.signOut({ scope: 'local' })).error).toBeNull()
  })
})
