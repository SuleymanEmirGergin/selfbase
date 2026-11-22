import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { config } from './config.ts'
import { closeDb } from './db.ts'
import { attachRealtime, stopRealtime } from './realtime/index.ts'
import { startNetQueue, stopNetQueue } from './netqueue/index.ts'

const server = serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`core listening on :${info.port}`))
attachRealtime(server as Server)
startNetQueue()

// Deploys send SIGTERM: stop taking requests, let the ones in flight (uploads) finish, then close everything.
let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`${signal}: shutting down`)
  setTimeout(() => process.exit(1), 8000).unref() // a stuck request must not outlive docker's 10 s grace period
  const closed = new Promise((r) => server.close(r))
  ;(server as Server).closeIdleConnections?.()
  await Promise.allSettled([stopNetQueue(), stopRealtime()])
  await closed
  await closeDb()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
