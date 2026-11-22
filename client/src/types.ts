// Public type shapes. User/Session/identity shapes follow @supabase/auth-js 2.108.2 (MIT, see vendor/supabase-js/LICENSE).

export type Fetch = typeof fetch

export interface UserAppMetadata {
  provider?: string
  providers?: string[]
  [key: string]: any
}

export interface UserMetadata {
  [key: string]: any
}

export interface UserIdentity {
  id: string
  user_id: string
  identity_data?: { [key: string]: any }
  identity_id: string
  provider: string
  created_at?: string
  last_sign_in_at?: string
  updated_at?: string
}

export interface Factor {
  id: string
  friendly_name?: string
  factor_type: 'totp' | 'phone' | 'webauthn'
  status: 'verified' | 'unverified'
  created_at: string
  updated_at: string
  last_challenged_at?: string
}

export interface User {
  id: string
  app_metadata: UserAppMetadata
  user_metadata: UserMetadata
  aud: string
  confirmation_sent_at?: string
  recovery_sent_at?: string
  email_change_sent_at?: string
  new_email?: string
  new_phone?: string
  invited_at?: string
  action_link?: string
  email?: string
  phone?: string
  created_at: string
  confirmed_at?: string
  email_confirmed_at?: string
  phone_confirmed_at?: string
  last_sign_in_at?: string
  role?: string
  updated_at?: string
  identities?: UserIdentity[]
  is_anonymous?: boolean
  is_sso_user?: boolean
  factors?: Factor[]
  deleted_at?: string
  banned_until?: string
}

export interface Session {
  provider_token?: string | null
  provider_refresh_token?: string | null
  access_token: string
  refresh_token: string
  expires_in: number
  expires_at?: number
  token_type: 'bearer'
  user: User
}

export type AuthChangeEvent =
  | 'INITIAL_SESSION'
  | 'PASSWORD_RECOVERY'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED'
  | 'MFA_CHALLENGE_VERIFIED'

export type Provider = 'google' | 'apple' | 'azure' | 'facebook' | 'github' | 'gitlab' | 'twitter' | (string & {})

export interface UserAttributes {
  current_password?: string
  email?: string
  phone?: string
  password?: string
  nonce?: string
  data?: object
}

export type EmailOtpType = 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email'
export type MobileOtpType = 'sms' | 'phone_change'

export interface VerifyOtpParams {
  type: EmailOtpType | MobileOtpType
  token?: string
  token_hash?: string
  email?: string
  phone?: string
  options?: { redirectTo?: string; captchaToken?: string }
}

export interface SupportedStorage {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

export interface Subscription {
  id: string
  callback: (event: AuthChangeEvent, session: Session | null) => void | Promise<void>
  unsubscribe: () => void
}

export interface SupabaseClientOptions<SchemaName = string> {
  db?: { schema?: SchemaName }
  auth?: {
    storage?: SupportedStorage
    persistSession?: boolean
    autoRefreshToken?: boolean
    detectSessionInUrl?: boolean
    storageKey?: string
    /** Accepted for compatibility; only the implicit flow is implemented. */
    flowType?: 'implicit' | 'pkce'
  }
  global?: { headers?: Record<string, string>; fetch?: Fetch }
  realtime?: Record<string, unknown>
}
