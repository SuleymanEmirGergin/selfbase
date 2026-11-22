import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { connect as tcpConnect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { pool } from '../src/db.ts'
import { sign } from '../src/jwt.ts'
import { attachRealtime, stopRealtime } from '../src/realtime/index.ts'
import { setStatementTimeout } from '../src/realtime/hub.ts'

const server = createServer()
let base = ''
const sockets: WebSocket[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Msg = Record<string, any>
/** Opens a socket and records every message it receives. */
async function connect(token: string) {
  const ws = new WebSocket(`${base}/realtime/v1?token=${encodeURIComponent(token)}`)
  sockets.push(ws)
  const msgs: Msg[] = []
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))))
  await new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej)))
  const waitFor = async (pred: (m: Msg) => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
      const m = msgs.find(pred)
      if (m) return m
    }
    throw new Error('timed out; got ' + JSON.stringify(msgs))
  }
  const subscribe = async (sub: Msg) => {
    ws.send(JSON.stringify({ type: 'subscribe', schema: 'public', ...sub }))
    await waitFor((m) => m.ref === sub.ref && (m.type === 'subscribed' || m.type === 'error'))
  }
  return { ws, msgs, waitFor, subscribe }
}

const user = (sub: string, exp = 60) => sign({ sub, role: 'authenticated' }, exp)

beforeAll(async () => {
  await pool.query(`
    drop table if exists public.rt_msgs;
    create table public.rt_msgs (id bigserial primary key, recipient uuid not null, post_id int, body text);
    alter table public.rt_msgs enable row level security;
    create policy rt_recipient on public.rt_msgs for select using (recipient = auth.uid());
    select selfbase.enable_realtime('public.rt_msgs');
    drop table if exists public.rt_slow;
    create or replace function public.rt_sleepy() returns boolean language sql as $$ select pg_sleep(10); select true $$;
    create table public.rt_slow (id bigserial primary key);
    alter table public.rt_slow enable row level security;
    create policy rt_slow_read on public.rt_slow for select using (public.rt_sleepy());
    select selfbase.enable_realtime('public.rt_slow');
    drop table if exists public.rt_lock;
    create table public.rt_lock (id bigserial primary key);
  `)
  await attachRealtime(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  sockets.forEach((s) => s.terminate())
  await stopRealtime()
  await new Promise((r) => server.close(r))
  await pool.query('drop table if exists public.rt_msgs, public.rt_noid, public.rt_slow, public.rt_lock; drop function if exists public.rt_sleepy()')
})

describe('realtime', () => {
  it('rejects a connection with an invalid token', async () => {
    await expect(connect('not-a-jwt')).rejects.toThrow(/401/)
  })

  it('answers ping and errors on a bad filter', async () => {
    const a = await connect(await user(randomUUID()))
    a.ws.send(JSON.stringify({ type: 'ping' }))
    await a.waitFor((m) => m.type === 'pong')
    await a.subscribe({ ref: 'bad', table: 'rt_msgs', event: 'INSERT', filter: 'post_id=gt.5' })
    expect(a.msgs.find((m) => m.ref === 'bad')).toMatchObject({ type: 'error' })
  })

  it('delivers an INSERT only to the subscriber RLS lets see it', async () => {
    const A = randomUUID()
    const a = await connect(await user(A))
    const b = await connect(await user(randomUUID()))
    await a.subscribe({ ref: 'a1', table: 'rt_msgs', event: 'INSERT' })
    await b.subscribe({ ref: 'b1', table: 'rt_msgs', event: '*' })
    const { rows } = await pool.query(`insert into public.rt_msgs (recipient, body) values ($1, 'hi') returning id`, [A])
    const change = await a.waitFor((m) => m.type === 'change')
    expect(change).toMatchObject({
      ref: 'a1', eventType: 'INSERT', schema: 'public', table: 'rt_msgs', old: {},
      new: { id: Number(rows[0].id), recipient: A, body: 'hi' },
    })
    expect(typeof change.commit_timestamp).toBe('string')
    await sleep(500)
    expect(b.msgs.filter((m) => m.type !== 'subscribed')).toEqual([])
  })

  it('applies an eq filter to the re-read row', async () => {
    const A = randomUUID()
    const a = await connect(await user(A))
    await a.subscribe({ ref: 'f', table: 'rt_msgs', event: 'INSERT', filter: 'post_id=eq.5' })
    await pool.query(`insert into public.rt_msgs (recipient, post_id) values ($1, 4), ($1, 5)`, [A])
    // deliveries per connection are in order, so row 4 has been handled once row 5 arrives
    await a.waitFor((m) => m.type === 'change')
    const changes = a.msgs.filter((m) => m.type === 'change')
    expect(changes.map((m) => m.new.post_id)).toEqual([5])
  })

  it('rejects a filter on a missing column; eq.null matches nothing', async () => {
    const A = randomUUID()
    const a = await connect(await user(A))
    await a.subscribe({ ref: 'nc', table: 'rt_msgs', event: 'INSERT', filter: 'nope=eq.1' })
    expect(a.msgs.find((m) => m.ref === 'nc')).toMatchObject({ type: 'error' })
    await a.subscribe({ ref: 'nul', table: 'rt_msgs', event: 'INSERT', filter: 'post_id=eq.null' })
    await a.subscribe({ ref: 'all', table: 'rt_msgs', event: 'INSERT' })
    await pool.query(`insert into public.rt_msgs (recipient, post_id) values ($1, null)`, [A])
    await a.waitFor((m) => m.type === 'change' && m.ref === 'all')
    expect(a.msgs.filter((m) => m.type === 'change').map((m) => m.ref)).toEqual(['all'])
  })

  it('fans one change out to every matching ref of a connection', async () => {
    const A = randomUUID()
    const a = await connect(await user(A))
    for (const ref of ['m1', 'm2', 'm3']) await a.subscribe({ ref, table: 'rt_msgs', event: ref === 'm3' ? '*' : 'INSERT' })
    await pool.query(`insert into public.rt_msgs (recipient) values ($1)`, [A])
    await a.waitFor((m) => m.type === 'change' && m.ref === 'm3')
    expect(a.msgs.filter((m) => m.type === 'change').map((m) => m.ref).sort()).toEqual(['m1', 'm2', 'm3'])
  })

  it('caps subscriptions at 100 per connection', async () => {
    const a = await connect(await user(randomUUID()))
    for (let i = 0; i < 100; i++) a.ws.send(JSON.stringify({ type: 'subscribe', ref: `s${i}`, schema: 'public', table: 'rt_msgs', event: 'INSERT' }))
    await a.subscribe({ ref: 's100', table: 'rt_msgs', event: 'INSERT' })
    expect(a.msgs.filter((m) => m.type === 'subscribed')).toHaveLength(100)
    expect(a.msgs.find((m) => m.ref === 's100')).toMatchObject({ type: 'error' })
  })

  it('delivers an UPDATE', async () => {
    const A = randomUUID()
    const { rows } = await pool.query(`insert into public.rt_msgs (recipient, body) values ($1, 'v1') returning id`, [A])
    const a = await connect(await user(A))
    await a.subscribe({ ref: 'u', table: 'rt_msgs', event: 'UPDATE' })
    await pool.query(`update public.rt_msgs set body = 'v2' where id = $1`, [rows[0].id])
    expect(await a.waitFor((m) => m.type === 'change')).toMatchObject({
      ref: 'u', eventType: 'UPDATE', new: { id: Number(rows[0].id), body: 'v2' }, old: {},
    })
  })

  it('survives a malformed frame and an oversized message', async () => {
    // unmasked client frame: a protocol error on the server side
    const raw = tcpConnect(Number(new URL(base).port), '127.0.0.1')
    raw.on('error', () => {}) // the server resets the connection
    await new Promise((r) => raw.once('connect', r))
    const token = await user(randomUUID())
    raw.write(`GET /realtime/v1?token=${token} HTTP/1.1

Host: x

Upgrade: websocket

Connection: Upgrade

` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==

Sec-WebSocket-Version: 13



`)
    await new Promise((r) => raw.once('data', r))
    raw.write(Buffer.from([0x81, 0x02, 0x68, 0x69]))
    await new Promise((r) => raw.once('close', r))

    const big = await connect(await user(randomUUID()))
    const closed = new Promise<number>((r) => big.ws.once('close', r))
    big.ws.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(17 * 1024) }))
    expect(await closed).toBe(1009)

    const ok = await connect(await user(randomUUID()))
    ok.ws.send(JSON.stringify({ type: 'ping' }))
    await ok.waitFor((m) => m.type === 'pong')
  })

  it('a stalled re-select or subscribe check times out and the queue moves on', async () => {
    setStatementTimeout('300ms')
    const locker = await pool.connect()
    try {
      const a = await connect(await user(randomUUID()))
      await a.subscribe({ ref: 'slow', table: 'rt_slow', event: 'INSERT' })
      await pool.query('insert into public.rt_slow default values') // its re-select sleeps 10 s in the RLS policy
      await sleep(100)
      a.ws.send(JSON.stringify({ type: 'ping' }))
      await a.waitFor((m) => m.type === 'pong', 3000)
      await locker.query('begin; lock table public.rt_lock in access exclusive mode')
      await a.subscribe({ ref: 'lk', table: 'rt_lock', event: 'INSERT' })
      expect(a.msgs.find((m) => m.ref === 'lk')).toMatchObject({ type: 'error', message: expect.stringMatching(/timeout/) })
      a.ws.send(JSON.stringify({ type: 'ping', ref: 'p2' }))
      await a.waitFor((m) => m.type === 'pong' && a.msgs.filter((x) => x.type === 'pong').length === 2)
    } finally {
      setStatementTimeout('5s')
      await locker.query('rollback')
      locker.release()
    }
  })

  it('closes the connection with 1013 when more than 200 items are queued', async () => {
    const locker = await pool.connect()
    try {
      await locker.query('begin; lock table public.rt_lock in access exclusive mode')
      const a = await connect(await user(randomUUID()))
      const closed = new Promise<number>((r) => a.ws.once('close', r))
      // the first subscribe check waits on the lock, so the rest pile up behind it
      for (let i = 0; i < 250; i++) a.ws.send(JSON.stringify({ type: 'subscribe', ref: `q${i}`, schema: 'public', table: 'rt_lock', event: 'INSERT' }))
      expect(await closed).toBe(1013)
    } finally {
      await locker.query('rollback')
      locker.release()
    }
  })

  it('does not deliver to a ref unsubscribed after the change was snapshotted', async () => {
    const A = randomUUID()
    const a = await connect(await user(A))
    const watcher = await connect(await user(A))
    await a.subscribe({ ref: 'x', table: 'rt_msgs', event: 'INSERT' })
    await a.subscribe({ ref: 'y', table: 'rt_msgs', event: 'INSERT' })
    await watcher.subscribe({ ref: 'w', table: 'rt_msgs', event: 'INSERT' })
    const locker = await pool.connect()
    try {
      await locker.query('begin; lock table public.rt_lock in access exclusive mode')
      // block a's queue, then queue the unsubscribe before the change arrives
      a.ws.send(JSON.stringify({ type: 'subscribe', ref: 'blk', schema: 'public', table: 'rt_lock', event: 'INSERT' }))
      a.ws.send(JSON.stringify({ type: 'unsubscribe', ref: 'x' }))
      await sleep(100)
      await pool.query(`insert into public.rt_msgs (recipient) values ($1)`, [A])
      await watcher.waitFor((m) => m.type === 'change') // the change has been fanned out to a's queue too
    } finally {
      await locker.query('rollback')
      locker.release()
    }
    await a.waitFor((m) => m.type === 'change' && m.ref === 'y')
    expect(a.msgs.filter((m) => m.type === 'change').map((m) => m.ref)).toEqual(['y'])
  })

  it('closes the connection with 4401 on a failed auth message', async () => {
    const a = await connect(await user(randomUUID()))
    const closed = new Promise<number>((r) => a.ws.once('close', r))
    a.ws.send(JSON.stringify({ type: 'auth', token: 'not-a-jwt' }))
    expect(await closed).toBe(4401)
  })

  it('sends nothing once the token has expired', async () => {
    const A = randomUUID()
    const a = await connect(await user(A, 2))
    await a.subscribe({ ref: 'e', table: 'rt_msgs', event: 'INSERT' })
    await sleep(2100)
    await pool.query(`insert into public.rt_msgs (recipient) values ($1)`, [A])
    await sleep(500)
    expect(a.msgs.filter((m) => m.type === 'change')).toEqual([])
  })

  it('delivers DELETE with old.id to service_role only', async () => {
    const A = randomUUID()
    const { rows } = await pool.query(`insert into public.rt_msgs (recipient) values ($1) returning id`, [A])
    const a = await connect(await user(A))
    const s = await connect(await sign({ role: 'service_role' }, 60))
    await a.subscribe({ ref: 'd', table: 'rt_msgs', event: 'DELETE' })
    await s.subscribe({ ref: 'd', table: 'rt_msgs', event: 'DELETE' })
    await pool.query('delete from public.rt_msgs where id = $1', [rows[0].id])
    expect(await s.waitFor((m) => m.type === 'change')).toMatchObject({ eventType: 'DELETE', old: { id: Number(rows[0].id) }, new: {} })
    await sleep(300)
    expect(a.msgs.filter((m) => m.type === 'change')).toEqual([])
  })

  it('switches claims on an auth message; the old identity stops receiving', async () => {
    const A = randomUUID()
    const O = randomUUID()
    const a = await connect(await user(O))
    await a.subscribe({ ref: 'r', table: 'rt_msgs', event: 'INSERT' })
    a.ws.send(JSON.stringify({ type: 'auth', token: await user(A) }))
    // messages are handled in order, so the pong proves the auth message was applied
    a.ws.send(JSON.stringify({ type: 'ping' }))
    await a.waitFor((m) => m.type === 'pong')
    await pool.query(`insert into public.rt_msgs (recipient) values ($1)`, [O])
    await pool.query(`insert into public.rt_msgs (recipient) values ($1)`, [A])
    await a.waitFor((m) => m.type === 'change')
    expect(a.msgs.filter((m) => m.type === 'change').map((m) => m.new.recipient)).toEqual([A])
  })

  it('re-establishes LISTEN after the connection drops', async () => {
    const A = randomUUID()
    const a = await connect(await user(A))
    await a.subscribe({ ref: 'rc', table: 'rt_msgs', event: 'INSERT' })
    const { rows } = await pool.query(`select pg_terminate_backend(pid) as ok from pg_stat_activity where query ilike 'listen "selfbase_changes"'`)
    expect(rows).toEqual([{ ok: true }])
    await sleep(1500)
    await pool.query(`insert into public.rt_msgs (recipient) values ($1)`, [A])
    expect(await a.waitFor((m) => m.type === 'change')).toMatchObject({ new: { recipient: A } })
  })

  it('enable_realtime fails on a table without an id column', async () => {
    await pool.query('drop table if exists public.rt_noid; create table public.rt_noid (k int primary key)')
    await expect(pool.query(`select selfbase.enable_realtime('public.rt_noid')`)).rejects.toThrow(/no id column/)
  })
})
