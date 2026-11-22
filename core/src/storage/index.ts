import { Hono } from 'hono'
import type { AppEnv } from '../jwt.ts'

// Mounted at the path in app.ts; filled in by its own task.
const router = new Hono<AppEnv>()

export default router
