import { useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg, platform } from '../api.ts'
import type { AuditRow, Member, Role } from '../api.ts'
import { Empty, ErrorBox, Icon, Loading, confirmDanger, fmtDate, toast } from '../ui.tsx'
import { CopyButton, Page, StatusBadge, useLoad } from './common.tsx'
import type { OrgProps } from './common.tsx'

export const ROLES: Record<Role, string> = {
  owner: 'Sahip',
  administrator: 'Yönetici',
  developer: 'Geliştirici',
  read_only: 'Salt okunur',
}
const roleOptions = (Object.keys(ROLES) as Role[]).map((r) => <option key={r} value={r}>{ROLES[r]}</option>)

function InviteForm({ slug }: { slug: string }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('developer')
  const [project, setProject] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState<{ link?: string; expires_at: string } | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      setSent(await platform.invite(slug, { email: email.trim(), role, ...(project.trim() ? { project_ref: project.trim() } : {}) }))
      setEmail('')
      setProject('')
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card form inline-form" onSubmit={submit}>
      <div className="card-head"><h2>Üye davet et</h2></div>
      <div className="form-row">
        <label className="field grow"><span>E-posta</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field"><span>Rol</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>{roleOptions}</select>
        </label>
        <label className="field"><span>Proje (isteğe bağlı)</span>
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="proje ref" className="mono" />
        </label>
        <button className="btn primary" disabled={busy}>Davet et</button>
      </div>
      {error && <ErrorBox message={error} />}
      {sent && (
        <div className="note">
          {sent.link
            ? <>E-posta ayarlı değil; bu bağlantıyı davet edilen kişiye siz iletin ({fmtDate(sent.expires_at)} tarihine kadar geçerli):
              <div className="secret-row"><code>{sent.link}</code><CopyButton text={sent.link} /></div></>
            : <>Davet e-postası gönderildi ({fmtDate(sent.expires_at)} tarihine kadar geçerli).</>}
        </div>
      )}
    </form>
  )
}

export function Members({ org, canManage }: OrgProps) {
  const { data, error, reload } = useLoad(() => platform.members(org.slug), [org.slug])
  const [busy, setBusy] = useState('')

  const act = async (m: Member, run: () => Promise<unknown>, done: string) => {
    setBusy(m.user_id)
    try {
      await run()
      toast(done)
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy('')
      reload()
    }
  }
  const remove = async (m: Member) => {
    if (await confirmDanger('Üyeyi çıkar', <p><strong>{m.email}</strong> bu organizasyondan çıkarılacak.</p>, 'Çıkar')) {
      act(m, () => platform.removeMember(org.slug, m.user_id), 'Üye çıkarıldı')
    }
  }

  return (
    <Page title="Üyeler" actions={<button className="icon-btn" onClick={reload} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>}>
      {canManage && <InviteForm slug={org.slug} />}
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Loading /> : (
        <div className="grid-wrap card">
          <table className="grid list-table">
            <thead><tr><th>E-posta</th><th>Rol</th><th>Kapsam</th><th><span className="sr-only">İşlemler</span></th></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={`${m.user_id}:${m.project_ref ?? ''}`}>
                  <td className="cell-main">{m.email}</td>
                  <td>
                    {canManage
                      ? <select aria-label={`Rol: ${m.email}`} value={m.role} disabled={busy === m.user_id}
                          onChange={(e) => act(m, () => platform.setRole(org.slug, m.user_id, e.target.value as Role), 'Rol değişti')}>{roleOptions}</select>
                      : ROLES[m.role] ?? m.role}
                  </td>
                  <td className="mono small">{m.project_ref ?? 'Tüm projeler'}</td>
                  <td>
                    {canManage && (
                      <div className="row-actions end">
                        <button className="icon-btn danger" disabled={busy === m.user_id} onClick={() => remove(m)} aria-label={`Çıkar: ${m.email}`} title="Çıkar">
                          <Icon name="trash" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  )
}

export function Tokens() {
  const { data, error, reload } = useLoad(platform.tokens, [])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  // Only in memory: the server returns the token once, and a reload must not bring it back.
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null)

  const create = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      setFresh(await platform.createToken(name.trim()))
      setName('')
      reload()
    } catch (err) {
      toast(errMsg(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id: string, label: string) => {
    if (!(await confirmDanger('Belirteci sil', <p><strong>{label}</strong> belirteciyle yapılan istekler reddedilecek.</p>))) return
    try {
      await platform.deleteToken(id)
      toast('Belirteç silindi')
    } catch (err) {
      toast(errMsg(err), 'error')
    }
    reload()
  }

  return (
    <Page title="Erişim belirteçleri">
      <p className="muted">Belirteçler yönetim API'sini (<code>/v1</code>) ve CLI'yi sizin rollerinizle kullanır.</p>
      <form className="card form inline-form" onSubmit={create}>
        <div className="form-row">
          <label className="field grow"><span>Ad</span>
            <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="ör. dizüstü" />
          </label>
          <button className="btn primary" disabled={busy || !name.trim()}>Belirteç oluştur</button>
        </div>
      </form>
      {fresh && (
        <div className="card token-box" role="status">
          <div className="card-head"><h2>{fresh.name}</h2><div className="spacer" />
            <button className="icon-btn" onClick={() => setFresh(null)} aria-label="Kapat"><Icon name="close" /></button>
          </div>
          <div className="token-body">
            <p className="small">Bu belirteç yalnızca şimdi gösterilir. Kopyalayıp güvenli bir yerde saklayın.</p>
            <div className="secret-row"><code>{fresh.token}</code><CopyButton text={fresh.token} /></div>
          </div>
        </div>
      )}
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Loading /> : !data.length ? <Empty>Henüz belirteç yok.</Empty> : (
        <div className="grid-wrap card">
          <table className="grid list-table">
            <thead><tr><th>Ad</th><th>Oluşturma</th><th>Son kullanım</th><th>Bitiş</th><th><span className="sr-only">İşlemler</span></th></tr></thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id}>
                  <td className="cell-main">{t.name}</td>
                  <td className="small">{fmtDate(t.created_at)}</td>
                  <td className="small">{fmtDate(t.last_used_at)}</td>
                  <td className="small">{t.expires_at ? fmtDate(t.expires_at) : 'Süresiz'}</td>
                  <td><div className="row-actions end">
                    <button className="icon-btn danger" onClick={() => remove(t.id, t.name)} aria-label={`Sil: ${t.name}`} title="Sil"><Icon name="trash" /></button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  )
}

const PAGE = 50

export function Audit({ org }: OrgProps) {
  const [older, setOlder] = useState<AuditRow[]>([])
  const [olderFull, setOlderFull] = useState(true) // the last "older" page came back full, so there may be more
  const [busy, setBusy] = useState(false)
  const { data, error, reload } = useLoad(() => platform.auditLog(org.slug, { limit: PAGE }), [org.slug])
  const rows = [...(data ?? []), ...older]
  const canMore = data?.length === PAGE && olderFull

  const loadMore = () => {
    setBusy(true)
    platform.auditLog(org.slug, { limit: PAGE, before: rows[rows.length - 1].at })
      .then((xs) => { setOlder((o) => [...o, ...xs]); setOlderFull(xs.length === PAGE) }, (e) => toast(errMsg(e), 'error'))
      .finally(() => setBusy(false))
  }
  const refresh = () => { setOlder([]); setOlderFull(true); reload() }

  return (
    <Page title="Denetim kaydı" actions={<button className="icon-btn" onClick={refresh} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>}>
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Loading /> : !rows.length ? <Empty>Kayıt yok.</Empty> : (
        <>
          <div className="grid-wrap card">
            <table className="grid list-table">
              <thead><tr><th>Zaman</th><th>Kişi</th><th>İşlem</th><th>Hedef</th><th>IP</th><th>Sonuç</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{fmtDate(r.at)}</td>
                    <td>{r.actor}</td>
                    <td className="mono">{r.action}</td>
                    <td className="mono small">{r.target ?? '—'}</td>
                    <td className="mono small">{r.ip ?? '—'}</td>
                    <td className="mono small" title={r.details?.body_keys?.length ? `alanlar: ${r.details.body_keys.join(', ')}` : undefined}>{r.details?.status ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canMore && <button className="btn" disabled={busy} onClick={loadMore}>Daha eski kayıtlar</button>}
        </>
      )}
    </Page>
  )
}

export function Capacity() {
  const { data, error, reload } = useLoad(platform.capacity, [])
  if (error) return <Page title="Kapasite"><ErrorBox message={error} onRetry={reload} /></Page>
  if (!data) return <Page title="Kapasite"><Loading /></Page>
  const parts = [
    { label: 'Paylaşılan servisler', mb: data.reserved_mb, cls: 'reserved' },
    { label: 'İş yuvası', mb: data.job_slot_mb, cls: 'job' },
    { label: 'Projeler', mb: data.used_mb, cls: 'used' },
    { label: 'Boş', mb: data.free_mb, cls: 'free' },
  ]
  const pct = (mb: number) => `${(100 * mb) / data.budget_mb}%`
  return (
    <Page title="Kapasite" actions={<button className="icon-btn" onClick={reload} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>}>
      <div className="card capacity">
        <div className="card-head"><h2>Bellek bütçesi</h2><span className="muted small">{data.budget_mb} MiB</span></div>
        <div className="meter" role="meter" aria-label="Bellek bütçesi" aria-valuemin={0} aria-valuemax={data.budget_mb}
          aria-valuenow={data.budget_mb - data.free_mb} aria-valuetext={`${data.free_mb} MiB boş`}>
          {parts.map((p) => <span key={p.cls} className={`meter-part ${p.cls}`} style={{ width: pct(p.mb) }} />)}
        </div>
        <ul className="legend">
          {parts.map((p) => <li key={p.cls}><span className={`swatch ${p.cls}`} aria-hidden="true" />{p.label}: {p.mb} MiB</li>)}
        </ul>
        <p className="small muted capacity-hosts">
          Bu hafta alınan yeni adres: {data.new_hosts_this_week} / {data.max_new_hosts_per_week}
        </p>
      </div>
      <div className="grid-wrap card">
        <table className="grid list-table">
          <thead><tr><th>Proje</th><th>Boyut</th><th>Sınır</th><th>Kullanım</th><th>Durum</th></tr></thead>
          <tbody>
            {data.projects.map((p) => (
              <tr key={p.ref}>
                <td><div className="cell-main">{p.name}</div><div className="mono small muted">{p.ref}</div></td>
                <td className="mono">{p.size}</td>
                <td className="mono">{p.cap_mb} MiB</td>
                <td className="mono">{p.mem_usage_mb == null ? '—' : `${p.mem_usage_mb} MiB`}</td>
                <td><StatusBadge status={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  )
}
