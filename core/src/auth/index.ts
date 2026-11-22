import { Hono } from 'hono'
import { auth } from '../jwt.ts'
import type { AppEnv } from '../jwt.ts'
import core from './routes-core.ts'

// Mounted at /auth/v1 in app.ts. Each route file is one line below.
const router = new Hono<AppEnv>()
router.use('*', auth())
router.route('/', core)

export default router
