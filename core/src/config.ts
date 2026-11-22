// All runtime settings, read once from the environment (see .env.example).
const env = process.env

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : v === 'true')
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export const config = {
  port: Number(env.PORT || 8080),
  db: {
    host: env.DB_HOST || 'db',
    port: Number(env.DB_PORT || 5432),
    user: 'postgres',
    password: env.POSTGRES_PASSWORD || '',
    database: 'postgres',
  },
  jwtSecret: env.JWT_SECRET || '',
  anonKey: env.ANON_KEY || '',
  serviceRoleKey: env.SERVICE_ROLE_KEY || '',
  publicUrl: env.PUBLIC_URL || 'http://localhost:8080',
  siteUrl: env.SITE_URL || 'http://localhost:5173',
  authRedirectAllowlist: list(env.AUTH_REDIRECT_ALLOWLIST),
  authConfirmEmail: bool(env.AUTH_CONFIRM_EMAIL, true),
  authPhoneEnabled: bool(env.AUTH_PHONE_ENABLED, false),
  authMinPassword: Number(env.AUTH_MIN_PASSWORD || 6),
  // link / OTP lifetime and per-user minimum gap between auth mails, seconds (docs/auth-settings.md)
  authOtpExpiry: Number(env.AUTH_OTP_EXPIRY || 3600),
  authEmailInterval: Number(env.AUTH_EMAIL_INTERVAL || 60),
  // Standard Webhooks secret for FN_URL/send-phone-otp-hook, "v1,whsec_<base64>"
  authSmsHookSecret: env.AUTH_SMS_HOOK_SECRET || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
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
  panelAdminEmail: env.PANEL_ADMIN_EMAIL || '',
  panelAdminPasswordHash: env.PANEL_ADMIN_PASSWORD_HASH || '',
  panelDir: env.PANEL_DIR || '../panel/dist',
  storageDir: env.STORAGE_DIR || '/data/storage',
  functionsDir: env.FUNCTIONS_DIR || '',
  pgrstUrl: env.PGRST_URL || 'http://rest:3000',
  fnUrl: env.FN_URL || 'http://fn:8000',
}

if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters')
