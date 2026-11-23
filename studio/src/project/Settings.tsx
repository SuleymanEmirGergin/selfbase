import { useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg, platform } from '../api.ts'
import type { Domain } from '../api.ts'
import { navigate } from '../router.tsx'
import { Empty, ErrorBox, Icon, Loading, confirmDanger, toast } from '../ui.tsx'
import { fmtDate, fmtSize, rich, t } from '../i18n/index.ts'
import type { Key } from '../i18n/index.ts'
import { Page, useLoad } from '../org/common.tsx'
import { useProject } from './context.ts'
import { ApiKeys, jobStatus, Lifecycle, Section, useJob } from './parts.tsx'

// Matches control's manifest rule (plan Task 14): a shorter passphrase is refused there anyway.
const MIN_PASSPHRASE = 12
// A lowercase DNS name with at least two labels; anything else is refused before it can cost a certificate request.
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const KIND: Record<Domain['kind'], Key> = { default: 'domain.default', legacy: 'domain.legacy', custom: 'domain.custom' }

export default function Settings() {
  const { can } = useProject()
  const manage = can('project.manage')
  return (
    <Page title={t('nav.settings')}>
      <General />
      <Section title={t('home.apiKeys')}><ApiKeys /></Section>
      <Domains />
      <Backups />
      {manage && <Section title={t('settings.lifecycle')}><Lifecycle /></Section>}
      {manage && <Delete />}
    </Page>
  )
}

function General() {
  const { ref, project: p, can } = useProject()
  const job = useJob()
  const outdated = p.template_version !== p.current_template_version
  return (
    <Section title={t('settings.general')}>
      <dl className="kv">
        <div><dt>{t('common.name')}</dt><dd>{p.name}</dd></div>
        <div><dt>{t('settings.ref')}</dt><dd className="mono">{p.ref}</dd></div>
        <div><dt>{t('common.size')}</dt><dd>{p.size}</dd></div>
        <div>
          <dt>{t('settings.template')}</dt>
          <dd className="secret-row">
            <span className="mono">{p.template_version}</span>
            {outdated && <span className="badge warn">{t('settings.newVersion', { v: p.current_template_version })}</span>}
            {outdated && can('project.manage') && <button className="btn sm" disabled={job.busy} onClick={() => job.start(() => platform.upgrade(ref))}>{t('settings.upgrade')}</button>}
          </dd>
        </div>
      </dl>
      {job.steps}
    </Section>
  )
}

function Domains() {
  const { ref, can } = useProject()
  const { data, error, reload } = useLoad(() => platform.domains(ref), [ref])
  const job = useJob(reload)
  const [hostname, setHostname] = useState('')
  const [kind, setKind] = useState<'legacy' | 'custom'>('custom')
  const manage = can('project.manage')

  const [hostErr, setHostErr] = useState('')
  const add = async (e: FormEvent) => {
    e.preventDefault()
    const host = hostname.trim().toLowerCase()
    if (!HOSTNAME.test(host)) return setHostErr(t('domains.invalid'))
    setHostErr('')
    if (kind === 'custom' && !(await confirmDanger(t('domains.addConfirm'),
      rich('domains.addMsg', { host: <code>{host}</code> }),
      t('domains.add')))) return
    job.start(async () => { const r = await platform.addDomain(ref, { hostname: host, kind }); setHostname(''); reload(); return r })
  }
  const remove = async (d: Domain) => {
    if (!(await confirmDanger(t('domains.removeConfirm'), rich('domains.removeMsg', { host: <code>{d.hostname}</code> }), t('domains.remove')))) return
    job.start(async () => { const r = await platform.removeDomain(ref, d.hostname); reload(); return r })
  }

  return (
    <Section title={t('domains.title')}>
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Loading /> : !data.length ? <Empty>{t('domains.none')}</Empty> : (
        <ul className="rows" aria-label={t('domains.title')}>
          {data.map((d) => (
            <li key={d.hostname}>
              <code>{d.hostname}</code>
              <span className="badge">{KIND[d.kind] ? t(KIND[d.kind]) : d.kind}</span>
              <div className="spacer" />
              {manage && d.kind !== 'default' && (
                <button className="icon-btn danger" onClick={() => remove(d)} aria-label={t('domains.removeOf', { host: d.hostname })} title={t('domains.remove')}><Icon name="trash" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <form className="form-row" onSubmit={add}>
          <label className="field grow"><span>{t('domains.host')}</span>
            <input className="mono" required placeholder={t('domains.placeholder')} value={hostname} onChange={(e) => { setHostname(e.target.value); setHostErr('') }} />
          </label>
          <label className="field"><span>{t('files.type')}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as 'legacy' | 'custom')}>
              <option value="custom">{t('domain.custom')}</option><option value="legacy">{t('domain.legacy')}</option>
            </select>
          </label>
          <button className="btn" disabled={job.busy}><Icon name="plus" />{t('domains.add')}</button>
        </form>
      )}
      {hostErr && <div className="field-error" role="alert">{hostErr}</div>}
      {job.steps}
    </Section>
  )
}

function Backups() {
  const { ref, can } = useProject()
  const { data, error, reload } = useLoad(() => platform.backups(ref), [ref])
  const backup = useJob(reload)
  const exp = useJob(reload)
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [passErr, setPassErr] = useState('')
  const manage = can('project.manage')

  const exportNow = (e: FormEvent) => {
    e.preventDefault()
    if (pass.length < MIN_PASSPHRASE) return setPassErr(t('backups.short', { n: MIN_PASSPHRASE }))
    if (pass !== again) return setPassErr(t('backups.mismatch'))
    setPassErr('')
    exp.start(async () => { const r = await platform.exportProject(ref, pass); setPass(''); setAgain(''); return r })
  }

  return (
    <Section title={t('backups.title')} actions={manage && (
      <button className="btn" disabled={backup.busy} onClick={() => backup.start(() => platform.backupNow(ref))}>{t('backups.now')}</button>
    )}>
      {backup.steps}
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Loading /> : !data.length ? <Empty>{t('backups.none')}</Empty> : (
        <div className="grid-wrap">
          <table className="grid list-table">
            <thead>
              <tr>
                <th><div className="th-btn">{t('backups.started')}</div></th>
                <th><div className="th-btn">{t('common.status')}</div></th>
                <th><div className="th-btn">{t('common.size')}</div></th>
                <th><div className="th-btn">{t('backups.location')}</div></th>
              </tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id}>
                  <td className="small">{fmtDate(b.started_at)}</td>
                  <td className="small">{jobStatus(b.status)}</td>
                  <td className="small">{fmtSize(b.size_bytes ?? undefined)}</td>
                  <td className="mono small">{b.location ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {manage && (
        <form className="form export-form" onSubmit={exportNow} aria-label={t('backups.export')}>
          <p className="muted small">{rich('backups.exportHint', { file: <code>project.json</code> })}</p>
          <div className="form-row">
            <label className="field grow"><span>{t('backups.pass')}</span>
              <input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            <label className="field grow"><span>{t('backups.passAgain')}</span>
              <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
            <button className="btn" disabled={exp.busy}>{t('backups.export')}</button>
          </div>
          {passErr && <div className="field-error" role="alert">{passErr}</div>}
        </form>
      )}
      {exp.steps}
    </Section>
  )
}

function Delete() {
  const { ref, project, org } = useProject()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const remove = async (e: FormEvent) => {
    e.preventDefault()
    if (name !== project.name) return
    setBusy(true)
    try {
      await platform.deleteProject(ref, name)
      toast(t('settings.deleting', { name: project.name }))
      navigate(org ? `/org/${org.slug}` : '/', true)
    } catch (err) {
      toast(errMsg(err), 'error')
      setBusy(false)
    }
  }
  return (
    <section className="card card-danger" aria-label={t('settings.delete')}>
      <header className="card-head"><h2>{t('settings.delete')}</h2></header>
      <form className="card-body form" onSubmit={remove}>
        <p className="muted">{rich('settings.deleteText', { name: <code>{project.name}</code> })}</p>
        <div className="form-row">
          <label className="field grow"><span>{t('newProject.name')}</span>
            <input autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn danger" disabled={busy || name !== project.name}>{t('settings.delete')}</button>
        </div>
      </form>
    </section>
  )
}
