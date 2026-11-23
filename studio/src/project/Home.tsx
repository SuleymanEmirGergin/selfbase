import type { ServiceState } from '../api.ts'
import { Dots, Icon, Status } from '../ui.tsx'
import type { Tone } from '../ui.tsx'
import { CopyButton, Page, StatusBadge } from '../org/common.tsx'
import { nf } from '../lib/format.ts'
import { useProject } from './context.ts'
import { ApiKeys, JOB_STATUS, Lifecycle, Section } from './parts.tsx'

const health = (s: ServiceState): [string, Tone] =>
  !s.exists ? ['yok', 'err']
    : s.state !== 'running' ? [s.state, 'mute']
    : s.health === 'healthy' || s.health === 'none' ? ['sağlıklı', 'ok']
    : s.health === 'starting' ? ['başlıyor', 'warn']
    : [s.health, 'err']

const SERVICE: Record<string, { label: string; icon: string }> = {
  db: { label: 'Postgres', icon: 'g-postgres' },
  rest: { label: 'REST API', icon: 'g-rest' },
  core: { label: 'Auth · Storage · Realtime', icon: 'g-auth' },
  fn: { label: 'Fonksiyonlar', icon: 'g-fn' },
  pooler: { label: 'Bağlantı havuzu', icon: 'flow' },
}

// Architecture sketch: positions in % of the canvas; nodes and their states come from the real service list.
const NODES: Record<string, [number, number]> = { app: [11, 50], core: [36, 50], rest: [62, 24], fn: [62, 76], db: [87, 36], pooler: [87, 78] }
const EDGES = [['app', 'core'], ['core', 'rest'], ['core', 'fn'], ['rest', 'db'], ['fn', 'db'], ['pooler', 'db']]

function Architecture({ services }: { services: ServiceState[] }) {
  const has = (n: string) => n === 'app' || services.some((s) => s.service === n)
  const curve = ([a, b]: string[]) => {
    const [[x1, y1], [x2, y2]] = [NODES[a], NODES[b]]
    const mx = (x1 + x2) / 2
    return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
  }
  return (
    <div className="canvas" role="img" aria-label={`Mimari: ${services.map((s) => `${s.service} ${health(s)[0]}`).join(', ')}`}>
      <svg className="edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {EDGES.filter((e) => e.every(has)).map((e) => <path key={e.join('-')} d={curve(e)} />)}
      </svg>
      <div className="node" style={{ left: `${NODES.app[0]}%`, top: `${NODES.app[1]}%` }} aria-hidden="true">
        <span className="pc-icon"><Icon name="braces" /></span><span className="t"><b>uygulamanız</b><small>supabase-js</small></span>
      </div>
      {services.filter((s) => NODES[s.service]).map((s) => {
        const [label, tone] = health(s)
        return (
          <div key={s.service} className="node" style={{ left: `${NODES[s.service][0]}%`, top: `${NODES[s.service][1]}%` }} aria-hidden="true">
            <span className="pc-icon"><Icon name={SERVICE[s.service]?.icon ?? 'database'} /></span>
            <span className="t"><b>{s.service}</b><small>{label}</small></span>
            <Status tone={tone} live={tone === 'ok'} title={label} />
          </div>
        )
      })}
    </div>
  )
}

export default function Home() {
  const { project: p, reload } = useProject()
  const job = p.last_job
  const used = p.services.reduce((a, s) => a + (s.memUsageMb ?? 0), 0)
  const limit = p.services.reduce((a, s) => a + s.memLimitMb, 0)
  const healthy = p.services.filter((s) => health(s)[1] === 'ok').length
  const upToDate = p.template_version === p.current_template_version
  const setup = [
    { done: p.status === 'ACTIVE_HEALTHY', label: 'Proje çalışıyor' },
    { done: p.certificate === 'ok', label: 'Sertifika alındı' },
    { done: p.smtp_configured, label: 'E-posta (SMTP) ayarlandı' },
    { done: upToDate, label: `Şablon güncel (${p.current_template_version})` },
  ]
  const snippet = p.urls.api ? 'const supabase = createClient(API_URL, ANON_KEY)' : ''

  return (
    <Page title="Ana sayfa" aside={p.name}
      meta={<><span>{p.ref}</span><i>·</i><span>{p.size}</span><i>·</i><span>Postgres {p.database.version}</span><i>·</i><span>şablon {p.template_version}</span></>}
      actions={<button className="icon-btn" onClick={reload} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>}>
      <div className="bento">
        <section className="card span3 kpi" aria-label="Durum">
          <div className="micro">Durum</div>
          <div className="badges"><StatusBadge status={p.status} />{p.certificate === 'pending' && <span className="badge warn">sertifika bekleniyor</span>}</div>
          {(p.status === 'INACTIVE' || p.status === 'RESTORE_FAILED') && <Lifecycle />}
        </section>
        <section className="card span3 kpi" aria-label="Bellek">
          <div className="micro">Bellek</div>
          <div className="big"><b>{nf(used)}</b><span className="tail">/ {nf(limit)} MiB</span></div>
          <Dots fill={limit ? used / limit : 0} n={24} />
        </section>
        <section className="card span3 kpi" aria-label="Servisler">
          <div className="micro">Servisler</div>
          <div className="big"><b>{healthy}</b><span className="tail">/ {p.services.length} sağlıklı</span></div>
          <div className="foot"><span>{p.services.map((s) => s.service).join(' · ')}</span></div>
        </section>
        <section className="card span3 kpi" aria-label="Sürüm">
          <div className="micro">Şablon</div>
          <div className="big"><b>{p.template_version}</b></div>
          <div className="foot">{upToDate ? <span>güncel</span> : <span className="badge warn">{p.current_template_version} yayında</span>}</div>
        </section>

        <Section className="span8" title="Mimari" actions={<span className="chip pv-chip">ÖNİZLEME</span>}>
          <Architecture services={p.services} />
        </Section>
        <section className="card span4" aria-label="Kurulum">
          <header className="card-head"><h2>Kurulum</h2><div className="spacer" /><span className="muted small tnum">{setup.filter((s) => s.done).length} / {setup.length}</span></header>
          <div className="clbar" style={{ gridTemplateColumns: `repeat(${setup.length}, 1fr)` }} aria-hidden="true">
            {setup.map((s) => <i key={s.label} className={s.done ? 'f' : undefined} />)}
          </div>
          <ul className="cl">
            {setup.map((s) => (
              <li key={s.label} className={s.done ? 'done' : undefined}>
                <span className="cb" aria-hidden="true">{s.done && <Icon name="check" size={12} weight="bold" />}</span>
                <span className="lab">{s.label}</span><span className="sr-only">{s.done ? 'tamam' : 'bekliyor'}</span>
              </li>
            ))}
          </ul>
        </section>

        <Section className="span7" title="Servisler">
          <div className="grid-wrap">
            <table className="grid list-table svc-table">
              <thead><tr><th>Servis</th><th>Durum</th><th>Bellek</th></tr></thead>
              <tbody>
                {p.services.map((s) => {
                  const [label, tone] = health(s)
                  return (
                    <tr key={s.service}>
                      <td><span className="svc-name"><span className="pc-icon"><Icon name={SERVICE[s.service]?.icon ?? 'database'} /></span>
                        <span><span className="mono cell-main">{s.service}</span><br /><span className="small muted">{SERVICE[s.service]?.label ?? ''}</span></span></span></td>
                      <td><Status tone={tone} live={tone === 'ok'}>{label}</Status></td>
                      <td className="mono">{s.memUsageMb != null ? `${s.memUsageMb} / ${s.memLimitMb} MiB` : `— / ${s.memLimitMb} MiB`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Section>
        <Section className="span5" title="Bağlan">
          <dl className="kv">
            <div>
              <dt>API adresi</dt>
              <dd className="secret-row">{p.urls.api ? <><code>{p.urls.api}</code><CopyButton text={p.urls.api} /></> : '—'}</dd>
            </div>
            {p.urls.legacy.length > 0 && (
              <div>
                <dt>Eski adresler</dt>
                {p.urls.legacy.map((u) => <dd key={u} className="secret-row"><code>{u}</code><CopyButton text={u} /></dd>)}
              </div>
            )}
          </dl>
          {snippet && <div className="snip-line"><span>{snippet}</span><CopyButton text={snippet} /></div>}
        </Section>

        <Section className="span7" title="API anahtarları"><ApiKeys /></Section>
        <Section className="span5" title="Son iş">
          {!job ? <p className="muted">Henüz iş yok.</p> : (
            <dl className="kv">
              <div><dt>Tür</dt><dd className="mono">{job.type}</dd></div>
              <div><dt>Durum</dt><dd>{JOB_STATUS[job.status] ?? job.status}{job.status !== 'succeeded' && ` · adım ${job.step + 1}`}</dd></div>
              {job.error && <div><dt>Hata</dt><dd className="field-error">{job.error}</dd></div>}
            </dl>
          )}
        </Section>
      </div>
    </Page>
  )
}
