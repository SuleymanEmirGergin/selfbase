import { useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg, platform } from '../api.ts'
import type { ImportResult, Size } from '../api.ts'
import { Link, navigate } from '../router.tsx'
import { Drawer, Empty, ErrorBox, Icon, Loading } from '../ui.tsx'
import { JobSteps, Page, SIZES, StatusBadge, sizeMb, useLoad } from './common.tsx'
import { ago, nf } from '../lib/format.ts'
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
    <Page title="Projeler" aside={org.name}
      meta={data && <><span>{data.length} proje</span><i>·</i><span>{live} çalışıyor</span><i>·</i><span>rolünüz: {org.role ? ROLES[org.role].toLocaleLowerCase('tr') : 'proje üyesi'}</span></>}
      actions={<>
        <button className="icon-btn" onClick={reload} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>
        {canManage && <Link className="btn" to={`/import/${org.slug}`}><Icon name="download" />İçe aktar</Link>}
        {canManage && <Link className="btn primary" to={`/new/${org.slug}`}>Yeni proje<span className="ic"><Icon name="arrow-up-right" size={14} weight="bold" /></span></Link>}
      </>}>
      {error ? <ErrorBox message={error} onRetry={reload} />
        : !data ? <Loading />
        : !data.length ? (
          <div className="card"><Empty icon="projects">
            <b>Henüz proje yok</b>
            <p>{canManage ? 'İlk projenizi oluşturun ya da bir yedekten içe aktarın.' : 'Bu organizasyonda henüz proje yok.'}</p>
          </Empty></div>
        ) : (
          <>
            <div className="ptoolbar">
              <div className="seg" role="group" aria-label="Duruma göre süz">
                {([['all', 'Tümü'], ['live', 'Çalışan'], ['paused', 'Duraklatılmış']] as const).map(([f, label]) => (
                  <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                    {label}<span className="n">{data.filter((p) => inFilter(f, p.status)).length}</span>
                  </button>
                ))}
              </div>
              <label className="search wide"><Icon name="search" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ad ya da ref ile ara" aria-label="Projelerde ara" />
              </label>
            </div>
            <ul className="cards" aria-label="Projeler">
              {shown.map((p, i) => (
                <li key={p.ref} className="project-card">
                  <Link to={`/project/${p.ref}`} className="project-link" style={{ animationDelay: `${i * 50}ms` }}>
                    <div className="pc-head">
                      <span className="pc-icon"><Icon name="database" size={18} /></span>
                      <div className="t"><h3>{p.name}</h3><div className="mono small muted">{p.ref}</div></div>
                      <StatusBadge status={p.status} />
                    </div>
                    <div className="pc-stats">
                      <div><span>Boyut</span><b>{p.size ?? '—'}</b></div>
                      <div><span>Bellek</span><b>{p.size ? `${nf(sizeMb(p.size))} MiB` : '—'}</b></div>
                      <div><span>Postgres</span><b>{p.database.version}</b></div>
                    </div>
                    <div className="pc-foot">
                      <span>{ago(p.created_at)} oluşturuldu</span>
                      {p.certificate === 'pending' ? <span className="badge warn">sertifika bekleniyor</span> : <Icon name="arrow-right" />}
                    </div>
                  </Link>
                </li>
              ))}
              {canManage && filter === 'all' && !needle && (
                <li role="none">
                  <Link to={`/new/${org.slug}`} className="newcard" aria-label="Boş bir proje başlat">
                    <span><span className="plus"><Icon name="plus" size={20} /></span><b>Boş bir proje başlatın</b>
                      <span className="small">Postgres, kimlik doğrulama, depolama ve fonksiyonlar</span></span>
                  </Link>
                </li>
              )}
            </ul>
            {!shown.length && <Empty icon="funnel"><b>Eşleşen proje yok</b><p>Süzgeci ya da aramayı değiştirin.</p></Empty>}
          </>
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
    <Drawer title="Yeni proje" subtitle={org.name} onClose={() => navigate(`/org/${org.slug}`)}>
      <div>
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
      setError('Dışa aktarılan yedek için şifresini, v1 yedeği için env dosyasını verin: yalnızca birini.')
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
    <Drawer title="Projeyi içe aktar" subtitle={`${org.name} · yedekten`} onClose={() => navigate(`/org/${org.slug}`)}>
      <div>
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
              <section className="stp"><div className="sh"><span className="num">1</span><b>Proje</b></div><div className="in">
                <label className="field"><span>Proje adı</span><input name="name" required maxLength={64} autoFocus /></label>
                <SizePicker size={size} setSize={setSize} />
              </div></section>
              <section className="stp"><div className="sh"><span className="num">2</span><b>Yedek</b></div><div className="in">
              <label className="field"><span>Yedek dizini</span>
                <input name="backup_dir" required placeholder="<subdir>/YYYYMMDD-HHMMSS" className="mono" />
              </label>
              <p className="muted small">Bu organizasyonun bir yedeği (<code>&lt;ref&gt;/…</code>, <code>export-&lt;ref&gt;/…</code>) ya da
                {' '}<code>import/{org.slug}/&lt;ad&gt;</code>.</p>
              </div></section>
              <section className="stp"><div className="sh"><span className="num">3</span><b>Anahtarlar</b></div><div className="in">
              <label className="field"><span>Dışa aktarma şifresi</span>
                <input name="passphrase" type="password" autoComplete="off" />
              </label>
              <label className="field"><span>Env dosyası</span>
                <input name="env_file" type="file" />
              </label>
              <p className="muted small">Dışa aktarılan bir yedek için şifresi, v1 yedeği için kurulumun env dosyası: yalnızca biri.
                Değerler sunucuda şifrelenir; dosya saklanmaz.</p>
              </div></section>
              {error && <ErrorBox message={error} />}
              <div className="row-actions end">
                <Link className="btn" to={`/org/${org.slug}`}>Vazgeç</Link>
                <button className="btn primary" disabled={busy}>{busy ? 'Gönderiliyor…' : 'İçe aktar'}</button>
              </div>
            </form>
          )}
      </div>
    </Drawer>
  )
}
