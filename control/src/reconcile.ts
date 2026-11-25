// Reconcile loop (spec 7.6): every 30 s and on requestReconcile(), desired state in control-db is compared with
// what the provisioner reports. A project with a pending or running job is left to that job. Objects named sb-*
// whose ref has no project row are reported, never removed.
import type pg from 'pg'
import { probeCertificate } from './cert.ts'
import { config } from './config.ts'
import { hostsOf, RELEASE_HELD } from './hosts.ts'
import { DESIRED_RUNNING, enqueueIfIdle, type Project } from './jobs/index.ts'
import { restoreUnresolved, sessionsUnconfirmed } from './jobs/project.ts'
import { RESTORE_STOPS } from './jobs/transfer.ts'
import type { Provisioner, ProjectState } from './provisioner.ts'

export type ReconcileDeps = { db: pg.Pool; provisioner: Provisioner; probe?: (hostname: string) => Promise<'ok' | 'pending'> }
export type ReconcileReport = { checked: string[]; skipped: string[]; actions: { ref: string; action: string }[]
  orphans: string[]; errors: { ref: string; message: string }[] }

const INTERVAL_MS = 30_000
const BUSY = `exists (select 1 from control.jobs j where j.project_id = p.id and j.status in ('pending', 'running'))`
// reconcile's own applies (created_by null; $2: project.apply, or project.contain): a project whose apply keeps failing
// or whose service keeps dying (an image gone after Coolify's cleanup, a crash loop) is retried after 1, 2, 4 ... 60
// minutes, not on every 30 s pass
const RECENT_APPLIES = `select count(*)::int as n, max(updated_at) as last from control.jobs
  where project_id = $1 and type = $2 and created_by is null and created_at > now() - interval '6 hours'`
const backoffMs = (n: number) => Math.min(60_000 * 2 ** (n - 1), 3_600_000)
// finished applies reconcile made are history nobody reads after a week: the job table stays bounded. A failed release
// apply stays while it holds its name (hosts.ts refuses the name on it)
const PRUNE = `delete from control.jobs j where type in ('project.apply', 'project.contain') and created_by is null
  and status in ('succeeded', 'failed') and created_at < now() - interval '7 days' and not (${RELEASE_HELD})`
// audit retention: 90 days
const PRUNE_AUDIT = `delete from control.audit_log where at < now() - interval '90 days'`
// exports are listed for EXPORT_RETENTION_DAYS; their files go by the same rule, through the nightly project.prune
// (schedule.ts), a deleted project's too
const PRUNE_EXPORTS = `delete from control.backups where location like 'export-%'
  and coalesce(finished_at, started_at) < now() - make_interval(days => $1)`

export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileReport> {
  const probe = deps.probe ?? probeCertificate
  const report: ReconcileReport = { checked: [], skipped: [], actions: [], orphans: [], errors: [] }
  await deps.db.query(PRUNE)
  await deps.db.query(PRUNE_AUDIT)
  await deps.db.query(PRUNE_EXPORTS, [config.exportRetentionDays])
  const projects = (await deps.db.query(
    `select p.*, ${BUSY} as busy from control.projects p`,
  )).rows as (Project & { busy: boolean })[]
  const known = new Set(projects.map((p) => p.ref))
  for (const { ref } of await deps.provisioner.list()) if (!known.has(ref)) report.orphans.push(ref)

  for (const p of projects) {
    if (p.status === 'REMOVED') continue
    if (p.busy) { report.skipped.push(p.ref); continue }
    const act = (action: string) => report.actions.push({ ref: p.ref, action })
    // the pass reads state once; a job may have changed the project since, so every action checks again first
    const still = async (statuses: string[]) => {
      const r = (await deps.db.query(`select status, ${BUSY} as busy from control.projects p where id = $1`, [p.id])).rows[0]
      return !!r && !r.busy && statuses.includes(r.status)
    }
    const setStatus = async (status: string) => {
      const r = await deps.db.query(`update control.projects p set status = $2 where id = $1 and status = $3 and not ${BUSY}`,
        [p.id, status, p.status])
      if (r.rowCount) act(`status ${status}`)
    }
    const backoff = async (type = 'project.apply') => {
      const recent = (await deps.db.query(RECENT_APPLIES, [p.id, type])).rows[0]
      return recent.n && Date.now() - new Date(recent.last).getTime() < backoffMs(recent.n)
    }
    try {
      const s: ProjectState = await deps.provisioner.inspect(p.ref)
      report.checked.push(p.ref)
      // what a failed import's onFail stopped, unless the provisioner was down then (or someone started it since): an
      // import that failed in its restore (any outcome) keeps all five stopped, as its database may hold anything,
      // until the owner deletes the project (or pauses and resumes it, which runs whatever the database holds); a
      // rotating import that failed before its sessions were confirmed deleted (I1) keeps the four stopped. Both stop
      // through one project.contain job, so a failed stop backs off; a pass says nothing once they are stopped
      if ((p.status === 'INIT_FAILED' && s.services.some((x) => x.state === 'running') && await restoreUnresolved(deps.db, p.id))
        || (s.services.some((x) => RESTORE_STOPS.includes(x.service) && x.state === 'running') && await sessionsUnconfirmed(deps.db, p.id))) {
        if (await backoff('project.contain')) { act('backoff'); continue }
        if (await still([p.status])
          && await enqueueIfIdle(deps.db, { type: 'project.contain', projectId: p.id, payload: {}, createdBy: null })) act('contain')
        continue
      }
      if (p.status === 'INACTIVE') {
        if (s.services.some((x) => x.state === 'running') && await still(['INACTIVE'])) { await deps.provisioner.stop(p.ref); act('stop') }
        continue
      }
      // other statuses (INIT_FAILED, *_FAILED, ...) wait for the operator
      if (!DESIRED_RUNNING.includes(p.status)) continue
      // a release apply that failed leaves the evicted name on the router: core is recreated without it, as it would have
      if ((await deps.db.query(`select 1 from control.jobs j where j.project_id = $1 and ${RELEASE_HELD}`, [p.id])).rowCount) {
        if (await backoff()) { act('backoff'); continue }
        if (await still(DESIRED_RUNNING)
          && await enqueueIfIdle(deps.db, { type: 'project.apply', projectId: p.id, payload: { recreate: ['core'] }, createdBy: null })) act('apply release')
        continue
      }
      const drift = !s.network || s.services.some((x) => !x.exists || x.state !== 'running' || x.templateVersion !== p.template_version
        || x.proxyStale)
      if (drift || !s.controlAttached) {
        // a service that is missing, exited or restarting: the project is not healthy, whatever the apply does next
        if (s.services.some((x) => !x.exists || x.state !== 'running') && p.status !== 'ACTIVE_UNHEALTHY') await setStatus('ACTIVE_UNHEALTHY')
        if (await backoff()) { act('backoff'); continue }
        if (await still(DESIRED_RUNNING)
          && await enqueueIfIdle(deps.db, { type: 'project.apply', projectId: p.id, payload: { recreate: [] }, createdBy: null })) act('apply')
        continue
      }
      if (s.services.some((x) => x.service === 'core' && !x.proxyAttached) && await still(DESIRED_RUNNING)) {
        await deps.provisioner.attachProxy(p.ref)
        act('attachProxy')
      }
      const healthy = s.services.every((x) => x.health === null || x.health === 'healthy')
      const host = (await hostsOf(deps.db, p.id))[0]
      const cert = host ? await probe(host) : 'pending'
      const want = !healthy ? 'ACTIVE_UNHEALTHY' : cert === 'ok' ? 'ACTIVE_HEALTHY' : 'COMING_UP'
      if (want !== p.status) await setStatus(want)
    } catch (e) {
      report.errors.push({ ref: p.ref, message: (e as Error).message })
    }
  }
  return report
}

let wake: (() => void) | undefined

/** Runs a pass now (or right after the current one). */
export function requestReconcile(): void {
  wake?.()
}

export function startReconcile(deps: ReconcileDeps): { stop(): Promise<void> } {
  let stopping = false
  const done = (async () => {
    while (!stopping) {
      try {
        const r = await reconcileOnce(deps)
        if (r.orphans.length) console.log(`reconcile: sb-* objects without a project: ${r.orphans.join(', ')}`)
        for (const e of r.errors) console.error(`reconcile ${e.ref}: ${e.message}`)
      } catch (e) {
        console.error(`reconcile: ${(e as Error).message}`)
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, INTERVAL_MS)
        wake = () => { clearTimeout(t); r() }
      })
    }
  })()
  return {
    async stop() {
      stopping = true
      wake?.()
      await done
    },
  }
}
