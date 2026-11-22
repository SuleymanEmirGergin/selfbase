import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type RealtimePostgresChangesPayload } from '../src/index.ts'
import { startFakeServer, type FakeServer } from './fake-server.ts'
import { ANON_KEY, waitFor } from './helpers.ts'

let fake: FakeServer
const opts = { auth: { persistSession: false, autoRefreshToken: false } }

beforeAll(async () => {
  fake = await startFakeServer()
})
afterAll(() => fake.close())

describe('realtime', () => {
  it('receives INSERTs, reconnects after the socket drops and keeps receiving', async () => {
    const sb = createClient(fake.url, ANON_KEY, opts)
    const got: RealtimePostgresChangesPayload<{ id: number; post_id: number }>[] = []
    const statuses: string[] = []
    sb.channel('comments-5')
      .on<{ id: number; post_id: number }>('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments', filter: 'post_id=eq.5' }, (p) => void got.push(p))
      .subscribe((s) => void statuses.push(s))
    await waitFor(() => statuses.includes('SUBSCRIBED'))
    expect(fake.rt.conns).toHaveLength(1)
    expect(fake.rt.conns[0].token).toBe(ANON_KEY)
    expect(fake.rt.conns[0].received[0]).toEqual({ type: 'subscribe', ref: '1', schema: 'public', table: 'comments', event: 'INSERT', filter: 'post_id=eq.5' })

    fake.rt.emit('comments', 'INSERT', { id: 1, post_id: 5 })
    fake.rt.emit('comments', 'INSERT', { id: 2, post_id: 6 })
    await waitFor(() => got.length === 1)
    expect(got[0]).toMatchObject({ eventType: 'INSERT', schema: 'public', table: 'comments', new: { id: 1, post_id: 5 }, old: {} })
    expect(typeof got[0].commit_timestamp).toBe('string')

    const first = fake.rt.conns[0]
    fake.rt.dropAll()
    await waitFor(() => fake.rt.conns.length === 1 && fake.rt.conns[0] !== first && fake.rt.conns[0].subs.size === 1, 5000)
    fake.rt.emit('comments', 'INSERT', { id: 3, post_id: 5 })
    await waitFor(() => got.length === 2)
    expect(got[1].new).toEqual({ id: 3, post_id: 5 })
    await sb.removeAllChannels()
  })

  it('subscribes with the session token and sends {type:"auth"} when the token changes', async () => {
    const sb = createClient(fake.url, ANON_KEY, opts)
    const { data } = await sb.auth.signUp({ email: `rt-${Date.now()}@example.test`, password: 'secret123' })
    let subscribed = false
    const ch = sb
      .channel('n')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => {})
      .subscribe((s) => (subscribed ||= s === 'SUBSCRIBED'))
    await waitFor(() => subscribed)
    const conn = fake.rt.conns.at(-1)!
    expect(conn.token).toBe(data.session!.access_token)
    const refreshed = await sb.auth.refreshSession()
    await waitFor(() => conn.received.some((m) => m.type === 'auth'))
    expect(conn.received.find((m) => m.type === 'auth')).toEqual({ type: 'auth', token: refreshed.data.session!.access_token })
    await sb.auth.signOut()
    await waitFor(() => conn.received.filter((m) => m.type === 'auth').length === 2)
    expect(conn.received.filter((m) => m.type === 'auth')[1]).toEqual({ type: 'auth', token: ANON_KEY })
    await sb.removeChannel(ch)
  })

  it('removeChannel unsubscribes and closes the socket when no channel is left; channel(name) reuses the topic', async () => {
    const sb = createClient(fake.url, ANON_KEY, opts)
    let closed = false
    const ch = sb
      .channel('x')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'a' }, () => {})
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'b' }, () => {})
      .subscribe((s) => (closed ||= s === 'CLOSED'))
    expect(sb.channel('x')).toBe(ch)
    expect(sb.getChannels()).toEqual([ch])
    await waitFor(() => fake.rt.conns.some((c) => c.subs.size === 2))
    const conn = fake.rt.conns.find((c) => c.subs.size === 2)!
    expect(await sb.removeChannel(ch)).toBe('ok')
    expect(closed).toBe(true)
    await waitFor(() => !fake.rt.conns.includes(conn))
    expect(conn.received.filter((m) => m.type === 'unsubscribe')).toHaveLength(2)
    expect(sb.getChannels()).toEqual([])
  })

  it('answers pings: heartbeat keeps the socket, a missing pong reconnects', async () => {
    const sb = createClient(fake.url, ANON_KEY, { ...opts, realtime: { heartbeatIntervalMs: 50 } })
    let ok = false
    sb.channel('hb')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hb' }, () => {})
      .subscribe((s) => (ok ||= s === 'SUBSCRIBED'))
    await waitFor(() => ok)
    const conn = fake.rt.conns.at(-1)!
    await waitFor(() => conn.received.filter((m) => m.type === 'ping').length >= 3)
    expect(fake.rt.conns.includes(conn)).toBe(true)
    fake.settings.pong = false
    await waitFor(() => !fake.rt.conns.includes(conn), 5000)
    fake.settings.pong = true
    await waitFor(() => fake.rt.conns.some((c) => c !== conn && c.subs.size === 1), 5000)
    await sb.removeAllChannels()
  })

  it('a channel that TIMED_OUT does not report SUBSCRIBED on a late ack; a new subscribe() does', async () => {
    fake.settings.ack = false
    const sb = createClient(fake.url, ANON_KEY, opts)
    const statuses: string[] = []
    const ch = sb
      .channel('slow')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'slow' }, () => {})
      .subscribe((s) => void statuses.push(s), 200)
    await waitFor(() => statuses.includes('TIMED_OUT'))
    fake.rt.flushAcks()
    await new Promise((r) => setTimeout(r, 200))
    expect(statuses).toEqual(['TIMED_OUT'])
    fake.settings.ack = true
    ch.subscribe((s) => void statuses.push(s))
    await waitFor(() => statuses.includes('SUBSCRIBED'))
    expect(statuses).toEqual(['TIMED_OUT', 'SUBSCRIBED'])
    await sb.removeAllChannels()
  })

  it('close code 1013 (try again later) waits the longest backoff step before reconnecting', async () => {
    const sb = createClient(fake.url, ANON_KEY, opts)
    let ok = false
    sb.channel('busy')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'busy' }, () => {})
      .subscribe((s) => (ok ||= s === 'SUBSCRIBED'))
    await waitFor(() => ok)
    const first = fake.rt.conns.at(-1)!
    fake.rt.dropAll(1013)
    await waitFor(() => !fake.rt.conns.includes(first))
    // a normal drop reconnects after 1-1.3 s; 1013 jumps to the 10 s step
    await new Promise((r) => setTimeout(r, 3000))
    expect(fake.rt.conns).toHaveLength(0)
    await sb.removeAllChannels()
  })
})
