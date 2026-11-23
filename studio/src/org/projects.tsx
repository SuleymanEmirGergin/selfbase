import { useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg, platform } from '../api.ts'
import type { ImportResult, Size } from '../api.ts'
import { Link, navigate } from '../router.tsx'
import { Drawer, Empty, ErrorBox, Icon, Loading } from '../ui.tsx'
import { JobSteps, Page, SIZES, StatusBadge, sizeMb, useLoad } from './common.tsx'
import { ago, lower, nf, rich, t } from '../i18n/index.ts'
import { norm } from '../lib/palette.ts'
import type { OrgProps } from './common.tsx'
import { ROLES } from './admin.tsx'

type Filter = 'all' | 'live' | 'paused'
const isPaused = (status: string) => status === 'INACTIVE'

export function Projects({ org, canManage }: OrgProps) {
  const { data, error, reload } = useLoad(() => platform.projects(org.slug), [org.slug])
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const inFilter = (f: Filter, status: string) => f === 'all' || (f === 'paused') === isPaused(status)
  const needle = norm(q.trim())
  const shown = (data ?? []).filter((p) => inFilter(filter, p.status) && (!needle || norm(p.name).includes(needle) || p.ref.includes(needle)))
  const live = (data ?? []).filter((p) => p.status === 'ACTIVE_HEALTHY').length
  return (
    <Page title={t('nav.projects')} aside={org.name}
      meta={data && <><span>{t('projects.count', { n: data.length })}</span><i>·</i><span>{t('projects.running', { n: live })}</span><i>·</i><span>{t('projects.yourRole', { role: org.role ? lower(t(ROLES[org.role])) : t('projects.projectMember') })}</span></>}
      actions={<>
        <button className="icon-btn" onClick={reload} aria-label={t('common.refresh')} title={t('common.refresh')}><Icon name="refresh" /></button>
        {canManage && <Link className="btn" to={`/import/${org.slug}`}><Icon name="download" />{t('projects.import')}</Link>}
        {canManage && <Link className="btn primary" to={`/new/${org.slug}`}>{t('projects.new')}<span className="ic"><Icon name="arrow-up-right" size={12} weight="bold" /></span></Link>}
      </>}>
      {error ? <ErrorBox message={error} onRetry={reload} />
        : !data ? <Loading />
        : !data.length ? (
          <div className="card"><Empty icon="projects">
            <b>{t('projects.emptyTitle')}</b>
            <p>{t(canManage ? 'projects.emptyManage' : 'projects.emptyView')}</p>
          </Empty></div>
        ) : (
          <>
            <div className="ptoolbar">
              <div className="seg" role="group" aria-label={t('projects.filterBy')}>
                {([['all', 'projects.all'], ['live', 'projects.live'], ['paused', 'projects.paused']] as const).map(([f, label]) => (
                  <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                    {t(label)}<span className="n">{data.filter((p) => inFilter(f, p.status)).length}</span>
                  </button>
                ))}
              </div>
              <label className="search wide"><Icon name="search" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('projects.searchPlaceholder')} aria-label={t('projects.search')} />
              </label>
            </div>
            <ul className="cards" aria-label={t('nav.projects')}>
              {shown.map((p, i) => (
                <li key={p.ref} className="project-card">
                  <Link to={`/project/${p.ref}`} className="project-link" style={{ animationDelay: `${i * 50}ms` }}>
                    <div className="pc-head">
                      <span className="pc-icon"><Icon name="database" size={18} /></span>
                      <div className="t"><h3>{p.name}</h3><div className="mono small muted">{p.ref}</div></div>
                      <StatusBadge status={p.status} />
                    </div>
                    <div className="pc-stats">
                      <div><span>{t('common.size')}</span><b>{p.size ?? '—'}</b></div>
                      <div><span>{t('projects.memoryLimit')}</span><b>{p.size ? `${nf(sizeMb(p.size))} MiB` : '—'}</b></div>
                      <div><span>Postgres</span><b>{p.database.version}</b></div>
                    </div>
                    <div className="pc-foot">
                      <span>{t('projects.created', { ago: ago(p.created_at) })}</span>
                      {p.certificate === 'pending' ? <span className="badge warn">{t('projects.certPending')}</span> : <Icon name="arrow-right" />}
                    </div>
                  </Link>
                </li>
              ))}
              {canManage && filter === 'all' && !needle && (
                <li>
                  <Link to={`/new/${org.slug}`} className="newcard">
                    <span><span className="plus"><Icon name="plus" size={20} /></span><b>{t('projects.startEmpty')}</b>
                      <span className="small">{t('projects.startEmptyHint')}</span></span>
                  </Link>
                </li>
              )}
            </ul>
            {!shown.length && <Empty icon="funnel"><b>{t('projects.noMatchTitle')}</b><p>{t('projects.noMatchHint')}</p></Empty>}
          </>
        )}
    </Page>
  )
}

function SizePicker({ size, setSize }: { size: Size; setSize: (s: Size) => void }) {
  return (
    <fieldset className="sizes">
      <legend>{t('common.size')}</legend>
      {(Object.keys(SIZES) as Size[]).map((s) => (
        <label key={s} className={`size ${size === s ? 'active' : ''}`}>
          <input type="radio" name="size" value={s} checked={size === s} onChange={() => setSize(s)} />
          <span className="cell-main">{s} · {nf(sizeMb(s))} MiB</span>
          <span className="mono small muted">{Object.entries(SIZES[s]).map(([k, v]) => `${k} ${nf(v)}`).join(', ')}</span>
        </label>
      ))}
    </fieldset>
  )
}

function CapacityNote() {
  const { data } = useLoad(platform.capacity, [])
  if (!data) return null
  return (
    <div className="note">
      <div><strong>{t('newProject.free', { n: data.free_mb })}</strong> {t('newProject.ofBudget', { n: data.budget_mb })}</div>
      <div>{t('newProject.hostsLeft', { left: Math.max(0, data.max_new_hosts_per_week - data.new_hosts_this_week), max: data.max_new_hosts_per_week })}</div>
    </div>
  )
}

export function NewProject({ org, canManage }: OrgProps) {
  const [name, setName] = useState('')
  const [size, setSize] = useState<Size>('micro')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<{ ref: string; job: string } | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await platform.createProject({ organization_slug: org.slug, name: name.trim(), size })
      setCreated({ ref: r.project.ref, job: r.job_id })
    } catch (err) {
      setError(errMsg(err)) // admission and host-cap refusals are written for the user: shown unchanged
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer title={t('newProject.title')} subtitle={org.name} onClose={() => navigate(`/org/${org.slug}`)}>
      <div>
        {!canManage ? <div className="note">{t('newProject.noRight')}</div>
          : created ? (
            <>
              <p className="muted">{t('newProject.creating')}</p>
              <JobSteps jobId={created.job} onDone={(j) => j.status === 'succeeded' && navigate(`/project/${created.ref}`)} />
            </>
          ) : (
            <form className="form" onSubmit={submit}>
              <CapacityNote />
              <label className="field"><span>{t('newProject.name')}</span>
                <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </label>
              <SizePicker size={size} setSize={setSize} />
              {error && <ErrorBox message={error} />}
              <div className="row-actions end">
                <Link className="btn" to={`/org/${org.slug}`}>{t('common.cancel')}</Link>
                <button className="btn primary" disabled={busy || !name.trim()}>{t(busy ? 'newProject.submitting' : 'newProject.submit')}</button>
              </div>
            </form>
          )}
      </div>
    </Drawer>
  )
}

const KeyList = ({ label, keys }: { label: string; keys: string[] }) => (
  <div>
    <div className="small muted">{label}</div>
    {keys.length ? <ul className="key-list">{keys.map((k) => <li key={k}><code>{k}</code></li>)}</ul> : <div className="small">—</div>}
  </div>
)

export function ImportProject({ org, canManage }: OrgProps) {
  const [size, setSize] = useState<Size>('micro')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [ended, setEnded] = useState(false)

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    form.set('organization_slug', org.slug)
    // control takes exactly one: an export's passphrase, or a v1 backup's env file (an empty field is not sent)
    if (!form.get('passphrase')) form.delete('passphrase')
    if (!(form.get('env_file') as File | null)?.size) form.delete('env_file')
    if (form.has('passphrase') === form.has('env_file')) {
      setError(t('import.oneOnly'))
      return
    }
    setBusy(true)
    setError('')
    try {
      setResult(await platform.importProject(form))
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer title={t('import.title')} subtitle={`${org.name} · ${t('cmd.importHint')}`} onClose={() => navigate(`/org/${org.slug}`)}>
      <div>
        {!canManage ? <div className="note">{t('import.noRight')}</div>
          : result ? (
            <div className="form">
              <div className="note">{t('import.saved')}</div>
              <KeyList label={t('import.ignored')} keys={result.ignored} />
              <KeyList label={t('import.unknown')} keys={result.unknown} />
              <JobSteps jobId={result.job_id} onDone={(j) => setEnded(j.status === 'succeeded')} />
              {ended && <Link className="btn primary" to={`/project/${result.project.ref}`}>{t('import.open')}</Link>}
            </div>
          ) : (
            <form className="form" onSubmit={submit}>
              <CapacityNote />
              <section className="stp"><div className="sh"><span className="num">1</span><b>{t('import.stepProject')}</b></div><div className="in">
                <label className="field"><span>{t('newProject.name')}</span><input name="name" required maxLength={64} autoFocus /></label>
                <SizePicker size={size} setSize={setSize} />
              </div></section>
              <section className="stp"><div className="sh"><span className="num">2</span><b>{t('import.stepBackup')}</b></div><div className="in">
              <label className="field"><span>{t('import.backupDir')}</span>
                <input name="backup_dir" required placeholder="<subdir>/YYYYMMDD-HHMMSS" className="mono" />
              </label>
              <p className="muted small">{rich('import.backupHint', {
                a: <code>&lt;ref&gt;/…</code>, b: <code>export-&lt;ref&gt;/…</code>, c: <code>import/{org.slug}/&lt;{t('import.nameWord')}&gt;</code>,
              })}</p>
              </div></section>
              <section className="stp"><div className="sh"><span className="num">3</span><b>{t('import.stepKeys')}</b></div><div className="in">
              <label className="field"><span>{t('import.passphrase')}</span>
                <input name="passphrase" type="password" autoComplete="off" />
              </label>
              <label className="field"><span>{t('import.envFile')}</span>
                <input name="env_file" type="file" />
              </label>
              <p className="muted small">{t('import.keysHint')}</p>
              </div></section>
              {error && <ErrorBox message={error} />}
              <div className="row-actions end">
                <Link className="btn" to={`/org/${org.slug}`}>{t('common.cancel')}</Link>
                <button className="btn primary" disabled={busy}>{t(busy ? 'import.sending' : 'projects.import')}</button>
              </div>
            </form>
          )}
      </div>
    </Drawer>
  )
}
