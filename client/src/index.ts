import SupabaseClient from './SupabaseClient.ts'
import type { GenericSchema } from '../vendor/postgrest-js/src/types/common/common.ts'
import type { SupabaseClientOptions } from './types.ts'

export { SupabaseClient }
export * from './types.ts'
export {
  AuthError,
  AuthApiError,
  AuthSessionMissingError,
  AuthRetryableFetchError,
  AuthWeakPasswordError,
  AuthImplicitGrantRedirectError,
  isAuthError,
  SelfbaseAuthClient as SupabaseAuthClient,
} from './auth.ts'
export { FunctionsError, FunctionsHttpError, FunctionsRelayError, FunctionsFetchError } from './functions.ts'
export type { FunctionInvokeOptions, FunctionsResponse } from './functions.ts'
export { StorageError, StorageApiError, StorageUnknownError } from './storage.ts'
export type { FileObject, FileOptions, SearchOptions } from './storage.ts'
export { RealtimeChannel, RealtimeClient, REALTIME_SUBSCRIBE_STATES } from './realtime.ts'
export type {
  RealtimePostgresChangesPayload,
  RealtimePostgresInsertPayload,
  RealtimePostgresUpdatePayload,
  RealtimePostgresDeletePayload,
  RealtimePostgresChangesFilter,
} from './realtime.ts'
export {
  PostgrestError,
  PostgrestQueryBuilder,
  PostgrestFilterBuilder,
  PostgrestTransformBuilder,
  PostgrestBuilder,
} from '../vendor/postgrest-js/src/index.ts'
export type {
  PostgrestResponse,
  PostgrestSingleResponse,
  PostgrestMaybeSingleResponse,
} from '../vendor/postgrest-js/src/index.ts'

/** Marker so hosts (e.g. the Deno function server) can tell this module from supabase-js. */
export const SELFBASE = true

/** Same signature and generic defaults as supabase-js createClient. */
export const createClient = <
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
>(
  supabaseUrl: string,
  supabaseKey: string,
  options?: SupabaseClientOptions<SchemaName>,
): SupabaseClient<Database, SchemaNameOrClientOptions, SchemaName> => {
  return new SupabaseClient<Database, SchemaNameOrClientOptions, SchemaName>(supabaseUrl, supabaseKey, options)
}

export type { GenericSchema }
export type { User as AuthUser, Session as AuthSession } from './types.ts'
