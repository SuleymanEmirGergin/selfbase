// .from()/.rpc()/.schema() against the real test PostgREST (fake auth issues JWTs signed with the test secret).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgrestError, createClient } from '../src/index.ts'
import { startFakeServer, type FakeServer } from './fake-server.ts'
import { ANON_KEY, REST_URL, SERVICE_KEY, psql, waitFor } from './helpers.ts'

let fake: FakeServer
const opts = { auth: { persistSession: false, autoRefreshToken: false } }

beforeAll(async () => {
  psql(`
    drop table if exists public.t8_notes;
    create table public.t8_notes (id uuid primary key default gen_random_uuid(), owner uuid not null default auth.uid(), body text);
    alter table public.t8_notes enable row level security;
    create policy own on public.t8_notes for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
    create or replace function public.t8_add(a int, b int) returns int language sql as $$ select a + b $$;
    notify pgrst, 'reload schema';
  `)
  await waitFor(async () => (await fetch(`${REST_URL}/t8_notes`, { headers: { Authorization: `Bearer ${ANON_KEY}` } })).ok, 15_000)
  fake = await startFakeServer()
})
afterAll(async () => {
  await fake.close()
  psql('drop table if exists public.t8_notes; drop function if exists public.t8_add(int, int);')
})

describe('postgrest', () => {
  it('signUp → signIn → from().select() returns only the RLS-visible row', async () => {
    const a = createClient(fake.url, ANON_KEY, opts)
    const b = createClient(fake.url, ANON_KEY, opts)
    await a.auth.signUp({ email: `a-${Date.now()}@example.test`, password: 'secret123' })
    const bEmail = `b-${Date.now()}@example.test`
    await b.auth.signUp({ email: bEmail, password: 'secret123' })
    await b.auth.signOut()
    await b.auth.signInWithPassword({ email: bEmail, password: 'secret123' })

    const ins = await a.from('t8_notes').insert({ body: 'mine' }).select('body').single()
    expect(ins.error).toBeNull()
    expect(ins.data).toEqual({ body: 'mine' })
    await b.from('t8_notes').insert({ body: 'theirs' })

    const mine = await a.from('t8_notes').select('body')
    expect(mine.error).toBeNull()
    expect(mine.data).toEqual([{ body: 'mine' }])
    const theirs = await b.from('t8_notes').select('body').eq('body', 'mine')
    expect(theirs.data).toEqual([])

    const anon = await createClient(fake.url, ANON_KEY, opts).from('t8_notes').select('*')
    expect(anon).toMatchObject({ data: [], error: null })

    const bad = await a.from('t8_nope' as never).select('*')
    // postgrest-js (and so supabase-js) returns a plain error object unless throwOnError() is used
    expect(bad.error).toMatchObject({ code: 'PGRST205' })
    const thrown = await a.from('t8_nope' as never).select('*').throwOnError().then(() => null, (e) => e)
    expect(thrown).toBeInstanceOf(PostgrestError)
  })

  it('sends apikey and Authorization: Bearer <session ?? key>', async () => {
    const sb = createClient(fake.url, ANON_KEY, opts)
    await sb.from('t8_notes').select('id').limit(1)
    let req = fake.requests.at(-1)!
    expect(req.headers.apikey).toBe(ANON_KEY)
    expect(req.headers.authorization).toBe(`Bearer ${ANON_KEY}`)
    const { data } = await sb.auth.signUp({ email: `h-${Date.now()}@example.test`, password: 'secret123' })
    await sb.from('t8_notes').select('id').limit(1)
    req = fake.requests.at(-1)!
    expect(req.headers.authorization).toBe(`Bearer ${data.session!.access_token}`)
  })

  it('a global Authorization header wins over the session (edge function pattern)', async () => {
    const sb = createClient(fake.url, ANON_KEY, { ...opts, global: { headers: { Authorization: `Bearer ${SERVICE_KEY}` } } })
    const { data, error } = await sb.from('t8_notes').select('body')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(2)
  })

  it('rpc() and schema() work', async () => {
    const sb = createClient(fake.url, SERVICE_KEY, opts)
    expect(await sb.rpc('t8_add', { a: 2, b: 3 })).toMatchObject({ data: 5, error: null })
    const notes = await sb.schema('public').from('t8_notes').select('id')
    expect(notes.error).toBeNull()
    expect(fake.requests.at(-1)!.headers['accept-profile']).toBe('public')
    // selfbase exposes only public over REST (like Supabase); storage goes through /storage/v1
    const buckets = await sb.schema('storage').from('buckets').select('id')
    expect(buckets.error).toMatchObject({ code: 'PGRST106' })
  })

  it('global fetch option is used', async () => {
    const seen: string[] = []
    const sb = createClient(fake.url, ANON_KEY, { ...opts, global: { fetch: (input, init) => (seen.push(String(input)), fetch(input, init)) } })
    await sb.rpc('t8_add', { a: 1, b: 1 })
    expect(seen).toEqual([`${fake.url}/rest/v1/rpc/t8_add`])
  })
})
