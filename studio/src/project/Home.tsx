import type { ServiceState } from '../api.ts'
import { Icon } from '../ui.tsx'
import { CopyButton, Page, StatusBadge } from '../org/common.tsx'
import { useProject } from './context.ts'
import { ApiKeys, JOB_STATUS, Lifecycle, Section } from './parts.tsx'

const healthBadge = (s: ServiceState) =>
  !s.exists ? <span className="badge danger">yok</span>
    : s.state !== 'running' ? <span className="badge">{s.state}</span>
    : s.health === 'healthy' || s.health === 'none' ? <span className="badge ok">sağlıklı</span>
    : s.health === 'starting' ? <span className="badge warn">başlıyor</span>
    : <span className="badge danger">{s.health}</span>


export default function Home() {
  const { project: p, reload } = useProject()
  const job = p.last_job
  return (
    <Page title="Ana sayfa" actions={<button className="icon-btn" onClick={reload} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>}>
      <Section title="Durum">
        <div className="badges">
          <StatusBadge status={p.status} />
          <span className="badge">{p.size}</span>
          {p.certificate === 'pending' && <span className="badge warn">sertifika bekleniyor</span>}
        </div>
        {p.status === 'INACTIVE' && <Lifecycle />}
      </Section>

      <Section title="Adresler">
        <dl className="kv">
          <div>
            <dt>API adresi</dt>
            <dd className="secret-row"><code>{p.urls.api}</code><CopyButton text={p.urls.api} /></dd>
          </div>
          {p.urls.legacy.length > 0 && (
            <div>
              <dt>Eski adresler</dt>
              {p.urls.legacy.map((u) => <dd key={u} className="secret-row"><code>{u}</code><CopyButton text={u} /></dd>)}
            </div>
          )}
        </dl>
      </Section>

      <Section title="API anahtarları"><ApiKeys /></Section>

      <Section title="Servisler">
        <div className="grid-wrap">
          <table className="grid list-table">
            <thead>
              <tr>
                <th><div className="th-btn">Servis</div></th>
                <th><div className="th-btn">Durum</div></th>
                <th><div className="th-btn">Bellek</div></th>
              </tr>
            </thead>
            <tbody>
              {p.services.map((s) => (
                <tr key={s.service}>
                  <td className="mono">{s.service}</td>
                  <td className="badges">{healthBadge(s)}</td>
                  <td className="small">{s.memUsageMb != null ? `${s.memUsageMb} / ${s.memLimitMb} MiB` : `— / ${s.memLimitMb} MiB`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Son iş">
        {!job ? <p className="muted">Henüz iş yok.</p> : (
          <dl className="kv">
            <div><dt>Tür</dt><dd className="mono">{job.type}</dd></div>
            <div><dt>Durum</dt><dd>{JOB_STATUS[job.status] ?? job.status}{job.status !== 'succeeded' && ` · adım ${job.step + 1}`}</dd></div>
            {job.error && <div><dt>Hata</dt><dd className="field-error">{job.error}</dd></div>}
          </dl>
        )}
      </Section>
    </Page>
  )
}
