// core's modules read their settings from process.env when they load: point them at control-db first. Import this
// before anything that loads a selfbase-core module (db.ts, app.ts); load core modules dynamically after it (core.ts).
import { config } from './config.ts'

/** Where a recovery link lands: Studio's reset screen reads the session from the fragment (GoTrue implicit flow). */
export const resetPasswordUrl = `${config.publicUrl}/reset-password`

Object.assign(process.env, {
  DB_HOST: config.dbHost,
  DB_PORT: String(config.dbPort),
  POSTGRES_PASSWORD: config.dbPassword,
  JWT_SECRET: config.jwtSecret,
  // core builds its mail links as PUBLIC_URL + /auth/v1/verify; control mounts that at /platform/auth/v1 (core.ts
  // puts control's own value back once core has read it)
  PUBLIC_URL: `${config.publicUrl}/platform`,
  SITE_URL: config.publicUrl,
  AUTH_REDIRECT_ALLOWLIST: resetPasswordUrl,
  AUTH_DISABLE_SIGNUP: 'true',
})
// dashboard defaults, overridable: five sign-ins per IP per 5 minutes, 12-character passwords
process.env.AUTH_RATE_LIMIT_SIGN_IN ||= '5'
process.env.AUTH_MIN_PASSWORD ||= '12'
/** Dashboard passwords are never shorter than this, whatever AUTH_MIN_PASSWORD says (cli.ts, invitations). */
export const MIN_PASSWORD = Math.max(12, Number(process.env.AUTH_MIN_PASSWORD) || 0)
