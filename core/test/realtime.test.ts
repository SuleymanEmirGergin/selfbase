import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { pool } from '../src/db.ts'
import { sign } from '../src/jwt.ts'
import { attachRealtime, stopRealtime } from '../src/realtime/index.ts'

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
  `)
  await attachRealtime(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  sockets.forEach((s) => s.terminate())
  await stopRealtime()
  await new Promise((r) => server.close(r))
  await pool.query('drop table if exists public.rt_msgs; drop table if exists public.rt_noid')
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
    await a.waitFor((m) => m.type === 'change')
    await sleep(300)
    const changes = a.msgs.filter((m) => m.type === 'change')
    expect(changes.map((m) => m.new.post_id)).toEqual([5])
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

  it('switches claims on an auth message', async () => {
    const A = randomUUID()
    const a = await connect(await user(randomUUID()))
    await a.subscribe({ ref: 'r', table: 'rt_msgs', event: 'INSERT' })
    a.ws.send(JSON.stringify({ type: 'auth', token: await user(A) }))
    await sleep(100)
    await pool.query(`insert into public.rt_msgs (recipient) values ($1)`, [A])
    expect(await a.waitFor((m) => m.type === 'change')).toMatchObject({ new: { recipient: A } })
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
