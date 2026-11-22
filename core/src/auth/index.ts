import { Hono } from 'hono'
import { auth } from '../jwt.ts'
import type { AppEnv } from '../jwt.ts'
import core from './routes-core.ts'
import email from './routes-email.ts'
import oauth from './routes-oauth.ts'
import phone from './routes-phone.ts'

// Mounted at /auth/v1 in app.ts. Each route file is one line below.
const router = new Hono<AppEnv>()
router.use('*', auth())
router.route('/', core)
router.route('/', email)
router.route('/', oauth)
router.route('/', phone)

export default router
