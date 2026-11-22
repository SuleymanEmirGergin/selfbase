import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { config } from './config.ts'
import { closeDb, migrate, pool } from './db.ts'
import { app } from './app.ts'
import { startWorkers } from './jobs/index.ts'
import { httpProvisioner, setProvisioner } from './provisioner.ts'
import { startReconcile } from './reconcile.ts'

// Schema first; a failure names the migration file only (never SQL or secrets)
await migrate().catch((e: Error) => {
  console.error(`startup: ${e.message}`)
  process.exit(1)
})
// jobs left running by the previous process resume at their recorded step
const provisioner = httpProvisioner(config.provisionerUrl, config.provisionerToken)
setProvisioner(provisioner)
startWorkers({ db: pool, provisioner })
startReconcile({ db: pool, provisioner })
const server = serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`selfbase-control listening on :${info.port}`))

// Deploys send SIGTERM: stop taking requests, let the ones in flight finish, then close the pool.
let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`${signal}: shutting down`)
  setTimeout(() => process.exit(1), 8000).unref() // a stuck request must not outlive docker's 10 s grace period
  const closed = new Promise((r) => server.close(r))
  ;(server as Server).closeIdleConnections?.()
  await closed
  await closeDb()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
