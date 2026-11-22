// All runtime settings, read once from the environment (see .env.example).
const env = process.env

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : v === 'true')
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export const config = {
  port: Number(env.PORT ?? 8080),
  db: {
    host: env.DB_HOST ?? 'db',
    port: Number(env.DB_PORT ?? 5432),
    user: 'postgres',
    password: env.POSTGRES_PASSWORD ?? '',
    database: 'postgres',
  },
  jwtSecret: env.JWT_SECRET ?? '',
  anonKey: env.ANON_KEY ?? '',
  serviceRoleKey: env.SERVICE_ROLE_KEY ?? '',
  publicUrl: env.PUBLIC_URL ?? 'http://localhost:8080',
  siteUrl: env.SITE_URL ?? 'http://localhost:5173',
  authRedirectAllowlist: list(env.AUTH_REDIRECT_ALLOWLIST),
  authConfirmEmail: bool(env.AUTH_CONFIRM_EMAIL, true),
  authPhoneEnabled: bool(env.AUTH_PHONE_ENABLED, false),
  authMinPassword: Number(env.AUTH_MIN_PASSWORD || 8),
  smtp: {
    host: env.SMTP_HOST ?? '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER ?? '',
    pass: env.SMTP_PASS ?? '',
    from: env.SMTP_FROM ?? '',
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
  },
  panelAdminEmail: env.PANEL_ADMIN_EMAIL ?? '',
  panelAdminPasswordHash: env.PANEL_ADMIN_PASSWORD_HASH ?? '',
  panelDir: env.PANEL_DIR ?? '../panel/dist',
  storageDir: env.STORAGE_DIR ?? '/data/storage',
  functionsDir: env.FUNCTIONS_DIR ?? '',
  pgrstUrl: env.PGRST_URL ?? 'http://rest:3000',
  fnUrl: env.FN_URL ?? 'http://fn:8000',
}

if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters')
