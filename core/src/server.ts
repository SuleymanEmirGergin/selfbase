import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { config } from './config.ts'
import { attachRealtime } from './realtime/index.ts'
import { startNetQueue } from './netqueue/index.ts'

const server = serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`core listening on :${info.port}`))
attachRealtime(server as Server)
startNetQueue()
