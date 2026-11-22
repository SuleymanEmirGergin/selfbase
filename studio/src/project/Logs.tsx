import { useState } from 'react'
import { platform } from '../api.ts'
import type { LogService } from '../api.ts'
import { Empty, ErrorBox, Icon, Loading } from '../ui.tsx'
import { useLoad } from '../org/common.tsx'
import { useProject } from './context.ts'

const SERVICES: LogService[] = ['core', 'db', 'rest', 'fn', 'pooler']
const LIMIT = 200

const fmtTs = (ts: string) => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' })
}

export default function Logs() {
  const { ref } = useProject()
  const [service, setService] = useState<LogService>('core')
  const { data, error, reload } = useLoad(() => platform.logs(ref, service, LIMIT), [ref, service])
  return (
    <section className="page-main">
      <div className="toolbar">
        <h1 className="title">Günlükler</h1>
        <div className="spacer" />
        <label className="field inline">
          <span>Servis</span>
          <select value={service} onChange={(e) => setService(e.target.value as LogService)}>
            {SERVICES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <button className="icon-btn" onClick={reload} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>
      </div>
      <div className="scroll-area">
        {data?.fromContainer && (
          <div className="note log-note" role="note">Günlük deposuna ulaşılamadı; satırlar doğrudan konteynerden okundu (yalnızca son satırlar).</div>
        )}
        {error ? <ErrorBox message={error} onRetry={reload} />
          : !data ? <Loading />
          : !data.lines.length ? <Empty>Bu serviste günlük satırı yok.</Empty>
          : (
            <ol className="log-lines" aria-label={`${service} günlüğü`}>
              {data.lines.map((l, i) => (
                <li key={i}><time className="muted" dateTime={l.ts}>{fmtTs(l.ts)}</time><span>{l.msg}</span></li>
              ))}
            </ol>
          )}
        {data && <p className="muted small">Son {LIMIT} satır, en yenisi üstte.</p>}
      </div>
    </section>
  )
}
