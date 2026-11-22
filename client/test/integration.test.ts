// Brief Step 2 scenarios against a running selfbase (core + db + rest [+ fn]). The whole file is skipped unless
// ALL four required variables are set (see client/README.md):
//   SELFBASE_URL          required  public origin of core, e.g. http://localhost:8080
//   SELFBASE_ANON_KEY     required  the stack's ANON_KEY
//   SELFBASE_SERVICE_KEY  required  the stack's SERVICE_ROLE_KEY (only used to wait for the schema reload)
//   TEST_COMPOSE_PROJECT  required  compose project (`docker compose -p`) whose `db` service gets the setup SQL via psql:
//                                   an RLS table with realtime, a public and a private bucket with policies. The stack must
//                                   run with AUTH_CONFIRM_EMAIL=true and SMTP_HOST empty (links are read from selfbase.mail_log).
//                                   DDL and policies have no public API, so this cannot be done over HTTP.
//   TEST_COMPOSE_FILE     optional  compose file for that project (default ../compose.test.yml, relative to client/)
//   SELFBASE_FAILING_FUNCTION optional  name of a deployed function that answers 500 (enables the functions case)
//   SELFBASE_COUNT_FUNCTION   optional  name of a deployed verify_jwt function that answers { count, user }: the row
//                                       count of body.table (service role) and the caller's user id (enables that case)
// SQL values travel as psql variables (:'x' / :"x"), never spliced into the SQL text.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FunctionsHttpError, createClient, type AuthChangeEvent, type SupabaseClient } from '../src/index.ts'
import { installBrowser, psql, waitFor } from './helpers.ts'

const URL_ = process.env.SELFBASE_URL ?? ''
const ANON = process.env.SELFBASE_ANON_KEY ?? ''
const SERVICE = process.env.SELFBASE_SERVICE_KEY ?? ''
const enabled = Boolean(URL_ && ANON && SERVICE && process.env.TEST_COMPOSE_PROJECT)
const opts = { auth: { persistSession: false } }
const run = Date.now().toString(36)
const table = `t8_it_${run}`
const bucket = `t8-it-${run}`
const vars = { tbl: table, tbl_reg: `public.${table}`, bucket, pol_ins: `t8 ${run} insert`, pol_sel: `t8 ${run} select`,
  priv: `t8-it-priv-${run}`, pol_pins: `t8 ${run} priv insert`, pol_psel: `t8 ${run} priv select` }

/** Signs up (confirming the e-mail via SQL when AUTH_CONFIRM_EMAIL is on) and signs in. */
async function newUser(sb: SupabaseClient = createClient(URL_, ANON, opts)) {
  const email = `it-${Math.random().toString(36).slice(2)}@example.test`
  const up = await sb.auth.signUp({ email, password: 'secret123' })
  expect(up.error).toBeNull()
  if (!up.data.session) {
    psql(`update auth.users set email_confirmed_at = now() where email = :'email';`, { email })
    const r = await sb.auth.signInWithPassword({ email, password: 'secret123' })
    expect(r.error).toBeNull()
  }
  return sb
}

/** The newest link of that type mailed to email (mail_log HTML, &amp; unescaped). */
async function mailedLink(email: string, type: string): Promise<string> {
  let html = ''
  await waitFor(() => {
    html = psql(
      `select html from selfbase.mail_log where to_email = :'email' and position(:'needle' in html) > 0 order by id desc limit 1;`,
      { email, needle: `type=${type}` },
    ).trim()
    return html !== ''
  }, 5000)
  return html.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&')
}

/** Follows a /verify link like the browser would, up to the redirect; returns the Location. */
async function verifyRedirect(link: string): Promise<string> {
  const res = await fetch(link, { redirect: 'manual' })
  expect(res.status).toBe(302)
  return res.headers.get('location')!
}

/** A browser client opened at href (the redirect target), and the auth events it emits. */
function browserClientAt(href: string) {
  const browser = installBrowser(href)
  const sb = createClient(URL_, ANON)
  const events: AuthChangeEvent[] = []
  sb.auth.onAuthStateChange((e) => void events.push(e))
  return { browser, sb, events }
}

describe.skipIf(!enabled)('integration against a running selfbase', () => {
  beforeAll(async () => {
    psql(
      `
      create table public.:"tbl" (id uuid primary key default gen_random_uuid(), owner uuid not null default auth.uid(), body text);
      alter table public.:"tbl" enable row level security;
      create policy own on public.:"tbl" for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
      select selfbase.enable_realtime(:'tbl_reg'::regclass);
      insert into storage.buckets (id, name, public) values (:'bucket', :'bucket', true);
      create policy :"pol_ins" on storage.objects for insert to authenticated with check (bucket_id = :'bucket');
      create policy :"pol_sel" on storage.objects for select to authenticated using (bucket_id = :'bucket');
      insert into storage.buckets (id, name, public) values (:'priv', :'priv', false);
      create policy :"pol_pins" on storage.objects for insert to authenticated with check (bucket_id = :'priv' and owner = auth.uid());
      create policy :"pol_psel" on storage.objects for select to authenticated using (bucket_id = :'priv' and owner = auth.uid());
      notify pgrst, 'reload schema';
    `,
      vars,
    )
    const svc = createClient(URL_, SERVICE, opts)
    await waitFor(async () => !(await svc.from(table as never).select('id').limit(1)).error, 15_000)
  })
  afterAll(() => {
    psql(
      `
      drop table if exists public.:"tbl";
      drop policy if exists :"pol_ins" on storage.objects;
      drop policy if exists :"pol_sel" on storage.objects;
      drop policy if exists :"pol_pins" on storage.objects;
      drop policy if exists :"pol_psel" on storage.objects;
      delete from storage.objects where bucket_id in (:'bucket', :'priv');
      delete from storage.buckets where id in (:'bucket', :'priv');
    `,
      vars,
    )
  })
  afterEach(() => vi.useRealTimers())

  it('signUp → signIn → from(t).select() returns the RLS row of that user only', async () => {
    const a = await newUser()
    const b = await newUser()
    expect((await a.from(table as never).insert({ body: 'a-row' } as never)).error).toBeNull()
    expect((await a.from(table as never).select('body')).data).toEqual([{ body: 'a-row' }])
    expect((await b.from(table as never).select('body')).data).toEqual([])
  })

  it('onAuthStateChange order is INITIAL_SESSION, SIGNED_IN, SIGNED_OUT', async () => {
    const sb = createClient(URL_, ANON, opts)
    const events: AuthChangeEvent[] = []
    sb.auth.onAuthStateChange((e) => void events.push(e))
    await newUser(sb)
    await sb.auth.signOut()
    expect(events.filter((e) => e !== 'TOKEN_REFRESHED')).toEqual(['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'])
  })

  it('a token about to expire refreshes by itself (fake time) and emits TOKEN_REFRESHED', async () => {
    // fake timers first: the refresh timer is armed when the session is saved
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sb = await newUser()
    const events: AuthChangeEvent[] = []
    sb.auth.onAuthStateChange((e) => void events.push(e))
    const before = (await sb.auth.getSession()).data.session!
    // the timer fires 60 s before expiry plus up to 10 s of jitter, so 49 s before expiry is past it
    await vi.advanceTimersByTimeAsync((before.expires_at! * 1000 - Date.now()) - 49_000)
    await waitFor(() => events.includes('TOKEN_REFRESHED'), 5000)
    const after = (await sb.auth.getSession()).data.session!
    // an access token re-signed within the same second is byte-identical (same claims, iat, exp); the refresh token is new
    expect(after.refresh_token).not.toBe(before.refresh_token)
    expect((await sb.auth.getUser()).data.user?.id).toBe(before.user.id)
  })

  it('a refresh answered with 400 removes the session and emits SIGNED_OUT', async () => {
    const sb = await newUser()
    const events: AuthChangeEvent[] = []
    sb.auth.onAuthStateChange((e) => void events.push(e))
    const s = (await sb.auth.getSession()).data.session!
    // rotate the refresh token elsewhere twice, so this client's copy is two generations old: spent even inside the
    // server's reuse interval (AUTH_REFRESH_REUSE_INTERVAL)
    const once = await createClient(URL_, ANON, opts).auth.refreshSession({ refresh_token: s.refresh_token })
    expect(once.error).toBeNull()
    expect((await createClient(URL_, ANON, opts).auth.refreshSession({ refresh_token: once.data.session!.refresh_token })).error).toBeNull()
    const r = await sb.auth.refreshSession()
    expect(r.error?.status).toBe(400)
    await waitFor(() => events.includes('SIGNED_OUT'))
    expect((await sb.auth.getSession()).data.session).toBeNull()
  })

  it('storage upload → getPublicUrl answers 200 with the bytes', async () => {
    const sb = await newUser()
    const path = `p/öğrenci kartı ${run}.txt` // space + Turkish characters: signed URLs must not double-encode
    const up = await sb.storage.from(bucket).upload(path, new Blob(['hello'], { type: 'text/plain' }))
    expect(up.error).toBeNull()
    const res = await fetch(sb.storage.from(bucket).getPublicUrl(path).data.publicUrl)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
    const signed = await sb.storage.from(bucket).createSignedUrl(path, 60)
    expect((await fetch(signed.data!.signedUrl)).status).toBe(200)
  })

  it('a channel receives the INSERT, reconnects after the WS closes and receives the next INSERT', async () => {
    const sb = await newUser()
    const got: string[] = []
    let subscribed = 0
    sb.channel(`it-${run}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table }, (p) => void got.push((p.new as { body: string }).body))
      .subscribe((s) => s === 'SUBSCRIBED' && subscribed++)
    await waitFor(() => subscribed === 1, 5000)
    await sb.from(table as never).insert({ body: 'one' } as never)
    await waitFor(() => got.includes('one'), 5000)
    ;(sb.realtime as any).ws.close()
    await waitFor(() => subscribed === 2, 10_000)
    await sb.from(table as never).insert({ body: 'two' } as never)
    await waitFor(() => got.includes('two'), 5000)
    await sb.removeAllChannels()
  })

  it.skipIf(!process.env.SELFBASE_FAILING_FUNCTION)('functions.invoke on a 500 gives FunctionsHttpError', async () => {
    const sb = await newUser()
    const { error } = await sb.functions.invoke(process.env.SELFBASE_FAILING_FUNCTION!, { body: {} })
    expect(error).toBeInstanceOf(FunctionsHttpError)
    expect(error!.context.status).toBe(500)
  })

  it('signUp with confirmation → mailed link → /verify redirect → the URL hash yields a session', async () => {
    const email = `it-c-${Math.random().toString(36).slice(2)}@example.test`
    const redirect = `${URL_}/welcome`
    const up = await createClient(URL_, ANON, opts).auth.signUp({ email, password: 'secret123', options: { emailRedirectTo: redirect } })
    expect(up.error).toBeNull()
    expect(up.data.session).toBeNull()
    const location = await verifyRedirect(await mailedLink(email, 'signup'))
    expect(location.startsWith(`${redirect}#access_token=`)).toBe(true)
    const { browser, sb, events } = browserClientAt(location)
    try {
      await waitFor(() => events.includes('SIGNED_IN'), 5000)
      const { session } = (await sb.auth.getSession()).data
      expect(session?.user.email).toBe(email)
      expect(session?.user.email_confirmed_at).toBeTruthy()
      expect(browser.location.hash).toBe('')
      expect((await sb.auth.getUser()).data.user?.id).toBe(session!.user.id)
    } finally {
      browser.uninstall()
    }
  })

  it('a 6-character password is accepted (minimum length 6, docs/auth-settings.md)', async () => {
    const email = `it-p-${Math.random().toString(36).slice(2)}@example.test`
    expect((await createClient(URL_, ANON, opts).auth.signUp({ email, password: 'abc123' })).error).toBeNull()
  })

  it('recovery link → PASSWORD_RECOVERY → updateUser({ password }) → sign in with the new password', async () => {
    const email = `it-r-${Math.random().toString(36).slice(2)}@example.test`
    expect((await createClient(URL_, ANON, opts).auth.signUp({ email, password: 'secret123' })).error).toBeNull()
    // confirmed by SQL; clearing the send time frees the one-mail-per-AUTH_EMAIL_INTERVAL slot the signup mail took
    psql(`update auth.users set email_confirmed_at = now(), confirmation_sent_at = null where email = :'email';`, { email })
    const redirect = `${URL_}/reset-password`
    expect((await createClient(URL_, ANON, opts).auth.resetPasswordForEmail(email, { redirectTo: redirect })).error).toBeNull()
    const location = await verifyRedirect(await mailedLink(email, 'recovery'))
    expect(location.startsWith(`${redirect}#`)).toBe(true)
    const { browser, sb, events } = browserClientAt(location)
    try {
      await waitFor(() => events.includes('PASSWORD_RECOVERY'), 5000)
      expect(events).not.toContain('SIGNED_IN')
      expect((await sb.auth.updateUser({ password: 'newsecret456' })).error).toBeNull()
    } finally {
      browser.uninstall()
    }
    const fresh = createClient(URL_, ANON, opts).auth
    expect((await fresh.signInWithPassword({ email, password: 'secret123' })).error?.status).toBe(400)
    expect((await fresh.signInWithPassword({ email, password: 'newsecret456' })).error).toBeNull()
  })

  it('refreshSession rotates the refresh token; a retry inside the reuse interval gets the same one; older reuse ends the session', async () => {
    const sb = await newUser()
    const old = (await sb.auth.getSession()).data.session!
    const r = await sb.auth.refreshSession()
    expect(r.error).toBeNull()
    expect(r.data.session!.refresh_token).not.toBe(old.refresh_token)
    // a retry right after (lost response, second tab) is answered with the same new session
    const retry = await createClient(URL_, ANON, opts).auth.refreshSession({ refresh_token: old.refresh_token })
    expect(retry.error).toBeNull()
    expect(retry.data.session!.refresh_token).toBe(r.data.session!.refresh_token)
    const r2 = await createClient(URL_, ANON, opts).auth.refreshSession({ refresh_token: r.data.session!.refresh_token })
    expect(r2.error).toBeNull()
    // the first token is now two generations old: reuse is rejected
    const reuse = await createClient(URL_, ANON, opts).auth.refreshSession({ refresh_token: old.refresh_token })
    expect(reuse.error?.status).toBe(400)
    expect(reuse.error?.code).toBe('refresh_token_already_used')
    // reuse looks like theft: the newest token of that session is revoked too
    const next = await createClient(URL_, ANON, opts).auth.refreshSession({ refresh_token: r2.data.session!.refresh_token })
    expect(next.error?.status).toBe(400)
  })

  it('private bucket with an owner policy: upload, download and signed URL for the owner; another user is denied', async () => {
    const a = await newUser()
    const b = await newUser()
    const path = `docs/öğrenci belgesi ${run}.txt`
    const up = await a.storage.from(vars.priv).upload(path, new Blob(['gizli'], { type: 'text/plain' }))
    expect(up.error).toBeNull()
    const down = await a.storage.from(vars.priv).download(path)
    expect(down.error).toBeNull()
    expect(await down.data!.text()).toBe('gizli')
    const signed = await a.storage.from(vars.priv).createSignedUrl(path, 60)
    expect(signed.error).toBeNull()
    const res = await fetch(signed.data!.signedUrl)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('gizli')
    expect((await fetch(a.storage.from(vars.priv).getPublicUrl(path).data.publicUrl)).ok).toBe(false)
    expect((await b.storage.from(vars.priv).download(path)).error).not.toBeNull()
    expect((await b.storage.from(vars.priv).createSignedUrl(path, 60)).error).not.toBeNull()
    expect((await b.storage.from(vars.priv).list('docs')).data).toEqual([])
  })

  it('a realtime INSERT reaches the row owner and not another user', async () => {
    const a = await newUser()
    const b = await newUser()
    const got = { a: [] as string[], b: [] as string[] }
    let subscribed = 0
    for (const [who, sb] of [['a', a], ['b', b]] as const) {
      sb.channel(`it-own-${who}-${run}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table }, (p) => void got[who].push((p.new as { body: string }).body))
        .subscribe((s) => s === 'SUBSCRIBED' && subscribed++)
    }
    await waitFor(() => subscribed === 2, 5000)
    expect((await a.from(table as never).insert({ body: 'only-a' } as never)).error).toBeNull()
    await waitFor(() => got.a.includes('only-a'), 5000)
    // b's own insert afterwards proves b's channel is live; it must arrive without a's row before it
    expect((await b.from(table as never).insert({ body: 'only-b' } as never)).error).toBeNull()
    await waitFor(() => got.b.includes('only-b'), 5000)
    expect(got.b).toEqual(['only-b'])
    expect(got.a).toEqual(['only-a'])
    await a.removeAllChannels()
    await b.removeAllChannels()
  })

  it.skipIf(!process.env.SELFBASE_COUNT_FUNCTION)('functions.invoke of a verify_jwt function with a session', async () => {
    const sb = await newUser()
    await sb.from(table as never).insert({ body: 'fn' } as never)
    const total = Number(psql(`select count(*) from public.:"tbl";`, vars))
    const user = (await sb.auth.getUser()).data.user!
    const { data, error } = await sb.functions.invoke(process.env.SELFBASE_COUNT_FUNCTION!, { body: { table } })
    expect(error).toBeNull()
    expect(data).toMatchObject({ count: total, user: user.id })
    const res = await fetch(`${URL_}/functions/v1/${process.env.SELFBASE_COUNT_FUNCTION}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-jwt' },
    })
    expect(res.status).toBe(401)
  })
})
