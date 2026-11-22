// Reconcile loop (spec 7.6): every 30 s and on requestReconcile(), desired state in control-db is compared with
// what the provisioner reports. A project with a pending or running job is left to that job. Objects named sb-*
// whose ref has no project row are reported, never removed.
import type pg from 'pg'
import { probeCertificate } from './cert.ts'
import { hostsOf } from './hosts.ts'
import { enqueue, type Project } from './jobs/index.ts'
import type { Provisioner, ProjectState } from './provisioner.ts'

export type ReconcileDeps = { db: pg.Pool; provisioner: Provisioner; probe?: (hostname: string) => Promise<'ok' | 'pending'> }
export type ReconcileReport = { checked: string[]; skipped: string[]; actions: { ref: string; action: string }[]
  orphans: string[]; errors: { ref: string; message: string }[] }

const RUNNING = ['ACTIVE_HEALTHY', 'ACTIVE_UNHEALTHY', 'COMING_UP']
const INTERVAL_MS = 30_000

export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileReport> {
  const probe = deps.probe ?? probeCertificate
  const report: ReconcileReport = { checked: [], skipped: [], actions: [], orphans: [], errors: [] }
  const projects = (await deps.db.query(
    `select p.*, exists (select 1 from control.jobs j where j.project_id = p.id and j.status in ('pending', 'running')) as busy
     from control.projects p`,
  )).rows as (Project & { busy: boolean })[]
  const known = new Set(projects.map((p) => p.ref))
  for (const { ref } of await deps.provisioner.list()) if (!known.has(ref)) report.orphans.push(ref)

  for (const p of projects) {
    if (p.status === 'REMOVED') continue
    if (p.busy) { report.skipped.push(p.ref); continue }
    const act = (action: string) => report.actions.push({ ref: p.ref, action })
    const setStatus = async (status: string) => {
      await deps.db.query('update control.projects set status = $2 where id = $1 and status = $3', [p.id, status, p.status])
      act(`status ${status}`)
    }
    try {
      const s: ProjectState = await deps.provisioner.inspect(p.ref)
      report.checked.push(p.ref)
      if (p.status === 'INACTIVE') {
        if (s.services.some((x) => x.state === 'running')) { await deps.provisioner.stop(p.ref); act('stop') }
        continue
      }
      // other statuses (INIT_FAILED, *_FAILED, ...) wait for the operator
      if (!RUNNING.includes(p.status)) continue
      const drift = !s.network || s.services.some((x) => !x.exists || x.state !== 'running' || x.templateVersion !== p.template_version)
      if (drift || !s.controlAttached) {
        await enqueue(deps.db, { type: 'project.apply', projectId: p.id, payload: { recreate: [] }, createdBy: null })
        act('apply')
        continue
      }
      if (s.services.some((x) => x.service === 'core' && !x.proxyAttached)) { await deps.provisioner.attachProxy(p.ref); act('attachProxy') }
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
