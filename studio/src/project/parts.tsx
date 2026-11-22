import { useState } from 'react'
import type { ReactNode } from 'react'
import { errMsg, platform } from '../api.ts'
import type { ApiKey } from '../api.ts'
import { ErrorBox, Loading, confirmDanger, toast } from '../ui.tsx'
import { CopyButton, JobSteps, StatusBadge, useLoad } from '../org/common.tsx'
import { useProject } from './context.ts'

// Pieces shared by the home and settings screens.

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card" aria-label={title}>
      <header className="card-head"><h2>{title}</h2><div className="spacer" />{actions}</header>
      <div className="card-body">{children}</div>
    </section>
  )
}

/** Starts a job-returning action and shows its steps; the project is reloaded when the job ends. */
export function useJob(onDone?: () => void) {
  const { reload } = useProject()
  const [jobId, setJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const start = async (call: () => Promise<{ job_id?: string }>) => {
    setBusy(true)
    try {
      const r = await call()
      if (r.job_id) setJobId(r.job_id)
      else reload()
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const steps = jobId && <JobSteps key={jobId} jobId={jobId} onDone={() => { reload(); onDone?.() }} />
  return { start, busy, steps }
}

/** Pause or restore, whichever fits the status; rendered only for roles with project.manage. */
export function Lifecycle() {
  const { ref, project, can } = useProject()
  const job = useJob()
  if (!can('project.manage')) return null
  const paused = project.status === 'INACTIVE'
  const pause = async () => {
    if (!(await confirmDanger('Proje duraklatılsın mı?', <><code>{project.name}</code> durdurulur; API ve veritabanı devam ettirilene kadar yanıt vermez.</>, 'Duraklat'))) return
    job.start(() => platform.pause(ref))
  }
  return (
    <div className="job">
      <div>
        {paused
          ? <button className="btn primary" disabled={job.busy} onClick={() => job.start(() => platform.restore(ref))}>Devam ettir</button>
          : <button className="btn" disabled={job.busy} onClick={pause}>Duraklat</button>}
      </div>
      {job.steps}
    </div>
  )
}

export const JOB_STATUS: Record<string, string> = { pending: 'bekliyor', running: 'sürüyor', succeeded: 'tamamlandı', failed: 'başarısız' }

/** Shown instead of a data screen whenever the project is not ACTIVE_HEALTHY (paused or in transition). */
export function Paused() {
  const { project, reload } = useProject()
  const inactive = project.status === 'INACTIVE'
  return (
    <section className="page-main">
      <div className="scroll-area">
        <div className="card paused">
          <div className="card-head">
            <h2>{inactive ? 'Proje duraklatıldı' : 'Proje şu an kullanılamıyor'}</h2>
            <StatusBadge status={project.status} />
          </div>
          <div className="card-body">
            <p className="muted">
              Bu ekran projenin servisleriyle çalışır. {inactive ? 'Proje devam ettirilince yeniden açılır.' : 'Proje hazır olunca yeniden açılır.'}
            </p>
            {inactive ? <Lifecycle /> : <div><button className="btn" onClick={reload}>Durumu yenile</button></div>}
          </div>
        </div>
      </div>
    </section>
  )
}

const KEY_LABEL: Record<ApiKey['name'], string> = { anon: 'anon (herkese açık)', service_role: 'service_role (gizli)' }

/** anon in full with a copy button; service_role masked until "göster" asks control to reveal it. */
export function ApiKeys() {
  const { ref, can } = useProject()
  const { data, error, reload } = useLoad(() => platform.apiKeys(ref), [ref])
  const [shown, setShown] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const reveal = async () => {
    setBusy(true)
    try { setShown((await platform.revealKey(ref, 'service_role')).api_key) } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  if (error) return <ErrorBox message={error} onRetry={reload} />
  if (!data) return <Loading />
  return (
    <dl className="kv">
      {data.map((k) => {
        const secret = k.name === 'service_role'
        const value = secret ? shown ?? k.api_key : k.api_key
        return (
          <div key={k.name}>
            <dt>{KEY_LABEL[k.name] ?? k.name}</dt>
            <dd className="secret-row">
              <code aria-label={`${k.name} anahtarı`}>{value}</code>
              {!secret && <CopyButton text={value} />}
              {secret && shown && <><CopyButton text={shown} /><button className="btn sm" onClick={() => setShown(null)}>gizle</button></>}
              {secret && !shown && can('project.keys') && <button className="btn sm" disabled={busy} onClick={reveal}>göster</button>}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
