// Hostnames are scarce on sslip.io (spec 7.3, AC-33): a host, once certified, is kept as a host_slots row and
// reused; at most MAX_NEW_HOSTS_PER_WEEK new ones are made in any 7 days, the control host included.
import pg from 'pg'
import { config, HOSTNAME_RE } from './config.ts'
import type { Db } from './db.ts'
import { ApiError } from './errors.ts'

type HostCode = 'new_host_cap' | 'test_host_busy' | 'custom_under_base' | 'legacy_not_allowed' | 'hostname_taken' | 'invalid_hostname'

export class HostError extends ApiError {
  details: Record<string, unknown>
  constructor(code: HostCode, message: string, details: Record<string, unknown> = {}) {
    super(409, code, message)
    this.details = details
  }
}

// serializes every slot change, so the cap check and the insert it allows cannot interleave
const LOCK = 7213016
const WEEK_MS = 7 * 86400e3

// shortcut: a passed client must not already be in a transaction (begin/commit here would end the caller's)
async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = db instanceof pg.Pool ? await db.connect() : db
  try {
    await c.query('begin')
    await c.query('select pg_advisory_xact_lock($1)', [LOCK])
    const out = await fn(c)
    await c.query('commit')
    return out
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally {
    if (c !== db) c.release()
  }
}

/** When each new host of the last 7 days was first issued, oldest first: slots plus the control host. */
async function issuedThisWeek(db: Db): Promise<Date[]> {
  const rows = (await db.query(
    `select first_issued_at as at from control.host_slots where first_issued_at > now() - interval '7 days'
     union all
     select at from (select case when key = 'control_host_first_issued_at' then value::timestamptz end as at from control.settings) s
      where at > now() - interval '7 days'
     order by 1`,
  )).rows
  return rows.map((r) => r.at as Date)
}

export async function newHostsThisWeek(db: Db): Promise<number> {
  return (await issuedThisWeek(db)).length
}

/**
 * Gives the project its default hostname: a free slot of the pool first, else a new host within the weekly cap.
 * A project that already holds a slot gets it back (`isNew: false`), so a retried step changes nothing.
 */
export async function allocateHost(db: Db, p: { projectId: string; ref: string; pool: 'project' | 'test' }): Promise<{ hostname: string; isNew: boolean }> {
  return tx(db, async (c) => {
    const held = (await c.query('select hostname from control.host_slots where project_id = $1', [p.projectId])).rows[0]
    if (held) return { hostname: held.hostname as string, isNew: false }

    const free = (await c.query(
      'select id, hostname from control.host_slots where pool = $1 and project_id is null order by hostname limit 1', [p.pool],
    )).rows[0]
    let hostname: string
    let isNew = false
    if (free) {
      hostname = free.hostname
      await c.query('update control.host_slots set project_id = $1 where id = $2', [p.projectId, free.id])
    } else {
      hostname = p.pool === 'test' ? config.testHost : `${p.ref}.${config.baseDomain}`
      if (p.pool === 'test' && (await c.query('select 1 from control.host_slots where hostname = $1', [hostname])).rowCount) {
        throw new HostError('test_host_busy', `The test host ${hostname} is in use by another project. Delete that project first, then try again.`)
      }
      await checkCap(c)
      await c.query(`insert into control.host_slots (hostname, pool, project_id, first_issued_at) values ($1, $2, $3, now())`,
        [hostname, p.pool, p.projectId])
      isNew = true
    }
    await c.query(`insert into control.project_domains (project_id, hostname, kind) values ($1, $2, 'default')`, [p.projectId, hostname])
    return { hostname, isNew }
  })
}

async function checkCap(db: Db): Promise<void> {
  const cap = config.maxNewHostsPerWeek
  const issued = await issuedThisWeek(db)
  if (issued.length < cap) return
  // the count drops below the cap when the (count - cap + 1)-th oldest issue leaves the 7-day window
  const at = issued[issued.length - cap]
  const retryAfter = new Date((at?.getTime() ?? Date.now()) + WEEK_MS).toISOString()
  throw new HostError('new_host_cap',
    `This server has used its ${cap} new hostnames for this week, and this project would need a new one. ` +
      `A new hostname becomes available on ${retryAfter.slice(0, 16).replace('T', ' ')} UTC; until then, delete a project you do not use to free its hostname.`,
    { cap, retryAfter })
}

/** The slot stays (its certificate is kept) with no project; the project's default domain row goes. */
export async function releaseHost(db: Db, projectId: string): Promise<void> {
  await tx(db, async (c) => {
    await c.query('update control.host_slots set project_id = null where project_id = $1', [projectId])
    await c.query(`delete from control.project_domains where project_id = $1 and kind = 'default'`, [projectId])
  })
}

/**
 * A legacy or custom hostname for the project. Neither counts against the cap (no slot is made), so a name under
 * BASE_DOMAIN is accepted only when it already holds a certificate (LEGACY_HOSTNAMES).
 */
export async function addDomain(db: Db, projectId: string, hostname: string, kind: 'legacy' | 'custom'): Promise<void> {
  const h = hostname.trim().toLowerCase()
  if (!HOSTNAME_RE.test(h)) throw new HostError('invalid_hostname', `"${hostname}" is not a valid hostname. Use a name such as api.example.com.`)
  // a project router for these would steal Studio's or the test project's traffic
  const own = (name: string) => name.toLowerCase().replace(/\.$/, '')
  // hostname, not host: PUBLIC_URL may carry a port
  if (h === own(new URL(config.publicUrl).hostname) || h === own(config.testHost)) {
    throw new HostError('hostname_taken', `${h} is used by selfbase itself. Choose another hostname.`)
  }
  const base = config.baseDomain.toLowerCase()
  if (h === base || h.endsWith(`.${base}`)) {
    if (kind === 'custom') {
      throw new HostError('custom_under_base', `${h} is under ${base}, which selfbase manages itself. Use a hostname of your own domain.`)
    }
    if (!config.legacyHostnames.includes(h)) {
      throw new HostError('legacy_not_allowed',
        `${h} is under ${base} and has no certificate yet, so it would count as a new hostname. Request a host slot for the project instead.`)
    }
  }
  await tx(db, async (c) => {
    const taken = await c.query(
      'select 1 from control.project_domains where hostname = $1 union all select 1 from control.host_slots where hostname = $1', [h],
    )
    if (taken.rowCount) throw new HostError('hostname_taken', `${h} is already used by a project on this server. Choose another hostname.`)
    await c.query('insert into control.project_domains (project_id, hostname, kind) values ($1, $2, $3)', [projectId, h, kind])
  })
}

/** Removes a legacy or custom hostname; the default host goes only with releaseHost. True when a row went. */
export async function removeDomain(db: Db, projectId: string, hostname: string): Promise<boolean> {
  const r = await db.query(`delete from control.project_domains where project_id = $1 and hostname = $2 and kind <> 'default'`,
    [projectId, hostname.trim().toLowerCase()])
  return (r.rowCount ?? 0) > 0
}

/** Every hostname of the project, the default first. */
export async function hostsOf(db: Db, projectId: string): Promise<string[]> {
  const rows = (await db.query(
    `select hostname from control.project_domains where project_id = $1 order by kind <> 'default', hostname`, [projectId],
  )).rows
  return rows.map((r) => r.hostname)
}
