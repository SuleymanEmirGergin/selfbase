import { useEffect, useState } from 'react'
import { errMsg } from '../api.ts'
import { useAdmin, useCan } from './context.ts'
import type { User } from '../api.ts'
import { Empty, ErrorBox, Icon, Loading, confirmDanger, fmtDate, toast } from '../ui.tsx'

const PAGE = 50
const FOREVER = '2999-12-31T00:00:00Z'
const BAN_DAYS = [[1, '1 gün'], [7, '7 gün'], [30, '30 gün'], [0, 'süresiz']] as const
const banLabel = (days: number) => BAN_DAYS.find(([d]) => d === days)![1]

/** Duration picker inside the ban confirm; writes the choice into `pick` so the caller can read it after confirming. */
function BanChoice({ who, pick }: { who: string; pick: { days: number } }) {
  const [days, setDays] = useState(pick.days)
  return (
    <div className="form">
      <label className="field"><span>Süre</span>
        <select value={days} onChange={(e) => { pick.days = Number(e.target.value); setDays(pick.days) }}>
          {BAN_DAYS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
        </select>
      </label>
      <p className="confirm-text">
        <code>{who}</code> {days ? `${banLabel(days)} boyunca` : 'süresiz'} banlanacak ve tüm oturumları kapatılacak.
      </p>
    </div>
  )
}
const isBanned = (u: User) => !!u.banned_until && Date.parse(u.banned_until) > Date.now()

export default function Users() {
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ users: User[]; total: number } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)
  const api = useAdmin()
  const canWrite = useCan()('project.write')

  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setOffset(0) }, 250)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    setError('')
    let live = true // results of an older search must not replace the latest one
    api.users(q, PAGE, offset).then((d) => live && setData(d), (e) => live && setError(errMsg(e)))
    return () => { live = false }
  }, [q, offset, tick])

  const act = async (u: User, fn: () => Promise<unknown>, done: string) => {
    setBusy(u.id)
    try {
      await fn()
      toast(done)
      reload()
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const ban = async (u: User) => {
    const pick = { days: 1 }
    if (!(await confirmDanger('Kullanıcı banlansın mı?', <BanChoice who={u.email || u.id} pick={pick} />, 'Banla'))) return
    const until = pick.days ? new Date(Date.now() + pick.days * 86400_000).toISOString() : FOREVER
    act(u, () => api.updateUser(u.id, { banned_until: until }), `Kullanıcı banlandı (${banLabel(pick.days)})`)
  }
  const remove = async (u: User) => {
    if (!(await confirmDanger('Kullanıcı silinsin mi?', <><code>{u.email || u.id}</code> ve oturumları kalıcı olarak silinecek.</>))) return
    act(u, () => api.deleteUser(u.id), 'Kullanıcı silindi')
  }

  const total = data?.total ?? 0

  return (
    <section className="page-main">
      <div className="toolbar">
        <h1 className="title">Kullanıcılar</h1>
        {data && <span className="muted small">{total.toLocaleString('tr-TR')} kullanıcı</span>}
        <div className="spacer" />
        <label className="search wide">
          <Icon name="search" size={14} />
          <input type="search" placeholder="E-posta ya da ID ara" aria-label="Kullanıcı ara" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button className="icon-btn" onClick={reload} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>
      </div>
      <div className="grid-area">
        {error ? <ErrorBox message={error} onRetry={reload} />
          : !data ? <Loading />
          : !data.users.length ? <Empty>{q ? 'Aramaya uyan kullanıcı yok.' : 'Henüz kullanıcı yok.'}</Empty>
          : (
            <div className="grid-wrap">
              <table className="grid list-table">
                <thead>
                  <tr>
                    <th><div className="th-btn">E-posta</div></th>
                    <th><div className="th-btn">Durum</div></th>
                    <th><div className="th-btn">Sağlayıcı</div></th>
                    <th><div className="th-btn">Oluşturma</div></th>
                    <th><div className="th-btn">Son giriş</div></th>
                    <th><div className="th-btn"><span className="sr-only">İşlemler</span></div></th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="cell-main">{u.email || u.phone || '—'}</div>
                        <div className="mono small muted" title={u.id}>{u.id}</div>
                      </td>
                      <td className="badges">
                        {u.email_confirmed_at ? <span className="badge ok">Doğrulandı</span> : <span className="badge">Doğrulanmadı</span>}
                        {isBanned(u) && <span className="badge danger" title={`Bitiş: ${fmtDate(u.banned_until)}`}>Banlı</span>}
                      </td>
                      <td className="mono small">{[...new Set(u.identities.map((i) => i.provider))].join(', ') || 'email'}</td>
                      <td className="small">{fmtDate(u.created_at)}</td>
                      <td className="small">{fmtDate(u.last_sign_in_at)}</td>
                      <td>
                        {canWrite && <div className="row-actions end">
                          {!u.email_confirmed_at && (
                            <button className="btn sm" disabled={busy === u.id}
                              onClick={() => act(u, () => api.updateUser(u.id, { email_confirmed: true }), 'E-posta doğrulandı olarak işaretlendi')}>
                              Doğrula
                            </button>
                          )}
                          {isBanned(u)
                            ? <button className="btn sm" disabled={busy === u.id} onClick={() => act(u, () => api.updateUser(u.id, { banned_until: null }), 'Ban kaldırıldı')}>Banı kaldır</button>
                            : <button className="btn sm" disabled={busy === u.id} onClick={() => ban(u)}>Banla</button>}
                          <button className="icon-btn danger" disabled={busy === u.id} onClick={() => remove(u)} aria-label={`${u.email || u.id} kullanıcısını sil`} title="Sil">
                            <Icon name="trash" />
                          </button>
                        </div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
      <div className="pager">
        <span className="muted">{total ? `${offset + 1}–${Math.min(offset + PAGE, total)} / ${total.toLocaleString('tr-TR')}` : ''}</span>
        <div className="spacer" />
        <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Önceki</button>
        <button className="btn sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Sonraki</button>
      </div>
    </section>
  )
}
