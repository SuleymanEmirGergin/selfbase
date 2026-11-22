import { useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg, platform } from '../api.ts'
import type { Domain } from '../api.ts'
import { navigate } from '../router.tsx'
import { Empty, ErrorBox, Icon, Loading, confirmDanger, fmtDate, fmtSize, toast } from '../ui.tsx'
import { Page, useLoad } from '../org/common.tsx'
import { useProject } from './context.ts'
import { ApiKeys, Lifecycle, Section, useJob } from './parts.tsx'

// Matches control's manifest rule (plan Task 14): a shorter passphrase is refused there anyway.
const MIN_PASSPHRASE = 12
const KIND: Record<Domain['kind'], string> = { default: 'varsayılan', legacy: 'eski adres', custom: 'özel' }

export default function Settings() {
  const { can } = useProject()
  const manage = can('project.manage')
  return (
    <Page title="Ayarlar">
      <General />
      <Section title="API anahtarları"><ApiKeys /></Section>
      <Domains />
      <Backups />
      {manage && <Section title="Duraklat / devam ettir"><Lifecycle /></Section>}
      {manage && <Delete />}
    </Page>
  )
}

function General() {
  const { ref, project: p, can } = useProject()
  const job = useJob()
  const outdated = p.template_version !== p.current_template_version
  return (
    <Section title="Genel">
      <dl className="kv">
        <div><dt>Ad</dt><dd>{p.name}</dd></div>
        <div><dt>Ref</dt><dd className="mono">{p.ref}</dd></div>
        <div><dt>Boyut</dt><dd>{p.size}</dd></div>
        <div>
          <dt>Şablon sürümü</dt>
          <dd className="secret-row">
            <span className="mono">{p.template_version}</span>
            {outdated && <span className="badge warn">yeni sürüm: {p.current_template_version}</span>}
            {outdated && can('project.manage') && <button className="btn sm" disabled={job.busy} onClick={() => job.start(() => platform.upgrade(ref))}>güncelle</button>}
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

  const add = (e: FormEvent) => {
    e.preventDefault()
    job.start(async () => { const r = await platform.addDomain(ref, { hostname: hostname.trim(), kind }); setHostname(''); reload(); return r })
  }
  const remove = async (d: Domain) => {
    if (!(await confirmDanger('Alan adı kaldırılsın mı?', <><code>{d.hostname}</code> bu projeye yönlenmeyi bırakır.</>, 'Kaldır'))) return
    job.start(async () => { const r = await platform.removeDomain(ref, d.hostname); reload(); return r })
  }

  return (
    <Section title="Alan adları">
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Loading /> : !data.length ? <Empty>Alan adı yok.</Empty> : (
        <ul className="rows" aria-label="Alan adları">
          {data.map((d) => (
            <li key={d.hostname}>
              <code>{d.hostname}</code>
              <span className="badge">{KIND[d.kind] ?? d.kind}</span>
              <div className="spacer" />
              {manage && d.kind !== 'default' && (
                <button className="icon-btn danger" onClick={() => remove(d)} aria-label={`Kaldır: ${d.hostname}`} title="Kaldır"><Icon name="trash" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <form className="form-row" onSubmit={add}>
          <label className="field grow"><span>Alan adı</span>
            <input className="mono" required placeholder="api.ornek.com" value={hostname} onChange={(e) => setHostname(e.target.value)} />
          </label>
          <label className="field"><span>Tür</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as 'legacy' | 'custom')}>
              <option value="custom">özel</option><option value="legacy">eski adres</option>
            </select>
          </label>
          <button className="btn" disabled={job.busy}><Icon name="plus" />Ekle</button>
        </form>
      )}
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
    if (pass.length < MIN_PASSPHRASE) return setPassErr(`Parola en az ${MIN_PASSPHRASE} karakter olmalı.`)
    if (pass !== again) return setPassErr('Parolalar aynı değil.')
    setPassErr('')
    exp.start(async () => { const r = await platform.exportProject(ref, pass); setPass(''); setAgain(''); return r })
  }

  return (
    <Section title="Yedekler" actions={manage && (
      <button className="btn" disabled={backup.busy} onClick={() => backup.start(() => platform.backupNow(ref))}>şimdi yedekle</button>
    )}>
      {backup.steps}
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Loading /> : !data.length ? <Empty>Henüz yedek yok.</Empty> : (
        <div className="grid-wrap">
          <table className="grid list-table">
            <thead>
              <tr>
                <th><div className="th-btn">Başlangıç</div></th>
                <th><div className="th-btn">Durum</div></th>
                <th><div className="th-btn">Boyut</div></th>
                <th><div className="th-btn">Konum</div></th>
              </tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id}>
                  <td className="small">{fmtDate(b.started_at)}</td>
                  <td className="small">{b.status}</td>
                  <td className="small">{fmtSize(b.size_bytes ?? undefined)}</td>
                  <td className="mono small">{b.location ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {manage && (
        <form className="form export-form" onSubmit={exportNow} aria-label="Dışa aktar">
          <p className="muted small">Dışa aktarma, yedeğin yanına anahtarları bu parolayla şifrelenmiş bir <code>project.json</code> yazar. Parola saklanmaz.</p>
          <div className="form-row">
            <label className="field grow"><span>Parola</span>
              <input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            <label className="field grow"><span>Parola (tekrar)</span>
              <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
            <button className="btn" disabled={exp.busy}>Dışa aktar</button>
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
      toast(`Proje siliniyor: ${project.name}`)
      navigate(org ? `/org/${org.slug}` : '/', true)
    } catch (err) {
      toast(errMsg(err), 'error')
      setBusy(false)
    }
  }
  return (
    <section className="card card-danger" aria-label="Projeyi sil">
      <header className="card-head"><h2>Projeyi sil</h2></header>
      <form className="card-body form" onSubmit={remove}>
        <p className="muted">Veritabanı, dosyalar ve anahtarlar kalıcı olarak silinir. Onaylamak için proje adını yazın: <code>{project.name}</code></p>
        <div className="form-row">
          <label className="field grow"><span>Proje adı</span>
            <input autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn danger" disabled={busy || name !== project.name}>Projeyi sil</button>
        </div>
      </form>
    </section>
  )
}
