import type { Server } from 'node:http'
import { Hono } from 'hono'
import type { AppEnv } from '../jwt.ts'
import { startHub, stopHub } from './hub.ts'

// Mounted at /realtime/v1 in app.ts; the WebSocket itself is served by the upgrade handler below.
const router = new Hono<AppEnv>()

export default router

/** Called once from server.ts; serves the WebSocket on GET /realtime/v1. Resolves once LISTEN is up. */
export function attachRealtime(server: Server): Promise<void> {
  return startHub(server)
}

export const stopRealtime = stopHub
