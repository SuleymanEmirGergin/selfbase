import { useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg, platform } from '../api.ts'
import type { ImportResult, Size } from '../api.ts'
import { Link, navigate } from '../router.tsx'
import { Empty, ErrorBox, Icon, Loading } from '../ui.tsx'
import { JobSteps, Page, SIZES, StatusBadge, sizeMb, useLoad } from './common.tsx'
import type { OrgProps } from './common.tsx'

export function Projects({ org, canManage }: OrgProps) {
  const { data, error, reload } = useLoad(() => platform.projects(org.slug), [org.slug])
  return (
    <Page title="Projeler" actions={<>
      {canManage && <Link className="btn" to={`/import/${org.slug}`}><Icon name="upload" />İçe aktar</Link>}
      {canManage && <Link className="btn primary" to={`/new/${org.slug}`}><Icon name="plus" />Yeni proje</Link>}
      <button className="icon-btn" onClick={reload} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>
    </>}>
      {error ? <ErrorBox message={error} onRetry={reload} />
        : !data ? <Loading />
        : !data.length ? <Empty>Bu organizasyonda henüz proje yok.</Empty>
        : (
          <ul className="cards" aria-label="Projeler">
            {data.map((p) => (
              <li key={p.ref} className="project-card">
                <Link to={`/project/${p.ref}`} className="project-link">
                  <span className="cell-main">{p.name}</span>
                  <span className="mono small muted">{p.ref}</span>
                </Link>
                <div className="badges">
                  <StatusBadge status={p.status} />
                  {p.certificate === 'pending' && <span className="badge warn">sertifika bekleniyor</span>}
                  {p.size && <span className="badge">{p.size}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
    </Page>
  )
}

function SizePicker({ size, setSize }: { size: Size; setSize: (s: Size) => void }) {
  return (
    <fieldset className="sizes">
      <legend>Boyut</legend>
      {(Object.keys(SIZES) as Size[]).map((s) => (
        <label key={s} className={`size ${size === s ? 'active' : ''}`}>
          <input type="radio" name="size" value={s} checked={size === s} onChange={() => setSize(s)} />
          <span className="cell-main">{s} · {sizeMb(s)} MiB</span>
          <span className="mono small muted">{Object.entries(SIZES[s]).map(([k, v]) => `${k} ${v}`).join(', ')}</span>
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
      <div><strong>{data.free_mb} MiB boş</strong> ({data.budget_mb} MiB bütçeden)</div>
      <div>Bu hafta kalan yeni adres: {Math.max(0, data.max_new_hosts_per_week - data.new_hosts_this_week)} / {data.max_new_hosts_per_week}</div>
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
    <Page title="Yeni proje">
      <div className="form-card">
        {!canManage ? <div className="note">Bu organizasyonda proje oluşturma yetkiniz yok.</div>
          : created ? (
            <>
              <p className="muted">Proje kuruluyor. Hazır olduğunda proje sayfasına geçilecek.</p>
              <JobSteps jobId={created.job} onDone={(j) => j.status === 'succeeded' && navigate(`/project/${created.ref}`)} />
            </>
          ) : (
            <form className="form" onSubmit={submit}>
              <CapacityNote />
              <label className="field"><span>Proje adı</span>
                <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </label>
              <SizePicker size={size} setSize={setSize} />
              {error && <ErrorBox message={error} />}
              <div className="row-actions end">
                <Link className="btn" to={`/org/${org.slug}`}>Vazgeç</Link>
                <button className="btn primary" disabled={busy || !name.trim()}>{busy ? 'Oluşturuluyor…' : 'Proje oluştur'}</button>
              </div>
            </form>
          )}
      </div>
    </Page>
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
      setError('Dışa aktarılan yedek için parolayı, v1 yedeği için env dosyasını verin: yalnızca birini.')
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
    <Page title="Projeyi içe aktar">
      <div className="form-card">
        {!canManage ? <div className="note">Bu organizasyonda proje içe aktarma yetkiniz yok.</div>
          : result ? (
            <div className="form">
              <div className="note">Anahtarlar şifrelenip kaydedildi; aşağıda yalnızca anahtar adları var.</div>
              <KeyList label="Yok sayılan anahtarlar" keys={result.ignored} />
              <KeyList label="Tanınmayan anahtarlar" keys={result.unknown} />
              <JobSteps jobId={result.job_id} onDone={(j) => setEnded(j.status === 'succeeded')} />
              {ended && <Link className="btn primary" to={`/project/${result.project.ref}`}>Projeye git</Link>}
            </div>
          ) : (
            <form className="form" onSubmit={submit}>
              <CapacityNote />
              <label className="field"><span>Proje adı</span><input name="name" required maxLength={64} autoFocus /></label>
              <SizePicker size={size} setSize={setSize} />
              <label className="field"><span>Yedek dizini</span>
                <input name="backup_dir" required placeholder="<subdir>/YYYYMMDD-HHMMSS" className="mono" />
              </label>
              <p className="muted small">Bu organizasyonun bir yedeği (<code>&lt;ref&gt;/…</code>, <code>export-&lt;ref&gt;/…</code>) ya da
                {' '}<code>import/{org.slug}/&lt;ad&gt;</code>.</p>
              <label className="field"><span>Dışa aktarma parolası</span>
                <input name="passphrase" type="password" autoComplete="off" />
              </label>
              <label className="field"><span>Env dosyası</span>
                <input name="env_file" type="file" />
              </label>
              <p className="muted small">Dışa aktarılan bir yedek için parolası, v1 yedeği için kurulumun env dosyası: yalnızca biri.
                Değerler sunucuda şifrelenir; dosya saklanmaz.</p>
              {error && <ErrorBox message={error} />}
              <div className="row-actions end">
                <Link className="btn" to={`/org/${org.slug}`}>Vazgeç</Link>
                <button className="btn primary" disabled={busy}>{busy ? 'Gönderiliyor…' : 'İçe aktar'}</button>
              </div>
            </form>
          )}
      </div>
    </Page>
  )
}
