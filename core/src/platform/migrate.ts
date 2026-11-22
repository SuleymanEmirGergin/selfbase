// Versioned platform migrations (db/platform/NNNN-name.sql), applied by core at start under an advisory lock.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import pg from 'pg'

const FILE = /^(\d{4})-[a-z0-9-]+\.sql$/

/** Applies the pending files of dir in version order; returns the versions it ran. */
export async function applyMigrations(
  pool: pg.Pool,
  opts: { dir: string; ledger: string; lockKey: number; adoptV1?: boolean },
): Promise<string[]> {
  const files = readdirSync(opts.dir).filter((f) => f.endsWith('.sql')).sort()
  const versions = files.map((f, i) => {
    const v = FILE.exec(f)?.[1]
    if (!v) throw new Error(`platform migration ${f}: name does not match NNNN-name.sql`)
    const want = String(i + 1).padStart(4, '0')
    if (v !== want) throw new Error(`platform migration ${f}: ${v < want ? 'duplicate' : 'gap'}, expected version ${want}`)
    return v
  })
  const ledger = opts.ledger.split('.').map((s) => pg.escapeIdentifier(s)).join('.')
  const client = await pool.connect()
  // the ledger lives in a schema 0001 creates, so it is created with the first recorded file
  const stamp = async (i: number) => {
    await client.query(`create table if not exists ${ledger}
      (version text primary key, name text not null, applied_at timestamptz not null default now())`)
    await client.query(`insert into ${ledger} (version, name) values ($1, $2)`, [versions[i], files[i]])
  }
  try {
    await client.query('select pg_advisory_lock($1)', [opts.lockKey])
    const has = async (rel: string) => (await client.query('select to_regclass($1) is not null as e', [rel])).rows[0].e
    if (opts.adoptV1 && !(await has(opts.ledger)) && (await has('selfbase.http_queue'))) {
      await inTransaction(client, files[0], () => stamp(0))
    }
    const applied: string[] = (await has(opts.ledger))
      ? (await client.query(`select version from ${ledger} order by version`)).rows.map((r) => r.version)
      : []
    applied.forEach((v, i) => {
      if (v !== versions[i]) throw new Error(`platform migrations: ledger version ${v} has no file in order (files end at ${versions.at(-1) ?? 'none'})`)
    })

    const ran: string[] = []
    for (const [i, file] of files.entries()) {
      if (i < applied.length) continue
      const sql = readFileSync(join(opts.dir, file), 'utf8')
      await inTransaction(client, file, async () => {
        await client.query(sql)
        await stamp(i)
      })
      ran.push(versions[i])
    }
    return ran
  } finally {
    await client.query('select pg_advisory_unlock($1)', [opts.lockKey]).catch(() => {})
    client.release()
  }
}

// Errors name the file and Postgres's message, never the SQL text
async function inTransaction(client: pg.PoolClient, file: string, fn: () => Promise<void>) {
  await client.query('begin')
  try {
    await fn()
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw new Error(`platform migration ${file} failed: ${(e as Error).message}`)
  }
}

/** Sets a login role's password, sent as a SCRAM verifier so the plain password never reaches statement logs. */
export async function setRolePassword(pool: pg.Pool, role: 'authenticator', password: string): Promise<void> {
  if (!password) throw new Error(`${role} password must not be empty`)
  await pool.query(`alter role ${pg.escapeIdentifier(role)} password ${pg.escapeLiteral(scramVerifier(password))}`)
}

// RFC 5802 / 7677 verifier in Postgres's stored format. shortcut: no SASLprep, so non-ASCII passwords may differ
// from what libpq computes; generated passwords are ASCII.
function scramVerifier(password: string, iterations = 4096) {
  const salt = randomBytes(16)
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const hmac = (key: Buffer, s: string) => createHmac('sha256', key).update(s).digest()
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest()
  const b64 = (b: Buffer) => b.toString('base64')
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(hmac(salted, 'Server Key'))}`
}
