// ACCEPTANCE_MODE=full: a throw-away project. Sign-up through the mailed link, RLS, storage, realtime, functions, the
// hidden paths and the Management API including pause and restore. Every object carries the run prefix and is
// dropped in afterAll, the users too. Nothing is written when the project reports smtp_configured: true (the mails
// would leave the server, and the confirmation links could not be read from selfbase.mail_log).
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect } from 'vitest'
import type { SupabaseClient } from '../../client/src/index.ts'
import { client, env, hiddenPaths, http, kase, lit, mgmt, mgmtGet, mgmtHealth, mgmtKeys, sql, summary, waitFor } from './helpers.ts'

const prefix = `acc_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
const T = `${prefix}_notes`
const PUB = `${prefix}_pub`
const PRIV = `${prefix}_priv`
const POLICIES = ['own', 'pub insert', 'pub select', 'priv insert', 'priv select'].map((p) => `${prefix} ${p}`)
const PASSWORD = `acc-${randomBytes(12).toString('base64url')}`
const email = (who: string) => `${prefix}.${who}@example.test`

let aborted: string | undefined
let A: SupabaseClient
let B: SupabaseClient
const uploaded: [bucket: string, path: string][] = []

/** Signs up, follows the confirmation link from selfbase.mail_log and signs in. */
async function signUpConfirmed(address: string): Promise<SupabaseClient> {
  const sb = client()
  const up = await sb.auth.signUp({ email: address, password: PASSWORD })
  expect(up.error).toBeNull()
  expect(up.data.session, 'sign-up waits for the confirmation').toBeNull()
  const html = await waitFor('the confirmation mail', async () => (await sql(
    `select html from selfbase.mail_log where to_email = ${lit(address)} and position('type=signup' in html) > 0 order by id desc limit 1`))[0]?.html as string)
  const link = new URL(/href="([^"]+)"/.exec(html)![1].replaceAll('&amp;', '&'))
  expect(link.hostname).toBe(new URL(env.url).hostname)
  // the link names the public port; SELFBASE_URL may carry another one (a local stack)
  const res = await fetch(new URL(link.pathname + link.search, env.url), { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toContain('#access_token=')
  const r = await sb.auth.signInWithPassword({ email: address, password: PASSWORD })
  expect(r.error).toBeNull()
  return sb
}

describe.skipIf(env.mode !== 'full')('full', () => {
  beforeAll(async () => {
    if (!/^acc_[a-z0-9]+$/.test(prefix)) throw new Error('bad run prefix')
    if (!env.service) throw new Error('SELFBASE_SERVICE_KEY is required in full mode')
    // before any write: the project must keep its mails in selfbase.mail_log
    const p = await mgmt('GET', `/platform/projects/${env.ref}`)
    if (p.status !== 200) throw new Error(`GET /platform/projects/${env.ref} -> ${p.status}`)
    if (p.json.smtp_configured !== false) {
      aborted = `smtp_configured is ${p.json.smtp_configured}: full mode needs a project without SMTP; nothing was written`
      throw new Error(aborted)
    }
    await sql(`
      create table public."${T}" (id uuid primary key default gen_random_uuid(), owner uuid not null default auth.uid(), body text);
      alter table public."${T}" enable row level security;
      create policy "${POLICIES[0]}" on public."${T}" for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
      select selfbase.enable_realtime('public."${T}"'::regclass);
      insert into storage.buckets (id, name, public) values (${lit(PUB)}, ${lit(PUB)}, true), (${lit(PRIV)}, ${lit(PRIV)}, false);
      create policy "${POLICIES[1]}" on storage.objects for insert to authenticated with check (bucket_id = ${lit(PUB)});
      create policy "${POLICIES[2]}" on storage.objects for select to authenticated using (bucket_id = ${lit(PUB)});
      create policy "${POLICIES[3]}" on storage.objects for insert to authenticated with check (bucket_id = ${lit(PRIV)} and owner = auth.uid());
      create policy "${POLICIES[4]}" on storage.objects for select to authenticated using (bucket_id = ${lit(PRIV)} and owner = auth.uid());
      notify pgrst, 'reload schema';`)
    const svc = client(env.service)
    await waitFor('PostgREST to see the table', async () => !(await svc.from(T as never).select('id').limit(1)).error)
  })

  afterAll(async () => {
    try {
      if (aborted) return
      await A?.removeAllChannels()
      await B?.removeAllChannels()
      // through the storage API, so the files go too; then the rows SQL made
      const svc = client(env.service)
      for (const [bucket, path] of uploaded) await svc.storage.from(bucket).remove([path])
      await sql(`
        drop table if exists public."${T}";
        ${POLICIES.slice(1).map((p) => `drop policy if exists "${p}" on storage.objects;`).join('\n')}
        delete from storage.objects where bucket_id in (${lit(PUB)}, ${lit(PRIV)});
        delete from storage.buckets where id in (${lit(PUB)}, ${lit(PRIV)});
        delete from auth.users where starts_with(email, ${lit(prefix)});
        delete from selfbase.mail_log where starts_with(to_email, ${lit(prefix)});`)
    } finally {
      summary({ prefix, ...(aborted ? { aborted } : {}) })
    }
  })

  kase('auth: sign-up, mailed confirmation link, verify, sign-in', async () => {
    A = await signUpConfirmed(email('a'))
    B = await signUpConfirmed(email('b'))
    expect((await A.auth.getUser()).data.user?.email).toBe(email('a'))
  })

  kase('auth: refresh rotates the token; reuse of a spent one is refused', async () => {
    const sb = client()
    expect((await sb.auth.signInWithPassword({ email: email('a'), password: PASSWORD })).error).toBeNull()
    const old = (await sb.auth.getSession()).data.session!.refresh_token
    const r1 = await sb.auth.refreshSession()
    expect(r1.error).toBeNull()
    expect(r1.data.session!.refresh_token !== old, 'a new refresh token').toBe(true)
    // two generations old: refused even inside the server's reuse interval
    expect((await client().auth.refreshSession({ refresh_token: r1.data.session!.refresh_token })).error).toBeNull()
    const reuse = await client().auth.refreshSession({ refresh_token: old })
    expect(reuse.error?.status).toBe(400)
    expect(reuse.error?.code).toBe('refresh_token_already_used')
  })

  kase('rls: the owner sees its own rows, another user none', async () => {
    expect((await A.from(T as never).insert({ body: 'a-row' } as never)).error).toBeNull()
    expect((await A.from(T as never).select('body')).data).toEqual([{ body: 'a-row' }])
    expect((await B.from(T as never).select('body')).data).toEqual([])
  })

  kase('storage: upload, public read, private read refused for another user, signed URL', async () => {
    const pub = `${prefix}/hello.txt`
    expect((await A.storage.from(PUB).upload(pub, new Blob(['hello'], { type: 'text/plain' }))).error).toBeNull()
    uploaded.push([PUB, pub])
    const res = await fetch(A.storage.from(PUB).getPublicUrl(pub).data.publicUrl)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')

    const priv = `${prefix}/secret.txt`
    expect((await A.storage.from(PRIV).upload(priv, new Blob(['gizli'], { type: 'text/plain' }))).error).toBeNull()
    uploaded.push([PRIV, priv])
    expect((await fetch(A.storage.from(PRIV).getPublicUrl(priv).data.publicUrl)).ok, 'no public read of a private bucket').toBe(false)
    expect((await B.storage.from(PRIV).download(priv)).error, 'another user cannot read it').not.toBeNull()
    expect((await B.storage.from(PRIV).createSignedUrl(priv, 60)).error, 'nor sign it').not.toBeNull()
    const signed = await A.storage.from(PRIV).createSignedUrl(priv, 60)
    expect(signed.error).toBeNull()
    const s = await fetch(signed.data!.signedUrl)
    expect(s.status).toBe(200)
    expect(await s.text()).toBe('gizli')
  })

  kase('realtime: an INSERT reaches the allowed subscriber and not the other', async () => {
    const got = { a: [] as string[], b: [] as string[] }
    let subscribed = 0
    for (const [who, sb] of [['a', A], ['b', B]] as const) {
      sb.channel(`${prefix}-${who}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: T }, (p) => void got[who].push((p.new as { body: string }).body))
        .subscribe((s) => s === 'SUBSCRIBED' && subscribed++)
    }
    await waitFor('both subscriptions', async () => subscribed === 2)
    expect((await A.from(T as never).insert({ body: 'only-a' } as never)).error).toBeNull()
    await waitFor('a receives its row', async () => got.a.includes('only-a'))
    // b's own row afterwards proves b's channel is live; a's row must not have come before it
    expect((await B.from(T as never).insert({ body: 'only-b' } as never)).error).toBeNull()
    await waitFor('b receives its row', async () => got.b.includes('only-b'))
    expect(got).toEqual({ a: ['only-a'], b: ['only-b'] })
    await A.removeAllChannels()
    await B.removeAllChannels()
  })

  kase('functions: an unknown function answers 404', async () => {
    const res = await http(`/functions/v1/${prefix.replaceAll('_', '-')}-missing`, { method: 'POST', headers: { apikey: env.anon, authorization: `Bearer ${env.anon}` } })
    expect(res.status).toBe(404)
  })

  kase('the admin and panel paths are not on the project host', hiddenPaths)
  kase('management: get project', mgmtGet)
  kase('management: services health', mgmtHealth)
  kase('management: api-keys, service_role masked', mgmtKeys)

  kase('management: pause answers 540, restore 200', async () => {
    expect((await mgmt('POST', `/v1/projects/${env.ref}/pause`)).status).toBe(200)
    const paused = await waitFor('540', async () => {
      const r = await http('/health', {}, 5000).catch(() => null)
      return r?.status === 540 && r
    }, 120_000, 1000)
    expect(await paused.json()).toEqual({ message: 'project is not running' })
    // restore is refused until the pause job has marked the project INACTIVE
    await waitFor('restore accepted', async () => (await mgmt('POST', `/v1/projects/${env.ref}/restore`)).status === 200, 60_000, 1000)
    await waitFor('200 again', async () => (await http('/health', {}, 5000).catch(() => null))?.status === 200, 120_000, 1000)
    await waitFor('ACTIVE_HEALTHY', async () => (await mgmt('GET', `/v1/projects/${env.ref}`)).json?.status === 'ACTIVE_HEALTHY', 120_000, 1000)
  })
})
