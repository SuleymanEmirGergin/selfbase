// Hostnames are scarce on sslip.io (spec 7.3, AC-33): a host, once certified, is kept as a host_slots row and
// reused; at most MAX_NEW_HOSTS_PER_WEEK new ones are made in any 7 days, the control host included.
import pg from 'pg'
import { config, HOSTNAME_RE } from './config.ts'
import type { Db } from './db.ts'
import { ApiError } from './errors.ts'

type HostCode = 'new_host_cap' | 'test_host_busy' | 'custom_under_base' | 'legacy_not_allowed' | 'hostname_taken' | 'invalid_hostname'
  | 'wildcard_dns_refused'

// Wildcard-IP DNS services answer any name with the address written in it (dotted, dashed, hex, ...): every such name
// draws on the same registered-domain certificate quota the weekly cap protects, so none may be added by hand.
const WILDCARD_DNS = ['sslip.io', 'nip.io', 'xip.io', 'traefik.me']
export const isWildcardDns = (h: string) => WILDCARD_DNS.some((d) => h === d || h.endsWith(`.${d}`))

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
// shortcut: a custom name another org removed is held this long (DNS that still points here would hand that org's
// traffic to the next claimant); there is no operator release yet. Upgrade to a DNS TXT proof or an operator release.
const DOMAIN_HOLD = '30 days'

/** The org of a project, with its slug. */
const orgOf = async (db: Db, projectId: string): Promise<{ id: string; slug: string }> =>
  (await db.query('select o.id, o.slug from control.projects p join control.organizations o on o.id = p.org_id where p.id = $1',
    [projectId])).rows[0] ?? (() => { throw new Error(`project ${projectId} not found`) })()
export const legacyOrgOf = (h: string) => config.legacyOrgs[h] ?? 'default'

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
     union all
     select first_issued_at from control.issued_hosts where first_issued_at > now() - interval '7 days'
     order by 1`,
  )).rows
  return rows.map((r) => r.at as Date)
}

export async function newHostsThisWeek(db: Db): Promise<number> {
  return (await issuedThisWeek(db)).length
}

/**
 * Gives the project its default hostname: a free slot of the pool that its own org released first, else a new host
 * within the weekly cap. A project that already holds a slot gets it back (`isNew: false`), so a retried step changes
 * nothing. A slot is never handed to another org: the cost is fewer certificates reused across orgs.
 */
export async function allocateHost(db: Db, p: { projectId: string; ref: string; pool: 'project' | 'test' }): Promise<{ hostname: string; isNew: boolean }> {
  return tx(db, async (c) => {
    const held = (await c.query('select hostname from control.host_slots where project_id = $1', [p.projectId])).rows[0]
    if (held) return { hostname: held.hostname as string, isNew: false }

    const org = await orgOf(c, p.projectId)
    const free = (await c.query(
      'select id, hostname from control.host_slots where pool = $1 and project_id is null and org_id = $2 order by hostname limit 1',
      [p.pool, org.id],
    )).rows[0]
    let hostname: string
    let isNew = false
    if (free) {
      hostname = free.hostname
      await c.query('update control.host_slots set project_id = $1 where id = $2', [p.projectId, free.id])
    } else {
      hostname = p.pool === 'test' ? config.testHost : `${p.ref}.${config.baseDomain}`
      if (p.pool === 'test' && (await c.query('select 1 from control.host_slots where hostname = $1', [hostname])).rowCount) {
        throw new HostError('test_host_busy',
          `The test host ${hostname} is in use by another project, or belongs to another organization. Delete that project first, then try again.`)
      }
      await checkCap(c)
      await c.query(`insert into control.host_slots (hostname, pool, project_id, first_issued_at, org_id) values ($1, $2, $3, now(), $4)`,
        [hostname, p.pool, p.projectId, org.id])
      isNew = true
    }
    await c.query(`insert into control.project_domains (project_id, hostname, kind) values ($1, $2, 'default')`, [p.projectId, hostname])
    return { hostname, isNew }
  })
}

/** A create that would need a new hostname past the cap is refused in the request (spec 7.3); allocate checks again. */
export async function precheckHost(db: Db, pool: 'project' | 'test', orgId: string): Promise<void> {
  if ((await db.query('select 1 from control.host_slots where pool = $1 and project_id is null and org_id = $2 limit 1', [pool, orgId])).rowCount) return
  await checkCap(db)
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

/**
 * A release apply (evictStaleLegacyNames) whose name the router may still serve: it has not succeeded, and no later
 * apply, restore or delete of its project has. Over `control.jobs j`. Reconcile retries these (reconcile.ts).
 */
export const RELEASE_HELD = `j.type = 'project.apply' and j.payload ? 'released' and j.status <> 'succeeded'
  and not exists (select 1 from control.jobs k where k.project_id = j.project_id and k.status = 'succeeded'
                    and k.type in ('project.apply', 'project.restore', 'project.delete') and k.created_at > j.created_at)`

/** The slot stays (its certificate is kept) with no project and its org (a tombstone); the default domain row goes. */
export async function releaseHost(db: Db, projectId: string): Promise<void> {
  await tx(db, async (c) => {
    await c.query('update control.host_slots set project_id = null where project_id = $1', [projectId])
    await c.query(`delete from control.project_domains where project_id = $1 and kind = 'default'`, [projectId])
  })
}

/**
 * A legacy or custom hostname for the project. A name under BASE_DOMAIN is accepted only when it already holds a
 * certificate (LEGACY_HOSTNAMES); any other name gets one from the resolver, so it counts against the weekly cap the
 * first time it is added (control.issued_hosts). Wildcard-IP DNS names are refused outside BASE_DOMAIN.
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
  const underBase = h === base || h.endsWith(`.${base}`)
  if (!underBase && isWildcardDns(h)) {
    throw new HostError('wildcard_dns_refused', `${h} is a wildcard-IP DNS name; its certificate would draw on this server's shared quota. Use a hostname of your own domain.`)
  }
  const org = await orgOf(db, projectId)
  const listed = config.legacyHostnames.includes(h)
  if (listed && legacyOrgOf(h) !== org.slug) {
    throw new HostError('legacy_not_allowed', `${h} belongs to another organization on this server. Choose another hostname.`)
  }
  if (underBase) {
    if (kind === 'custom') {
      throw new HostError('custom_under_base', `${h} is under ${base}, which selfbase manages itself. Use a hostname of your own domain.`)
    }
    if (!listed) {
      throw new HostError('legacy_not_allowed',
        `${h} is under ${base} and has no certificate yet, so it would count as a new hostname. Request a host slot for the project instead.`)
    }
  }
  await tx(db, async (c) => {
    const taken = await c.query(
      'select 1 from control.project_domains where hostname = $1 union all select 1 from control.host_slots where hostname = $1', [h],
    )
    if (taken.rowCount) throw new HostError('hostname_taken', `${h} is already used by a project on this server. Choose another hostname.`)
    // the tombstone of a name evicted at start (evictStaleLegacyNames): held until its project's router is rebuilt
    // without it, by that apply or a later apply, restore or delete of the project
    const releasing = await c.query(`select 1 from control.jobs j where j.payload->>'released' = $1 and ${RELEASE_HELD}`, [h])
    if (releasing.rowCount) {
      throw new HostError('hostname_taken', `${h} is being released from another project on this server. Try again in a few minutes.`)
    }
    if (!listed) {
      const issued = (await c.query(
        `select org_id, released_at is not null and released_at < now() - $2::interval as expired from control.issued_hosts where hostname = $1`,
        [h, DOMAIN_HOLD])).rows[0]
      if (!issued) {
        await checkCap(c)
        await c.query('insert into control.issued_hosts (hostname, org_id) values ($1, $2)', [h, org.id])
      } else {
        // a name added before (its certificate exists) is not new again; another org's only once its hold is over
        if (issued.org_id !== org.id && !issued.expired) {
          throw new HostError('hostname_taken', `${h} was used by another organization on this server less than ${DOMAIN_HOLD} ago. Choose another hostname.`)
        }
        await c.query('update control.issued_hosts set org_id = $2, released_at = null where hostname = $1', [h, org.id])
      }
    }
    await c.query('insert into control.project_domains (project_id, hostname, kind) values ($1, $2, $3)', [projectId, h, kind])
  })
}

/**
 * The job-side guard before ensure: a host reaches the proxy with the resolver only when it was counted (a slot, an
 * issued host) or is a LEGACY_HOSTNAMES name, and never a wildcard-IP DNS name outside BASE_DOMAIN.
 */
export async function assertRoutable(db: Db, projectId: string, hosts: string[]): Promise<void> {
  const base = config.baseDomain.toLowerCase()
  const org = await orgOf(db, projectId)
  // issued hosts of the project's own org only: a name claimed by another org never routes here
  const counted = new Set((await db.query(
    `select hostname from control.host_slots where project_id = $1 union all select hostname from control.issued_hosts where org_id = $2`,
    [projectId, org.id],
  )).rows.map((r) => r.hostname))
  for (const h of hosts) {
    const underBase = h === base || h.endsWith(`.${base}`)
    if (!underBase && isWildcardDns(h)) throw new Error(`${h} is a wildcard-IP DNS name outside ${base}`)
    // the binding first, as addDomain checks it: an issued_hosts row of this org does not outrank LEGACY_HOSTNAMES
    if (config.legacyHostnames.includes(h)) {
      if (legacyOrgOf(h) !== org.slug) throw new Error(`${h} is a legacy hostname of another organization`)
      continue
    }
    if (!counted.has(h)) {
      throw new Error(`${h} holds no host slot, was never counted as a new host of this organization and is not a legacy hostname`)
    }
  }
}

/** Removes a legacy or custom hostname; the default host goes only with releaseHost. True when a row went. */
export async function removeDomain(db: Db, projectId: string, hostname: string): Promise<boolean> {
  const r = await db.query(
    `with gone as (delete from control.project_domains where project_id = $1 and hostname = $2 and kind <> 'default' returning hostname),
          held as (update control.issued_hosts set released_at = now() where hostname in (select hostname from gone))
     select 1 from gone`, [projectId, hostname.trim().toLowerCase()])
  return (r.rowCount ?? 0) > 0
}

/** A deleted project's legacy and custom names: their hold starts (DOMAIN_HOLD), then the rows go. */
export async function releaseDomains(db: Db, projectId: string): Promise<void> {
  await db.query(
    `with gone as (delete from control.project_domains where project_id = $1 returning hostname)
     update control.issued_hosts set released_at = now() where hostname in (select hostname from gone)`, [projectId])
}

/** Every hostname of the project, the default first. */
export async function hostsOf(db: Db, projectId: string): Promise<string[]> {
  const rows = (await db.query(
    `select hostname from control.project_domains where project_id = $1 order by kind <> 'default', hostname`, [projectId],
  )).rows
  return rows.map((r) => r.hostname)
}
