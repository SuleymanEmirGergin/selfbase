import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { errMsg, platform } from '../api.ts'
import type { Job, OrgRef, Size } from '../api.ts'
import { Copy, Icon, Status, errText } from '../ui.tsx'
import type { Tone } from '../ui.tsx'
import { has, t } from '../i18n/index.ts'
import type { Key } from '../i18n/index.ts'

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

const TONE: Record<string, Tone> = {
  ACTIVE_HEALTHY: 'ok', COMING_UP: 'warn', INACTIVE: 'mute', RESTORING: 'warn', UPGRADING: 'warn',
  ACTIVE_UNHEALTHY: 'err', REMOVED: 'mute', INIT_FAILED: 'err', RESTORE_FAILED: 'err', REMOVE_FAILED: 'err',
}
export const statusTone = (status: string): Tone => TONE[status] ?? 'mute'
/** The status in the current language; an unknown one (a newer server) as it came. */
export const statusLabel = (status: string) => { const k = `status.${status}`; return has(k) ? t(k) : status }
export function StatusBadge({ status }: { status: string }) {
  const tone = statusTone(status)
  return <Status tone={tone} live={tone === 'ok' || tone === 'warn'} title={status}>{statusLabel(status)}</Status>
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

  if (!job) return error ? <div className="error-box" role="alert">{errText(error)}</div> : <div className="muted small">{t('job.starting')}</div>
  return (
    <div className="job">
      <ol className="steps" aria-label={t('job.steps')}>
        {job.steps.map((s, i) => {
          const state = job.status === 'succeeded' || i < job.step ? 'done' : i === job.step ? (job.status === 'failed' ? 'failed' : 'running') : 'waiting'
          return (
            <li key={s} className={`step ${state}`} aria-current={state === 'running' ? 'step' : undefined}>
              <span className="sic" aria-hidden="true">
                <Icon name={{ done: 'check', running: 'spinner', failed: 'close', waiting: 'dashed' }[state]} size={state === 'done' ? 12 : 15}
                  weight={state === 'done' ? 'bold' : undefined} />
              </span>
              {/* the step in words first; the raw id after it, small, for whoever reads the server logs */}
              <span className="t">{has(`step.${s}`) ? <><b>{t(`step.${s}` as Key)}</b><small className="mono">{s}</small></> : <b className="mono">{s}</b>}</span>
              <span className="sr-only">{t(`job.${state}`)}</span>
            </li>
          )
        })}
      </ol>
      {job.status === 'failed' && <div className="error-box" role="alert">{job.error || t('job.failedMsg')}</div>}
      {error && <div className="muted small">{errText(error)}</div>}
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
