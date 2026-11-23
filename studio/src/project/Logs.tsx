import { useState } from 'react'
import { platform } from '../api.ts'
import type { LogService } from '../api.ts'
import { Empty, ErrorBox, Icon, Loading } from '../ui.tsx'
import { useLoad } from '../org/common.tsx'
import { useProject } from './context.ts'
import { fmtDate, t } from '../i18n/index.ts'

const SERVICES: LogService[] = ['core', 'db', 'rest', 'fn', 'pooler']
const LIMIT = 200

export default function Logs() {
  const { ref } = useProject()
  const [service, setService] = useState<LogService>('core')
  const { data, error, reload } = useLoad(() => platform.logs(ref, service, LIMIT), [ref, service])
  return (
    <section className="page-main">
      <div className="toolbar">
        <h1 className="title">{t('nav.logs')}</h1>
        <div className="spacer" />
        <label className="field inline">
          <span>{t('logs.service')}</span>
          <select value={service} onChange={(e) => setService(e.target.value as LogService)}>
            {SERVICES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <button className="icon-btn" onClick={reload} aria-label={t('common.refresh')} title={t('common.refresh')}><Icon name="refresh" /></button>
      </div>
      <div className="scroll-area">
        {data?.fromContainer && (
          <div className="note log-note" role="note">{t('logs.fallback')}</div>
        )}
        {error ? <ErrorBox message={error} onRetry={reload} />
          : !data ? <Loading />
          : !data.lines.length ? <Empty>{t('logs.none')}</Empty>
          : (
            <ol className="log-lines" aria-label={t('logs.of', { service })}>
              {data.lines.map((l, i) => (
                <li key={i}><time className="muted" dateTime={l.ts}>{fmtDate(l.ts, 'medium')}</time><span>{l.msg}</span></li>
              ))}
            </ol>
          )}
        {data && <p className="muted small">{t('logs.limit', { n: LIMIT })}</p>}
      </div>
    </section>
  )
}
