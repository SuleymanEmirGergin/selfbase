import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { adminApp, app } from './app.ts'
import { config } from './config.ts'
import { closeDb, pool } from './db.ts'
import { logLine } from './log.ts'
import { applyMigrations, setRolePassword } from './platform/migrate.ts'
import { attachRealtime, stopRealtime } from './realtime/index.ts'
import { startNetQueue, stopNetQueue } from './netqueue/index.ts'

// Schema first, then the login PostgREST and asUser() use; a failure names the file only (never SQL or secrets)
await applyMigrations(pool, { dir: config.platformDir, ledger: 'selfbase.platform_migrations', lockKey: 7213014, adoptV1: true })
  .then(() => setRolePassword(pool, 'authenticator', config.authenticatorPassword))
  .catch((e: Error) => {
    logLine('error', `startup: ${e.message}`)
    process.exit(1)
  })
const server = serve({ fetch: app.fetch, port: config.port }, (info) => logLine('info', `core listening on :${info.port}`))
attachRealtime(server as Server)
startNetQueue()

// The admin listener is never published (AC-5); without a usable token there is nothing for it to accept.
const adminServer = config.adminToken.length >= 32
  ? serve({ fetch: adminApp.fetch, port: config.adminPort }, (info) => logLine('info', `core admin listening on :${info.port}`))
  : null
if (!adminServer) logLine('warn', 'ADMIN_TOKEN is empty or shorter than 32 characters: admin API not started')

// Deploys send SIGTERM: stop taking requests, let the ones in flight (uploads) finish, then close everything.
let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  logLine('info', `${signal}: shutting down`)
  setTimeout(() => process.exit(1), 8000).unref() // a stuck request must not outlive docker's 10 s grace period
  const servers = [server, adminServer].filter((s) => s !== null) as Server[]
  const closed = Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  for (const s of servers) s.closeIdleConnections?.()
  await Promise.allSettled([stopNetQueue(), stopRealtime()])
  await closed
  await closeDb()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
