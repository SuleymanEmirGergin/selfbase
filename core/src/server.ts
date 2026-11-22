import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { config } from './config.ts'
import { closeDb, pool } from './db.ts'
import { applyMigrations, setRolePassword } from './platform/migrate.ts'
import { attachRealtime, stopRealtime } from './realtime/index.ts'
import { startNetQueue, stopNetQueue } from './netqueue/index.ts'

// Schema first, then the login PostgREST and asUser() use; a failure names the file only (never SQL or secrets)
await applyMigrations(pool, { dir: config.platformDir, ledger: 'selfbase.platform_migrations', lockKey: 7213014, adoptV1: true })
  .then(() => setRolePassword(pool, 'authenticator', config.authenticatorPassword))
  .catch((e: Error) => {
    console.error(`startup: ${e.message}`)
    process.exit(1)
  })
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
