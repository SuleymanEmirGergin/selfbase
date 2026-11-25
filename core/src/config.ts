// All runtime settings, read once from the environment (see .env.example).
const env = process.env

// anything but true/false/empty is a typo that would silently flip a security setting, so it stops startup
const bool = (v: string | undefined, dflt: boolean) => {
  if (v === undefined || v === '') return dflt
  if (v !== 'true' && v !== 'false') throw new Error(`boolean setting must be true or false, got "${v}"`)
  return v === 'true'
}
// NaN or a negative value would silently drop a limit (password minimum, rate limits), so it stops startup too
const num = (name: string, dflt: number) => {
  const v = env[name]
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of 0 or more, got "${v}"`)
  return n
}
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export const config = {
  port: num('PORT', 8080),
  // private admin API listener; not started unless ADMIN_TOKEN has at least 32 characters (server.ts)
  adminPort: num('ADMIN_PORT', 8081),
  adminToken: env.ADMIN_TOKEN || '',
  // the project this core serves, written on every log line
  projectRef: env.PROJECT_REF || '',
  db: {
    host: env.DB_HOST || 'db',
    port: num('DB_PORT', 5432),
    user: 'postgres',
    password: env.POSTGRES_PASSWORD || '',
    database: 'postgres',
  },
  // core logs in as authenticator for end-user queries and sets its password at every start (db/platform/0001)
  authenticatorPassword: env.AUTHENTICATOR_PASSWORD || env.POSTGRES_PASSWORD || '',
  platformDir: env.PLATFORM_DIR || '/app/db/platform',
  jwtSecret: env.JWT_SECRET || '',
  publicUrl: env.PUBLIC_URL || 'http://localhost:8080',
  siteUrl: env.SITE_URL || 'http://localhost:5173',
  authRedirectAllowlist: list(env.AUTH_REDIRECT_ALLOWLIST),
  authConfirmEmail: bool(env.AUTH_CONFIRM_EMAIL, true),
  // no new users from POST /signup, /otp or a first Google login (422 / redirect signup_disabled), as in GoTrue
  authDisableSignup: bool(env.AUTH_DISABLE_SIGNUP, false),
  authPhoneEnabled: bool(env.AUTH_PHONE_ENABLED, false),
  authMinPassword: num('AUTH_MIN_PASSWORD', 6),
  // link / OTP lifetime and per-user minimum gap between auth mails, seconds (docs/auth-settings.md)
  authOtpExpiry: num('AUTH_OTP_EXPIRY', 3600),
  authEmailInterval: num('AUTH_EMAIL_INTERVAL', 60),
  // Standard Webhooks secret for FN_URL/send-phone-otp-hook, "v1,whsec_<base64>"
  authSmsHookSecret: env.AUTH_SMS_HOOK_SECRET || '',
  // with AUTH_CONFIRM_EMAIL on, an email change needs a link from the old and the new address
  authSecureEmailChange: bool(env.AUTH_SECURE_EMAIL_CHANGE, true),
  // seconds after a rotation in which a retried refresh token gets the same new session instead of revoking it; 0 = strict
  authRefreshReuseInterval: num('AUTH_REFRESH_REUSE_INTERVAL', 10),
  // where a contested sign-up (password dropped) lands to set one; empty = the sign-up's redirect_to
  authSetPasswordUrl: env.AUTH_SET_PASSWORD_URL || '',
  // per-IP requests per 5 minutes (docs/auth-settings.md); 0 disables that limit
  authRateLimits: {
    signIn: num('AUTH_RATE_LIMIT_SIGN_IN', 30),
    verify: num('AUTH_RATE_LIMIT_VERIFY', 30),
    refresh: num('AUTH_RATE_LIMIT_REFRESH', 150),
    email: num('AUTH_RATE_LIMIT_EMAIL', 30),
  },
  smtp: {
    host: env.SMTP_HOST || '',
    port: num('SMTP_PORT', 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || '',
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    userinfoUrl: env.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo',
  },
  storageDir: env.STORAGE_DIR || '/data/storage',
  pgrstUrl: env.PGRST_URL || 'http://rest:3000',
  fnUrl: env.FN_URL || 'http://fn:8000',
  // hosts (names or addresses) net.http_* may reach although they resolve to a private, loopback or link-local address
  netAllowHosts: new Set(list(env.NETQUEUE_ALLOW_HOSTS).map((h) => h.toLowerCase().replace(/^\[|\]$/g, ''))),
  // hosts core's own outbound calls (Google OAuth, SMTP) may reach although they resolve to a private address (netguard.ts)
  outboundAllowHosts: new Set(list(env.OUTBOUND_ALLOW_HOSTS).map((h) => h.toLowerCase().replace(/^\[|\]$/g, ''))),
}

if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters')
