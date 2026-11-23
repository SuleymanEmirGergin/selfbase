import { useEffect, useState } from 'react'
import { errMsg } from '../api.ts'
import { useAdmin, useCan } from './context.ts'
import type { User } from '../api.ts'
import { Empty, ErrorBox, Icon, Loading, confirmDanger, toast } from '../ui.tsx'
import { fmtDate, rich, t } from '../i18n/index.ts'

const PAGE = 50
const FOREVER = '2999-12-31T00:00:00Z'
const BAN_DAYS = [1, 7, 30, 0]
const banLabel = (days: number) => days ? t('users.days', { n: days }) : t('users.forever')

/** Duration picker inside the ban confirm; writes the choice into `pick` so the caller can read it after confirming. */
function BanChoice({ who, pick }: { who: string; pick: { days: number } }) {
  const [days, setDays] = useState(pick.days)
  return (
    <div className="form">
      <label className="field"><span>{t('users.duration')}</span>
        <select value={days} onChange={(e) => { pick.days = Number(e.target.value); setDays(pick.days) }}>
          {BAN_DAYS.map((d) => <option key={d} value={d}>{banLabel(d)}</option>)}
        </select>
      </label>
      <p className="confirm-text">
        {days ? rich('users.banFor', { who: <code>{who}</code>, dur: banLabel(days) }) : rich('users.banForever', { who: <code>{who}</code> })}
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
  const reload = () => setTick((n) => n + 1)
  const api = useAdmin()
  const canWrite = useCan()('project.write')

  useEffect(() => {
    const timer = setTimeout(() => { setQ(search.trim()); setOffset(0) }, 250)
    return () => clearTimeout(timer)
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
    if (!(await confirmDanger(t('users.banConfirm'), <BanChoice who={u.email || u.id} pick={pick} />, t('users.ban')))) return
    const until = pick.days ? new Date(Date.now() + pick.days * 86400_000).toISOString() : FOREVER
    act(u, () => api.updateUser(u.id, { banned_until: until }), t('users.banned', { dur: banLabel(pick.days) }))
  }
  const remove = async (u: User) => {
    if (!(await confirmDanger(t('users.deleteConfirm'), rich('users.deleteMsg', { who: <code>{u.email || u.id}</code> })))) return
    act(u, () => api.deleteUser(u.id), t('users.deleted'))
  }

  const total = data?.total ?? 0

  return (
    <section className="page-main">
      <div className="toolbar">
        <h1 className="title">{t('nav.users')}</h1>
        {data && <span className="muted small">{t('users.count', { n: total })}</span>}
        <div className="spacer" />
        <label className="search wide">
          <Icon name="search" size={14} />
          <input type="search" placeholder={t('users.searchPlaceholder')} aria-label={t('users.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button className="icon-btn" onClick={reload} aria-label={t('common.refresh')} title={t('common.refresh')}><Icon name="refresh" /></button>
      </div>
      <div className="grid-area">
        {error ? <ErrorBox message={error} onRetry={reload} />
          : !data ? <Loading />
          : !data.users.length ? <Empty>{t(q ? 'users.noMatch' : 'users.none')}</Empty>
          : (
            <div className="grid-wrap">
              <table className="grid list-table">
                <thead>
                  <tr>
                    <th><div className="th-btn">{t('common.email')}</div></th>
                    <th><div className="th-btn">{t('common.status')}</div></th>
                    <th><div className="th-btn">{t('users.provider')}</div></th>
                    <th><div className="th-btn">{t('common.created')}</div></th>
                    <th><div className="th-btn">{t('users.lastSignIn')}</div></th>
                    <th><div className="th-btn"><span className="sr-only">{t('common.actions')}</span></div></th>
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
                        {u.email_confirmed_at ? <span className="badge ok">{t('users.confirmed')}</span> : <span className="badge">{t('users.unconfirmed')}</span>}
                        {isBanned(u) && <span className="badge danger" title={t('users.until', { date: fmtDate(u.banned_until) })}>{t('users.bannedBadge')}</span>}
                      </td>
                      <td className="mono small">{[...new Set(u.identities.map((i) => i.provider))].join(', ') || 'email'}</td>
                      <td className="small">{fmtDate(u.created_at)}</td>
                      <td className="small">{fmtDate(u.last_sign_in_at)}</td>
                      <td>
                        {canWrite && <div className="row-actions end">
                          {!u.email_confirmed_at && (
                            <button className="btn sm" disabled={busy === u.id}
                              onClick={() => act(u, () => api.updateUser(u.id, { email_confirmed: true }), t('users.markedConfirmed'))}>
                              {t('users.confirm')}
                            </button>
                          )}
                          {isBanned(u)
                            ? <button className="btn sm" disabled={busy === u.id} onClick={() => act(u, () => api.updateUser(u.id, { banned_until: null }), t('users.unbanned'))}>{t('users.unban')}</button>
                            : <button className="btn sm" disabled={busy === u.id} onClick={() => ban(u)}>{t('users.ban')}</button>}
                          <button className="icon-btn danger" disabled={busy === u.id} onClick={() => remove(u)} aria-label={t('users.deleteOf', { who: u.email || u.id })} title={t('common.delete')}>
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
        <span className="muted">{total ? t('users.range', { from: offset + 1, to: Math.min(offset + PAGE, total), total }) : ''}</span>
        <div className="spacer" />
        <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('common.prev')}</button>
        <button className="btn sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>{t('common.next')}</button>
      </div>
    </section>
  )
}
