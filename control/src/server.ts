import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { config } from './config.ts'
import { closeDb, migrate, pool } from './db.ts'
import { app } from './app.ts'
import { trustProxies } from './core.ts'
import { evictStaleLegacyNames, startWorkers } from './jobs/index.ts'
import { httpProvisioner, setProvisioner } from './provisioner.ts'
import { startReconcile } from './reconcile.ts'
import { startSchedule } from './schedule.ts'
import { shutdownHandler } from './shutdown.ts'

// Schema first; a failure names the migration file only (never SQL or secrets)
await migrate().catch((e: Error) => {
  console.error(`startup: ${e.message}`)
  process.exit(1)
})
// a legacy name LEGACY_HOSTNAMES no longer gives its project's org leaves the router before any job runs
await evictStaleLegacyNames(pool).catch((e: Error) => {
  console.error(`startup: stale legacy names could not be removed: ${e.message}`)
  process.exit(1)
})
// jobs left running by the previous process resume at their recorded step
const provisioner = httpProvisioner(config.provisionerUrl, config.provisionerToken)
setProvisioner(provisioner)
// X-Forwarded-For counts only from the proxy container (by exact name, via the provisioner) and listed addresses
trustProxies(async () => (await provisioner.proxy()).addresses, config.trustedProxyIps)
const workers = startWorkers({ db: pool, provisioner })
const reconcile = startReconcile({ db: pool, provisioner })
const schedule = startSchedule(pool)
const server = serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`selfbase-control listening on :${info.port}`))

const shutdown = shutdownHandler(server as Server, [workers, reconcile, schedule], closeDb)
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
