import { Hono } from 'hono'
import { auth } from '../jwt.ts'
import type { AppEnv } from '../jwt.ts'
import { rateLimit } from './ratelimit.ts'
import core from './routes-core.ts'
import email from './routes-email.ts'
import oauth from './routes-oauth.ts'
import phone from './routes-phone.ts'

// Mounted at /auth/v1 in app.ts. Each route file is one line below.
const router = new Hono<AppEnv>()
// per-IP limits before any bcrypt work or mail (docs/auth-settings.md)
router.on('POST', '/signup', rateLimit(() => 'signIn'))
router.on('POST', '/token', rateLimit((c) => (c.req.query('grant_type') === 'refresh_token' ? 'refresh' : 'signIn')))
router.on(['GET', 'POST'], '/verify', rateLimit(() => 'verify'))
router.on('POST', ['/otp', '/recover', '/resend'], rateLimit(() => 'email'))
router.use('*', auth())
router.route('/', core)
router.route('/', email)
router.route('/', oauth)
router.route('/', phone)

export default router
