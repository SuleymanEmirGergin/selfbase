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
    if (this.state !== 'closed') return this
    this.statusCallback = callback
    this.state = 'joining'
    this.timeoutTimer = setTimeout(() => {
      if (this.state === 'joining') this.statusCallback?.('TIMED_OUT')
    }, timeout)
    this.socket.join(this)
    return this
  }

  async unsubscribe(): Promise<RealtimeChannelSendResponse> {
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
    if (this.state === 'closed') return
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
    if (this.state === 'joined') return
    this.state = 'joined'
    clearTimeout(this.timeoutTimer)
    this.statusCallback?.('SUBSCRIBED')
  }

  /** @internal */
  _onError(message: string) {
    this.state = 'errored'
    clearTimeout(this.timeoutTimer)
    this.statusCallback?.('CHANNEL_ERROR', new Error(message))
  }

  /** @internal */
  _onDisconnected() {
    if (this.state === 'closed') return
    for (const b of this.bindings) b.subscribed = false
    this.state = 'joining'
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
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000]

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
  protected pendingPong = false

  constructor(
    public endPoint: string,
    protected options: RealtimeClientOptions,
  ) {}

  makeRef(): string {
    return String(++this.refCounter)
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
      this.tries = 0
      this.startHeartbeat()
      for (const c of this.channels) c._resubscribeAll()
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onerror = () => {} // a close event always follows
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      clearInterval(this.heartbeatTimer)
      for (const c of this.channels) c._onDisconnected()
      if (this.channels.some((c) => c.state !== 'closed')) this.scheduleReconnect()
    }
  }

  disconnect(): void {
    clearTimeout(this.reconnectTimer)
    clearInterval(this.heartbeatTimer)
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  protected scheduleReconnect() {
    const delay = this.options.reconnectAfterMs?.(this.tries) ?? BACKOFF_MS[Math.min(this.tries, BACKOFF_MS.length - 1)]
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
