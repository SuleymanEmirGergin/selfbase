import type { Server } from 'node:http'
import { Hono } from 'hono'
import type { AppEnv } from '../jwt.ts'

// Mounted at /realtime/v1 in app.ts; filled in by the realtime task.
const router = new Hono<AppEnv>()

export default router

/** Called once from server.ts; attach the WebSocket upgrade handler here. */
export function attachRealtime(_server: Server): void {}
