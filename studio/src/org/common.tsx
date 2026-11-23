import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { errMsg, platform } from '../api.ts'
import type { Job, OrgRef, Size } from '../api.ts'
import { toast } from '../ui.tsx'

/** Organization screens get the current organization; `canManage` gates create, import and member actions. */
export type OrgProps = { org: OrgRef; canManage: boolean; email: string }

/** Loads once per `deps` change; a stale answer (deps changed meanwhile) is dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string }>({})
  const seq = useRef(0)
  const reload = useCallback(() => {
    const n = ++seq.current
    load().then((data) => n === seq.current && setState({ data }), (e) => n === seq.current && setState({ error: errMsg(e) }))
  }, deps)
  useEffect(reload, [reload])
  return { ...state, reload }
}

// MiB per service of each size (template/sizes.json, global constraints); shown before admission decides.
export const SIZES: Record<Size, Record<string, number>> = {
  micro: { db: 512, rest: 128, core: 256, fn: 256, pooler: 32 },
  small: { db: 1024, rest: 256, core: 512, fn: 512, pooler: 32 },
  medium: { db: 2048, rest: 256, core: 512, fn: 1024, pooler: 32 },
}
export const sizeMb = (s: Size) => Object.values(SIZES[s]).reduce((a, b) => a + b, 0)

const STATUS: Record<string, [string, string]> = {
  ACTIVE_HEALTHY: ['Çalışıyor', 'ok'],
  COMING_UP: ['Başlatılıyor', 'warn'],
  INACTIVE: ['Duraklatıldı', ''],
  RESTORING: ['Geri yükleniyor', 'warn'],
  UPGRADING: ['Güncelleniyor', 'warn'],
  ACTIVE_UNHEALTHY: ['Sorunlu', 'danger'],
  REMOVED: ['Silindi', ''],
  INIT_FAILED: ['KurulamadÄ±', 'danger'],
  RESTORE_FAILED: ['Devam ettirilemedi', 'danger'],
  REMOVE_FAILED: ['Silinemedi', 'danger'],
}
export function StatusBadge({ status }: { status: string }) {
  const [label, kind] = STATUS[status] ?? [status, '']
  return <span className={`badge ${kind}`} title={status}>{label}</span>
}

const STEP: Record<string, string> = {
  allocate: 'Ağ ve adres ayrılıyor',
  secrets: 'Anahtarlar üretiliyor',
  ensure: 'Konteynerler kuruluyor',
  healthy: 'Servislerin hazır olması bekleniyor',
  certificate: 'Sertifika bekleniyor',
  activate: 'Etkinleştiriliyor',
  stop: 'Servisler durduruluyor',
  restore: 'Yedek geri yükleniyor',
  start: 'Servisler başlatılıyor',
}

/** Polls a job every second until it ends; shows each step as done, running or waiting. */
export function JobSteps({ jobId, onDone }: { jobId: string; onDone?: (job: Job) => void }) {
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    let stopped = false
    let timer = 0
    const tick = async () => {
      try {
        const j = await platform.job(jobId)
        if (stopped) return
        setJob(j)
        setError('')
        if (j.status === 'succeeded' || j.status === 'failed') return done.current?.(j)
      } catch (e) {
        if (stopped) return
        setError(errMsg(e))
      }
      timer = window.setTimeout(tick, 1000)
    }
    tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [jobId])

  if (!job) return error ? <div className="error-box" role="alert">{error}</div> : <div className="muted small">İş başlatılıyor…</div>
  return (
    <div className="job">
      <ol className="steps" aria-label="Adımlar">
        {job.steps.map((s, i) => {
          const state = job.status === 'succeeded' || i < job.step ? 'done' : i === job.step ? (job.status === 'failed' ? 'failed' : 'running') : 'waiting'
          return (
            <li key={s} className={`step ${state}`} aria-current={state === 'running' ? 'step' : undefined}>
              <span className="step-mark" aria-hidden="true" />
              <span>{STEP[s] ?? s}</span>
              <span className="sr-only">{{ done: 'tamam', running: 'sürüyor', failed: 'başarısız', waiting: 'bekliyor' }[state]}</span>
            </li>
          )
        })}
      </ol>
      {job.status === 'failed' && <div className="error-box" role="alert">{job.error || 'İş başarısız oldu.'}</div>}
      {error && <div className="muted small">{error}</div>}
    </div>
  )
}

export function CopyButton({ text }: { text: string }) {
  const copy = () => navigator.clipboard.writeText(text).then(() => toast('Kopyalandı'), () => toast('Kopyalanamadı', 'error'))
  return <button type="button" className="btn sm" onClick={copy}>Kopyala</button>
}

/** Page frame used by every organization screen: a toolbar with the h1 and a scrolling body. */
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="page-main">
      <div className="toolbar">
        <h1 className="title">{title}</h1>
        <div className="spacer" />
        {actions}
      </div>
      <div className="scroll-area">{children}</div>
    </section>
  )
}
