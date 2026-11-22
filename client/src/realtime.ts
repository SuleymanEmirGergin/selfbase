// Realtime over selfbase's JSON protocol (core /realtime/v1), with the supabase-js channel API.
// Payload and filter types follow @supabase/realtime-js 2.108.2 (MIT, see vendor/supabase-js/LICENSE).

export type RealtimePostgresChangesEvent = '*' | 'INSERT' | 'UPDATE' | 'DELETE'

export const REALTIME_SUBSCRIBE_STATES = {
  SUBSCRIBED: 'SUBSCRIBED',
  TIMED_OUT: 'TIMED_OUT',
  CLOSED: 'CLOSED',
  CHANNEL_ERROR: 'CHANNEL_ERROR',
} as const
export type REALTIME_SUBSCRIBE_STATES = (typeof REALTIME_SUBSCRIBE_STATES)[keyof typeof REALTIME_SUBSCRIBE_STATES]

type PayloadBase = { schema: string; table: string; commit_timestamp: string; errors: string[] | null }
export type RealtimePostgresInsertPayload<T extends { [key: string]: any }> = PayloadBase & { eventType: 'INSERT'; new: T; old: {} }
export type RealtimePostgresUpdatePayload<T extends { [key: string]: any }> = PayloadBase & { eventType: 'UPDATE'; new: T; old: Partial<T> }
export type RealtimePostgresDeletePayload<T extends { [key: string]: any }> = PayloadBase & { eventType: 'DELETE'; new: {}; old: Partial<T> }
export type RealtimePostgresChangesPayload<T extends { [key: string]: any }> =
  | RealtimePostgresInsertPayload<T>
  | RealtimePostgresUpdatePayload<T>
  | RealtimePostgresDeletePayload<T>

export type RealtimePostgresChangesFilter<T extends RealtimePostgresChangesEvent> = {
  event: T
  schema: string
  table?: string
  filter?: string
}

export type RealtimeChannelSendResponse = 'ok' | 'timed out' | 'error'
export type RealtimeRemoveChannelResponse = 'ok' | 'timed out' | 'error'

type SubscribeCallback = (status: REALTIME_SUBSCRIBE_STATES, err?: Error) => void

interface Binding {
  ref: string
  filter: RealtimePostgresChangesFilter<RealtimePostgresChangesEvent>
  callback: (payload: any) => void
  subscribed: boolean
}

export class RealtimeChannel {
  topic: string
  state: 'closed' | 'joining' | 'joined' | 'errored' = 'closed'
  bindings: Binding[] = []
  protected statusCallback: SubscribeCallback | undefined
  protected timeoutTimer: ReturnType<typeof setTimeout> | undefined
  protected rejoinTimer: ReturnType<typeof setTimeout> | undefined
  protected rejoinTries = 0
  protected joinTimeout = 10_000

  constructor(
    public subTopic: string,
    protected socket: RealtimeClient,
  ) {
    this.topic = `realtime:${subTopic}`
  }

  on<T extends { [key: string]: any }>(
    type: 'postgres_changes',
    filter: RealtimePostgresChangesFilter<'*'>,
    callback: (payload: RealtimePostgresChangesPayload<T>) => void,
  ): RealtimeChannel
  on<T extends { [key: string]: any }>(
    type: 'postgres_changes',
    filter: RealtimePostgresChangesFilter<'INSERT'>,
    callback: (payload: RealtimePostgresInsertPayload<T>) => void,
  ): RealtimeChannel
  on<T extends { [key: string]: any }>(
    type: 'postgres_changes',
    filter: RealtimePostgresChangesFilter<'UPDATE'>,
    callback: (payload: RealtimePostgresUpdatePayload<T>) => void,
  ): RealtimeChannel
  on<T extends { [key: string]: any }>(
    type: 'postgres_changes',
    filter: RealtimePostgresChangesFilter<'DELETE'>,
    callback: (payload: RealtimePostgresDeletePayload<T>) => void,
  ): RealtimeChannel
  on(type: 'postgres_changes', filter: RealtimePostgresChangesFilter<RealtimePostgresChangesEvent>, callback: (payload: any) => void): RealtimeChannel {
    if (type !== 'postgres_changes') throw new Error(`selfbase realtime: only postgres_changes is supported, got ${type}`)
    const binding: Binding = { ref: this.socket.makeRef(), filter, callback, subscribed: false }
    this.bindings.push(binding)
    if (this.state !== 'closed') this.socket.sendSubscribe(this, binding)
    return this
  }

  subscribe(callback?: SubscribeCallback, timeout = 10_000): RealtimeChannel {
    if (this.state === 'joining' || this.state === 'joined') return this
    this.statusCallback = callback
    this.joinTimeout = timeout
    this.rejoinTries = 0
    this._join()
    return this
  }

  /** @internal (re)joins: subscribes every binding; an errored channel comes back here on socket open or its rejoin timer. */
  _join() {
    clearTimeout(this.rejoinTimer)
    clearTimeout(this.timeoutTimer)
    this.state = 'joining'
    for (const b of this.bindings) b.subscribed = false
    this.timeoutTimer = setTimeout(() => {
      if (this.state !== 'joining') return
      // a timed-out channel stays errored until its rejoin: a late ack must not report SUBSCRIBED meanwhile
      this.state = 'errored'
      this.statusCallback?.('TIMED_OUT')
      this.scheduleRejoin()
    }, this.joinTimeout)
    this.socket.join(this)
  }

  /** Rejoin with backoff (up to 60 s), so a permanent error (unknown table, subscription cap) never retries in a tight loop. */
  protected scheduleRejoin() {
    clearTimeout(this.rejoinTimer)
    this.rejoinTimer = setTimeout(() => {
      // while the socket is down, the next socket open rejoins instead
      if (this.state === 'errored' && this.socket.isConnected()) this._join()
    }, this.socket.rejoinDelay(this.rejoinTries++))
  }

  async unsubscribe(): Promise<RealtimeChannelSendResponse> {
    clearTimeout(this.rejoinTimer)
    if (this.state === 'closed') return 'ok'
    clearTimeout(this.timeoutTimer)
    for (const b of this.bindings) this.socket.send({ type: 'unsubscribe', ref: b.ref })
    this.state = 'closed'
    this.socket.leave(this)
    this.statusCallback?.('CLOSED')
    return 'ok'
  }

  /** @internal */
  _resubscribeAll() {
    if (this.state !== 'joining' && this.state !== 'joined') return
    for (const b of this.bindings) this.socket.sendSubscribe(this, b)
    if (!this.bindings.length) this._markJoined()
  }

  /** @internal */
  _onSubscribed(ref: string) {
    const b = this.bindings.find((x) => x.ref === ref)
    if (b) b.subscribed = true
    if (this.bindings.every((x) => x.subscribed)) this._markJoined()
  }

  protected _markJoined() {
    if (this.state !== 'joining') return
    this.state = 'joined'
    this.rejoinTries = 0
    clearTimeout(this.timeoutTimer)
    this.statusCallback?.('SUBSCRIBED')
  }

  /** @internal */
  _onError(message: string) {
    if (this.state === 'closed') return
    const already = this.state === 'errored'
    this.state = 'errored'
    clearTimeout(this.timeoutTimer)
    this.statusCallback?.('CHANNEL_ERROR', new Error(message))
    if (!already) this.scheduleRejoin()
  }

  /** @internal */
  _onDisconnected() {
    for (const b of this.bindings) b.subscribed = false
    if (this.state === 'joined') this.state = 'joining'
  }

  /** @internal */
  _onChange(ref: string, msg: any) {
    const b = this.bindings.find((x) => x.ref === ref)
    b?.callback({
      schema: msg.schema,
      table: msg.table,
      commit_timestamp: msg.commit_timestamp,
      eventType: msg.eventType,
      new: msg.new ?? {},
      old: msg.old ?? {},
      errors: null,
    })
  }
}

export interface RealtimeClientOptions {
  apikey: string
  /** Current access token; falls back to the last setAuth() value, then the apikey. */
  accessToken?: () => Promise<string | null>
  transport?: typeof WebSocket
  heartbeatIntervalMs?: number
  reconnectAfterMs?: (tries: number) => number
  /** Delay before an errored channel (TIMED_OUT / CHANNEL_ERROR) rejoins while the socket is open. */
  rejoinAfterMs?: (tries: number) => number
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000]
const REJOIN_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000]
/** The attempt counter resets only once a connection has stayed open this long. */
const STABLE_MS = 30_000
/** Server close code for "try again later" (overloaded). */
const CLOSE_TRY_AGAIN_LATER = 1013

export class RealtimeClient {
  channels: RealtimeChannel[] = []
  protected ws: WebSocket | null = null
  protected connecting = false
  protected token: string | null = null
  protected refCounter = 0
  protected refs = new Map<string, RealtimeChannel>()
  protected tries = 0
  protected reconnectTimer: ReturnType<typeof setTimeout> | undefined
  protected heartbeatTimer: ReturnType<typeof setInterval> | undefined
  protected stableTimer: ReturnType<typeof setTimeout> | undefined
  protected pendingPong = false

  constructor(
    public endPoint: string,
    protected options: RealtimeClientOptions,
  ) {}

  makeRef(): string {
    return String(++this.refCounter)
  }

  /** @internal */
  rejoinDelay(tries: number): number {
    return this.options.rejoinAfterMs?.(tries) ?? REJOIN_MS[Math.min(tries, REJOIN_MS.length - 1)]
  }

  channel(name: string, _opts?: unknown): RealtimeChannel {
    const existing = this.channels.find((c) => c.topic === `realtime:${name}`)
    if (existing) return existing
    const ch = new RealtimeChannel(name, this)
    this.channels.push(ch)
    return ch
  }

  getChannels(): RealtimeChannel[] {
    return this.channels
  }

  async removeChannel(channel: RealtimeChannel): Promise<RealtimeRemoveChannelResponse> {
    const status = await channel.unsubscribe()
    this.channels = this.channels.filter((c) => c !== channel)
    if (this.channels.length === 0) this.disconnect()
    return status
  }

  async removeAllChannels(): Promise<RealtimeRemoveChannelResponse[]> {
    const result = await Promise.all([...this.channels].map((c) => this.removeChannel(c)))
    this.disconnect()
    return result
  }

  isConnected(): boolean {
    return this.ws?.readyState === 1
  }

  /** Sends the new token to the server when connected; later connects use it too. */
  setAuth(token?: string | null): void {
    this.token = token ?? null
    this.send({ type: 'auth', token: this.token ?? this.options.apikey })
  }

  /** @internal */
  join(channel: RealtimeChannel) {
    if (!this.channels.includes(channel)) this.channels.push(channel)
    if (this.isConnected()) channel._resubscribeAll()
    else void this.connect()
  }

  /** @internal */
  leave(channel: RealtimeChannel) {
    for (const b of channel.bindings) this.refs.delete(b.ref)
  }

  /** @internal */
  sendSubscribe(channel: RealtimeChannel, b: { ref: string; filter: RealtimePostgresChangesFilter<RealtimePostgresChangesEvent> }) {
    this.refs.set(b.ref, channel)
    const { event, schema, table, filter } = b.filter
    this.send({ type: 'subscribe', ref: b.ref, schema: schema ?? 'public', table, event: event ?? '*', ...(filter ? { filter } : {}) })
  }

  /** @internal */
  send(msg: unknown) {
    if (this.isConnected()) this.ws!.send(JSON.stringify(msg))
  }

  async connect(): Promise<void> {
    if (this.ws || this.connecting) return
    this.connecting = true
    clearTimeout(this.reconnectTimer)
    let token: string | null = null
    try {
      token = (await this.options.accessToken?.()) ?? null
    } catch {
      // fall back to the last known token
    }
    token = token ?? this.token ?? this.options.apikey
    this.connecting = false
    if (!this.channels.some((c) => c.state !== 'closed')) return
    const Transport = this.options.transport ?? globalThis.WebSocket
    const ws = new Transport(`${this.endPoint}?token=${encodeURIComponent(token)}`)
    this.ws = ws
    ws.onopen = () => {
      clearTimeout(this.stableTimer)
      this.stableTimer = setTimeout(() => (this.tries = 0), STABLE_MS)
      this.startHeartbeat()
      for (const c of this.channels) c.state === 'errored' ? c._join() : c._resubscribeAll()
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onerror = () => {} // a close event always follows
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      clearInterval(this.heartbeatTimer)
      clearTimeout(this.stableTimer)
      if (ev?.code === CLOSE_TRY_AGAIN_LATER) this.tries = Math.max(this.tries, BACKOFF_MS.length - 1)
      for (const c of this.channels) c._onDisconnected()
      if (this.channels.some((c) => c.state !== 'closed')) this.scheduleReconnect()
    }
  }

  disconnect(): void {
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.stableTimer)
    clearInterval(this.heartbeatTimer)
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  protected scheduleReconnect() {
    const base = BACKOFF_MS[Math.min(this.tries, BACKOFF_MS.length - 1)]
    // up to +30 % jitter so clients dropped together do not reconnect in lockstep
    const delay = this.options.reconnectAfterMs?.(this.tries) ?? base + Math.random() * base * 0.3
    this.tries++
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => void this.connect(), delay)
  }

  protected startHeartbeat() {
    clearInterval(this.heartbeatTimer)
    this.pendingPong = false
    this.heartbeatTimer = setInterval(() => {
      if (this.pendingPong) {
        this.ws?.close() // no pong since the last ping: treat as dead, onclose reconnects
        return
      }
      this.pendingPong = true
      this.send({ type: 'ping' })
    }, this.options.heartbeatIntervalMs ?? 25_000)
  }

  protected onMessage(raw: unknown) {
    let msg: any
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'pong') {
      this.pendingPong = false
      return
    }
    const channel = msg.ref ? this.refs.get(String(msg.ref)) : undefined
    if (!channel) return
    if (msg.type === 'subscribed') channel._onSubscribed(String(msg.ref))
    else if (msg.type === 'error') channel._onError(msg.message ?? 'subscription error')
    else if (msg.type === 'change') channel._onChange(String(msg.ref), msg)
  }
}
