// Brief Step 2 scenarios against a running selfbase (core + db + rest [+ fn]). Skipped unless configured:
//   SELFBASE_URL, SELFBASE_ANON_KEY, SELFBASE_SERVICE_KEY  - the stack under test
//   TEST_COMPOSE_PROJECT (+ optional TEST_COMPOSE_FILE)    - compose project whose `db` service receives setup SQL via psql
//   SELFBASE_FAILING_FUNCTION                              - optional: a deployed function that answers 500
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FunctionsHttpError, createClient, type AuthChangeEvent, type SupabaseClient } from '../src/index.ts'
import { psql, waitFor } from './helpers.ts'

const URL_ = process.env.SELFBASE_URL ?? ''
const ANON = process.env.SELFBASE_ANON_KEY ?? ''
const SERVICE = process.env.SELFBASE_SERVICE_KEY ?? ''
const enabled = Boolean(URL_ && ANON && SERVICE && process.env.TEST_COMPOSE_PROJECT)
const opts = { auth: { persistSession: false } }
const run = Date.now().toString(36)
const table = `t8_it_${run}`
const bucket = `t8-it-${run}`

/** Signs up (confirming the e-mail via SQL when AUTH_CONFIRM_EMAIL is on) and signs in. */
async function newUser(sb: SupabaseClient = createClient(URL_, ANON, opts)) {
  const email = `it-${Math.random().toString(36).slice(2)}@example.test`
  const up = await sb.auth.signUp({ email, password: 'secret123' })
  expect(up.error).toBeNull()
  if (!up.data.session) {
    psql(`update auth.users set email_confirmed_at = now() where email = '${email}';`)
    const r = await sb.auth.signInWithPassword({ email, password: 'secret123' })
    expect(r.error).toBeNull()
  }
  return sb
}

describe.skipIf(!enabled)('integration against a running selfbase', () => {
  beforeAll(async () => {
    psql(`
      create table public.${table} (id uuid primary key default gen_random_uuid(), owner uuid not null default auth.uid(), body text);
      alter table public.${table} enable row level security;
      create policy own on public.${table} for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
      select selfbase.enable_realtime('public.${table}');
      insert into storage.buckets (id, name, public) values ('${bucket}', '${bucket}', true);
      create policy "t8 ${run} insert" on storage.objects for insert to authenticated with check (bucket_id = '${bucket}');
      create policy "t8 ${run} select" on storage.objects for select to authenticated using (bucket_id = '${bucket}');
      notify pgrst, 'reload schema';
    `)
    const svc = createClient(URL_, SERVICE, opts)
    await waitFor(async () => !(await svc.from(table as never).select('id').limit(1)).error, 15_000)
  })
  afterAll(() => {
    psql(`
      drop table if exists public.${table};
      drop policy if exists "t8 ${run} insert" on storage.objects;
      drop policy if exists "t8 ${run} select" on storage.objects;
      delete from storage.objects where bucket_id = '${bucket}';
      delete from storage.buckets where id = '${bucket}';
    `)
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
    await vi.advanceTimersByTimeAsync((before.expires_at! * 1000 - Date.now()) - 59_000)
    await waitFor(() => events.includes('TOKEN_REFRESHED'), 5000)
    const after = (await sb.auth.getSession()).data.session!
    expect(after.access_token).not.toBe(before.access_token)
    expect((await sb.auth.getUser()).data.user?.id).toBe(before.user.id)
  })

  it('a refresh answered with 400 removes the session and emits SIGNED_OUT', async () => {
    const sb = await newUser()
    const events: AuthChangeEvent[] = []
    sb.auth.onAuthStateChange((e) => void events.push(e))
    const s = (await sb.auth.getSession()).data.session!
    // rotate the refresh token elsewhere, so this client's copy is spent
    expect((await createClient(URL_, ANON, opts).auth.refreshSession({ refresh_token: s.refresh_token })).error).toBeNull()
    const r = await sb.auth.refreshSession()
    expect(r.error?.status).toBe(400)
    await waitFor(() => events.includes('SIGNED_OUT'))
    expect((await sb.auth.getSession()).data.session).toBeNull()
  })

  it('storage upload → getPublicUrl answers 200 with the bytes', async () => {
    const sb = await newUser()
    const path = `p/${run}.txt`
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
})
