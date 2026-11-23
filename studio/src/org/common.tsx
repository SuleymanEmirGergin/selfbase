import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { errMsg, platform } from '../api.ts'
import type { Job, OrgRef, Size } from '../api.ts'
import { Copy, Icon, Status } from '../ui.tsx'
import type { Tone } from '../ui.tsx'

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

const STATUS: Record<string, [string, Tone]> = {
  ACTIVE_HEALTHY: ['Çalışıyor', 'ok'],
  COMING_UP: ['Başlatılıyor', 'warn'],
  INACTIVE: ['Duraklatıldı', 'mute'],
  RESTORING: ['Geri yükleniyor', 'warn'],
  UPGRADING: ['Güncelleniyor', 'warn'],
  ACTIVE_UNHEALTHY: ['Sorunlu', 'err'],
  REMOVED: ['Silindi', 'mute'],
  INIT_FAILED: ['Kurulamadı', 'err'],
  RESTORE_FAILED: ['Devam ettirilemedi', 'err'],
  REMOVE_FAILED: ['Silinemedi', 'err'],
}
export const statusTone = (status: string): Tone => STATUS[status]?.[1] ?? 'mute'
export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, 'mute']
  return <Status tone={tone} live={tone === 'ok' || tone === 'warn'} title={status}>{label}</Status>
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
              <span className="sic" aria-hidden="true">
                <Icon name={{ done: 'check', running: 'spinner', failed: 'close', waiting: 'dashed' }[state]} size={state === 'done' ? 12 : 15}
                  weight={state === 'done' ? 'bold' : undefined} />
              </span>
              <span className="t"><b>{s}</b><small>{STEP[s] ?? s}</small></span>
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

export const CopyButton = ({ text }: { text: string }) => <Copy text={text} />

/** Page frame used by every organization and project screen: the page header and a scrolling body. */
export function Page({ title, aside, meta, actions, children }: {
  title: ReactNode; aside?: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode
}) {
  return (
    <section className="page-main">
      <div className="scroll-area">
        <header className="pghead">
          <div className="pgtitle">
            <h1>{title}{aside && <span className="serif"> · {aside}</span>}</h1>
            {meta && <div className="metaline">{meta}</div>}
          </div>
          {actions && <div className="act">{actions}</div>}
        </header>
        {children}
      </div>
    </section>
  )
}
