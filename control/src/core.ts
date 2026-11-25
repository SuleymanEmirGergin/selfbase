// The selfbase-core modules control uses (dashboard accounts are core's auth, imported as a library: AC-12).
// Loaded dynamically so they always see core-env's settings, whatever the import order of the modules around them.
import { config } from './config.ts'
import './core-env.ts'

const [authMod, jwt, sessions, users, ratelimit, ip, coreDb, mail] = await Promise.all([
  import('selfbase-core/src/auth/index.ts'),
  import('selfbase-core/src/jwt.ts'),
  import('selfbase-core/src/auth/sessions.ts'),
  import('selfbase-core/src/auth/users.ts'),
  import('selfbase-core/src/auth/ratelimit.ts'),
  import('selfbase-core/src/ip.ts'),
  import('selfbase-core/src/db.ts'),
  import('selfbase-core/src/auth/mail.ts'),
])
// core has read its settings; anything reading the env later sees control's own PUBLIC_URL again
process.env.PUBLIC_URL = config.publicUrl

/** core's /auth/v1 router; control calls it in-process and never mounts it whole. */
export const coreAuth = authMod.default
export const { verify } = jwt
export const { lockUser, revokeSession, revokeUserSessions } = sessions
export const { findByEmail, hashPassword } = users
export const { resetRateLimits, take } = ratelimit
export const { clientIp, trustProxies } = ip
export const closeCoreDb = coreDb.closeDb
export const { background, smtpOptions } = mail
