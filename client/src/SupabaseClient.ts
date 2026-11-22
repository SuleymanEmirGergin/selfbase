// The generic parameters and the from/schema/rpc signatures are copied from
// @supabase/supabase-js 2.108.2 SupabaseClient.ts (MIT, see vendor/supabase-js/LICENSE)
// so typed queries infer exactly as they do with supabase-js.
import PostgrestClient from '../vendor/postgrest-js/src/PostgrestClient.ts'
import type PostgrestQueryBuilder from '../vendor/postgrest-js/src/PostgrestQueryBuilder.ts'
import type PostgrestFilterBuilder from '../vendor/postgrest-js/src/PostgrestFilterBuilder.ts'
import type { GenericSchema } from '../vendor/postgrest-js/src/types/common/common.ts'
import type { GetRpcFunctionFilterBuilderByArgs } from '../vendor/postgrest-js/src/types/common/rpc.ts'
import { SelfbaseAuthClient } from './auth.ts'
import { fetchWithAuth } from './fetch.ts'
import { FunctionsClient } from './functions.ts'
import { RealtimeChannel, RealtimeClient, type RealtimeRemoveChannelResponse } from './realtime.ts'
import { StorageClient } from './storage.ts'
import type { AuthChangeEvent, Fetch, SupabaseClientOptions } from './types.ts'

export default class SupabaseClient<
  Database = any,
  SchemaNameOrClientOptions extends
    | (string & keyof Omit<Database, '__InternalSupabase'>)
    | { PostgrestVersion: string } = 'public' extends keyof Omit<Database, '__InternalSupabase'>
    ? 'public'
    : string & keyof Omit<Database, '__InternalSupabase'>,
  SchemaName extends string & keyof Omit<Database, '__InternalSupabase'> =
    SchemaNameOrClientOptions extends string & keyof Omit<Database, '__InternalSupabase'>
      ? SchemaNameOrClientOptions
      : 'public' extends keyof Omit<Database, '__InternalSupabase'>
        ? 'public'
        : string & keyof Omit<Omit<Database, '__InternalSupabase'>, '__InternalSupabase'>,
  Schema extends Omit<Database, '__InternalSupabase'>[SchemaName] extends GenericSchema
    ? Omit<Database, '__InternalSupabase'>[SchemaName]
    : never = Omit<Database, '__InternalSupabase'>[SchemaName] extends GenericSchema
    ? Omit<Database, '__InternalSupabase'>[SchemaName]
    : never,
  ClientOptions extends { PostgrestVersion: string } = SchemaNameOrClientOptions extends string &
    keyof Omit<Database, '__InternalSupabase'>
    ? Database extends { __InternalSupabase: { PostgrestVersion: string } }
      ? Database['__InternalSupabase']
      : { PostgrestVersion: '12' }
    : SchemaNameOrClientOptions extends { PostgrestVersion: string }
      ? SchemaNameOrClientOptions
      : never,
> {
  auth: SelfbaseAuthClient
  realtime: RealtimeClient
  storage: StorageClient

  protected rest: PostgrestClient<Database, ClientOptions, SchemaName>
  protected headers: Record<string, string>
  protected fetch: Fetch
  protected functionsUrl: string
  protected changedAccessToken: string | undefined

  constructor(
    protected supabaseUrl: string,
    protected supabaseKey: string,
    options?: SupabaseClientOptions<SchemaName>,
  ) {
    if (!supabaseUrl) throw new Error('supabaseUrl is required.')
    if (!supabaseKey) throw new Error('supabaseKey is required.')
    const base = new URL(supabaseUrl.endsWith('/') ? supabaseUrl : `${supabaseUrl}/`)
    const at = (path: string) => new URL(path, base).href
    this.headers = { ...options?.global?.headers }
    this.functionsUrl = at('functions/v1')

    this.auth = new SelfbaseAuthClient({
      url: at('auth/v1'),
      headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, ...this.headers },
      storageKey: options?.auth?.storageKey ?? `sb-${base.hostname.split('.')[0]}-auth-token`,
      storage: options?.auth?.storage,
      persistSession: options?.auth?.persistSession,
      autoRefreshToken: options?.auth?.autoRefreshToken,
      detectSessionInUrl: options?.auth?.detectSessionInUrl,
      fetch: options?.global?.fetch,
      hasCustomAuthorizationHeader: Object.keys(this.headers).some((k) => k.toLowerCase() === 'authorization'),
    })

    const getAccessToken = async () => (await this.auth.getSession()).data.session?.access_token ?? null
    this.fetch = fetchWithAuth(supabaseKey, getAccessToken, options?.global?.fetch)

    const realtimeUrl = new URL('realtime/v1', base)
    realtimeUrl.protocol = realtimeUrl.protocol.replace('http', 'ws')
    this.realtime = new RealtimeClient(realtimeUrl.href, {
      apikey: supabaseKey,
      accessToken: getAccessToken,
      ...(options?.realtime as object),
    })

    this.rest = new PostgrestClient(at('rest/v1'), {
      headers: this.headers,
      schema: options?.db?.schema,
      fetch: this.fetch,
    })
    this.storage = new StorageClient(at('storage/v1'), this.headers, this.fetch)

    this.auth.onAuthStateChange((event, session) => this.handleTokenChanged(event, session?.access_token))
  }

  get functions(): FunctionsClient {
    return new FunctionsClient(this.functionsUrl, this.headers, this.fetch)
  }

  from<TableName extends string & keyof Schema['Tables'], Table extends Schema['Tables'][TableName]>(
    relation: TableName,
  ): PostgrestQueryBuilder<ClientOptions, Schema, Table, TableName>
  from<ViewName extends string & keyof Schema['Views'], View extends Schema['Views'][ViewName]>(
    relation: ViewName,
  ): PostgrestQueryBuilder<ClientOptions, Schema, View, ViewName>
  from(relation: string): PostgrestQueryBuilder<ClientOptions, Schema, any> {
    return this.rest.from(relation)
  }

  schema<DynamicSchema extends string & keyof Omit<Database, '__InternalSupabase'>>(
    schema: DynamicSchema,
  ): PostgrestClient<
    Database,
    ClientOptions,
    DynamicSchema,
    Database[DynamicSchema] extends GenericSchema ? Database[DynamicSchema] : any
  > {
    return this.rest.schema<DynamicSchema>(schema)
  }

  rpc<
    FnName extends string & keyof Schema['Functions'],
    Args extends Schema['Functions'][FnName]['Args'] = never,
    FilterBuilder extends GetRpcFunctionFilterBuilderByArgs<Schema, FnName, Args> = GetRpcFunctionFilterBuilderByArgs<
      Schema,
      FnName,
      Args
    >,
  >(
    fn: FnName,
    args: Args = {} as Args,
    options: { head?: boolean; get?: boolean; count?: 'exact' | 'planned' | 'estimated' } = {
      head: false,
      get: false,
      count: undefined,
    },
  ): PostgrestFilterBuilder<
    ClientOptions,
    Schema,
    FilterBuilder['Row'],
    FilterBuilder['Result'],
    FilterBuilder['RelationName'],
    FilterBuilder['Relationships'],
    'RPC'
  > {
    return this.rest.rpc(fn, args, options) as unknown as PostgrestFilterBuilder<
      ClientOptions,
      Schema,
      FilterBuilder['Row'],
      FilterBuilder['Result'],
      FilterBuilder['RelationName'],
      FilterBuilder['Relationships'],
      'RPC'
    >
  }

  channel(name: string, opts: { config?: Record<string, unknown> } = { config: {} }): RealtimeChannel {
    return this.realtime.channel(name, opts)
  }

  getChannels(): RealtimeChannel[] {
    return this.realtime.getChannels()
  }

  removeChannel(channel: RealtimeChannel): Promise<RealtimeRemoveChannelResponse> {
    return this.realtime.removeChannel(channel)
  }

  removeAllChannels(): Promise<RealtimeRemoveChannelResponse[]> {
    return this.realtime.removeAllChannels()
  }

  protected handleTokenChanged(event: AuthChangeEvent, token?: string) {
    if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && this.changedAccessToken !== token) {
      this.changedAccessToken = token
      this.realtime.setAuth(token)
    } else if (event === 'SIGNED_OUT') {
      this.realtime.setAuth()
      this.changedAccessToken = undefined
    }
  }
}
