// control-db: the pool, and the schema control applies at start. Import this before any selfbase-core module.
import pg from 'pg'
import { config } from './config.ts'
import './core-env.ts'

// dynamic so it can never be hoisted above the assignment
const { applyMigrations } = await import('selfbase-core/src/platform/migrate.ts')

export const pool = new pg.Pool({
  host: config.dbHost,
  port: config.dbPort,
  user: 'postgres',
  password: config.dbPassword,
  database: 'postgres',
  max: 10,
  connectionTimeoutMillis: 10_000,
})
// an idle client whose backend died emits 'error' on the pool; unhandled, it would end the process
pool.on('error', (e) => console.error('control-db pool:', e.message))

export type Db = pg.Pool | pg.PoolClient

/** core's platform schema (auth), then control/migrations, then the rows control needs. Safe to run twice. */
export async function migrate(): Promise<void> {
  await applyMigrations(pool, { dir: config.platformDir, ledger: 'selfbase.platform_migrations', lockKey: 7213014 })
  await applyMigrations(pool, { dir: config.controlMigrationsDir, ledger: 'control.migrations', lockKey: 7213015 })
  await pool.query(
    `insert into control.nodes (name, docker_endpoint, proxy_mode, proxy_network, memory_budget_mb)
     values ($1, $2, $3, $4, $5) on conflict (name) do nothing`,
    [config.nodeName, config.provisionerUrl, config.proxyMode, config.proxyNetwork, config.memoryBudgetMb],
  )
  await pool.query(`insert into control.settings (key, value) values ('current_template_version', $1) on conflict (key) do nothing`, [
    config.templateVersion,
  ])
}

/** Closes the pool (tests, shutdown). Safe to call twice. */
export async function closeDb(): Promise<void> {
  if (!pool.ended) await pool.end()
  // core's own pools (core.ts), opened lazily against the same database
  await (await import('./core.ts')).closeCoreDb()
}
