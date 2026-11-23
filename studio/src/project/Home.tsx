import type { ServiceState } from '../api.ts'
import { Dots, Icon, Status } from '../ui.tsx'
import type { Tone } from '../ui.tsx'
import { CopyButton, Page, StatusBadge } from '../org/common.tsx'
import { nf, t } from '../i18n/index.ts'
import { useProject } from './context.ts'
import { ApiKeys, jobStatus, Lifecycle, Section } from './parts.tsx'

const health = (s: ServiceState): [string, Tone] =>
  !s.exists ? [t('health.missing'), 'err']
    : s.state !== 'running' ? [s.state, 'mute']
    : s.health === 'healthy' || s.health === 'none' ? [t('health.healthy'), 'ok']
    : s.health === 'starting' ? [t('health.starting'), 'warn']
    : [s.health, 'err']

// labels are read at render time, so they follow the language
const SERVICE: Record<string, { label: () => string; icon: string }> = {
  db: { label: () => 'Postgres', icon: 'g-postgres' },
  rest: { label: () => 'REST API', icon: 'g-rest' },
  core: { label: () => 'Auth · Storage · Realtime', icon: 'g-auth' },
  fn: { label: () => t('svc.fn'), icon: 'g-fn' },
  pooler: { label: () => t('svc.pooler'), icon: 'flow' },
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
    <div className="canvas" role="img" aria-label={t('home.arch', { list: services.map((s) => `${s.service} ${health(s)[0]}`).join(', ') })}>
      <svg className="edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {EDGES.filter((e) => e.every(has)).map((e) => <path key={e.join('-')} d={curve(e)} />)}
      </svg>
      <div className="node" style={{ left: `${NODES.app[0]}%`, top: `${NODES.app[1]}%` }} aria-hidden="true">
        <span className="pc-icon"><Icon name="braces" /></span><span className="t"><b>{t('home.yourApp')}</b><small>supabase-js</small></span>
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
    { done: p.status === 'ACTIVE_HEALTHY', label: t('home.setupRunning') },
    { done: p.certificate === 'ok', label: t('home.setupCert') },
    { done: p.smtp_configured, label: t('home.setupSmtp') },
    { done: upToDate, label: t('home.setupTemplate', { v: p.current_template_version }) },
  ]
  const snippet = p.urls.api ? 'const client = createClient(API_URL, ANON_KEY)' : ''

  return (
    <Page title={t('nav.home')} aside={p.name}
      meta={<><span>{p.ref}</span><i>·</i><span>{p.size}</span><i>·</i><span>Postgres {p.database.version}</span><i>·</i><span>{t('home.template', { v: p.template_version })}</span></>}
      actions={<button className="icon-btn" onClick={reload} aria-label={t('common.refresh')} title={t('common.refresh')}><Icon name="refresh" /></button>}>
      <div className="bento">
        <section className="card span3 kpi" aria-label={t('common.status')}>
          <div className="micro">{t('common.status')}</div>
          <div className="badges"><StatusBadge status={p.status} />{p.certificate === 'pending' && <span className="badge warn">{t('projects.certPending')}</span>}</div>
          {(p.status === 'INACTIVE' || p.status === 'RESTORE_FAILED') && <Lifecycle />}
        </section>
        <section className="card span3 kpi" aria-label={t('common.memory')}>
          <div className="micro">{t('common.memory')}</div>
          <div className="big"><b>{nf(used)}</b><span className="tail">/ {nf(limit)} MiB</span></div>
          <Dots fill={limit ? used / limit : 0} n={24} />
        </section>
        <section className="card span3 kpi" aria-label={t('home.services')}>
          <div className="micro">{t('home.services')}</div>
          <div className="big"><b>{nf(healthy)}</b><span className="tail">{t('home.healthyOf', { total: p.services.length })}</span></div>
          <div className="foot"><span>{p.services.map((s) => s.service).join(' · ')}</span></div>
        </section>
        <section className="card span3 kpi" aria-label={t('home.version')}>
          <div className="micro">{t('home.templateTitle')}</div>
          <div className="big"><b>{p.template_version}</b></div>
          <div className="foot">{upToDate ? <span>{t('home.upToDate')}</span> : <span className="badge warn">{t('home.released', { v: p.current_template_version })}</span>}</div>
        </section>

        <Section className="span8" title={t('home.archTitle')} actions={<span className="chip pv-chip">{t('common.preview')}</span>}>
          <Architecture services={p.services} />
        </Section>
        <section className="card span4" aria-label={t('home.setup')}>
          <header className="card-head"><h2>{t('home.setup')}</h2><div className="spacer" /><span className="muted small tnum">{setup.filter((s) => s.done).length} / {setup.length}</span></header>
          <div className="clbar" style={{ gridTemplateColumns: `repeat(${setup.length}, 1fr)` }} aria-hidden="true">
            {setup.map((s) => <i key={s.label} className={s.done ? 'f' : undefined} />)}
          </div>
          <ul className="cl">
            {setup.map((s) => (
              <li key={s.label} className={s.done ? 'done' : undefined}>
                <span className="cb" aria-hidden="true">{s.done && <Icon name="check" size={12} weight="bold" />}</span>
                <span className="lab">{s.label}</span><span className="sr-only">{t(s.done ? 'job.done' : 'job.waiting')}</span>
              </li>
            ))}
          </ul>
        </section>

        <Section className="span7" title={t('home.services')}>
          <div className="grid-wrap">
            <table className="grid list-table svc-table">
              <thead><tr><th>{t('home.service')}</th><th>{t('common.status')}</th><th>{t('common.memory')}</th></tr></thead>
              <tbody>
                {p.services.map((s) => {
                  const [label, tone] = health(s)
                  return (
                    <tr key={s.service}>
                      <td><span className="svc-name"><span className="pc-icon"><Icon name={SERVICE[s.service]?.icon ?? 'database'} /></span>
                        <span><span className="mono cell-main">{s.service}</span><br /><span className="small muted">{SERVICE[s.service]?.label() ?? ''}</span></span></span></td>
                      <td><Status tone={tone} live={tone === 'ok'}>{label}</Status></td>
                      <td className="mono">{s.memUsageMb != null ? `${nf(s.memUsageMb)} / ${nf(s.memLimitMb)} MiB` : `— / ${nf(s.memLimitMb)} MiB`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Section>
        <Section className="span5" title={t('home.connect')}>
          <dl className="kv">
            <div>
              <dt>{t('home.apiUrl')}</dt>
              <dd className="secret-row">{p.urls.api ? <><code>{p.urls.api}</code><CopyButton text={p.urls.api} /></> : '—'}</dd>
            </div>
            {p.urls.legacy.length > 0 && (
              <div>
                <dt>{t('home.legacyUrls')}</dt>
                {p.urls.legacy.map((u) => <dd key={u} className="secret-row"><code>{u}</code><CopyButton text={u} /></dd>)}
              </div>
            )}
          </dl>
          {snippet && <div className="snip-line"><span>{snippet}</span><CopyButton text={snippet} /></div>}
        </Section>

        <Section className="span7" title={t('home.apiKeys')}><ApiKeys /></Section>
        <Section className="span5" title={t('home.lastJob')}>
          {!job ? <p className="muted">{t('home.noJob')}</p> : (
            <dl className="kv">
              <div><dt>{t('home.type')}</dt><dd className="mono">{job.type}</dd></div>
              <div><dt>{t('common.status')}</dt><dd>{jobStatus(job.status)}{job.status !== 'succeeded' && ` · ${t('home.step', { n: job.step + 1 })}`}</dd></div>
              {job.error && <div><dt>{t('home.error')}</dt><dd className="field-error">{job.error}</dd></div>}
            </dl>
          )}
        </Section>
      </div>
    </Page>
  )
}
