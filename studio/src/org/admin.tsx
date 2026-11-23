import { useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg, platform } from '../api.ts'
import type { AuditRow, Member, Role } from '../api.ts'
import { Dots, Empty, ErrorBox, Icon, Loading, confirmDanger, toast } from '../ui.tsx'
import { ago, fmtDate, nf, rich, t, upper } from '../i18n/index.ts'
import type { Key } from '../i18n/index.ts'
import { CopyButton, Page, StatusBadge, useLoad } from './common.tsx'
import type { OrgProps } from './common.tsx'

export const ROLES: Record<Role, Key> = {
  owner: 'role.owner',
  administrator: 'role.administrator',
  developer: 'role.developer',
  read_only: 'role.read_only',
}
const roleOptions = (Object.keys(ROLES) as Role[]).map((r) => <option key={r} value={r}>{t(ROLES[r])}</option>)

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
      <div className="card-head"><Icon name="mail" /><h2>{t('members.invite')}</h2></div>
      <div className="form-row">
        <label className="field grow"><span>{t('common.email')}</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field"><span>{t('members.role')}</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>{roleOptions}</select>
        </label>
        <label className="field"><span>{t('members.project')}</span>
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder={t('members.projectRef')} className="mono" />
        </label>
        <button className="btn primary" disabled={busy}>{t('members.inviteBtn')}</button>
      </div>
      {error && <ErrorBox message={error} />}
      {sent && (
        <div className="note">
          {sent.link
            ? <>{t('members.inviteLink', { date: fmtDate(sent.expires_at) })}
              <div className="secret-row"><code>{sent.link}</code><CopyButton text={sent.link} /></div></>
            : t('members.inviteSent', { date: fmtDate(sent.expires_at) })}
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
    if (await confirmDanger(t('members.remove'), <p>{rich('members.removeMsg', { email: <strong>{m.email}</strong> })}</p>, t('members.removeBtn'))) {
      act(m, () => platform.removeMember(org.slug, m.user_id, m.id), t('members.removed'))
    }
  }

  return (
    <Page title={t('nav.members')} aside={org.name} meta={data && <span>{t('members.people', { n: new Set(data.map((m) => m.user_id)).size })}</span>}
      actions={<button className="icon-btn" onClick={reload} aria-label={t('common.refresh')} title={t('common.refresh')}><Icon name="refresh" /></button>}>
      {canManage && <InviteForm slug={org.slug} />}
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Loading /> : (
        <div className="grid-wrap card">
          <table className="grid list-table">
            <thead><tr><th>{t('common.email')}</th><th>{t('members.role')}</th><th>{t('members.scope')}</th><th><span className="sr-only">{t('common.actions')}</span></th></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={`${m.user_id}:${m.project_ref ?? ''}`}>
                  <td><span className="file-name"><span className="avatar v" aria-hidden="true">{upper(m.email.slice(0, 1))}</span><span className="cell-main">{m.email}</span></span></td>
                  <td>
                    {canManage
                      ? <select aria-label={t('members.roleOf', { email: m.email })} value={m.role} disabled={busy === m.user_id}
                          onChange={(e) => act(m, () => platform.setRole(org.slug, m.user_id, e.target.value as Role, m.id), t('members.roleChanged'))}>{roleOptions}</select>
                      : ROLES[m.role] ? t(ROLES[m.role]) : m.role}
                  </td>
                  <td>{m.project_ref ? <span className="chip">{m.project_ref}</span> : <span className="muted small">{t('members.allProjects')}</span>}</td>
                  <td>
                    {canManage && (
                      <div className="row-actions end">
                        <button className="icon-btn danger" disabled={busy === m.user_id} onClick={() => remove(m)} aria-label={t('members.removeOf', { email: m.email })} title={t('members.removeBtn')}>
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
    if (!(await confirmDanger(t('tokens.delete'), <p>{rich('tokens.deleteMsg', { name: <strong>{label}</strong> })}</p>))) return
    try {
      await platform.deleteToken(id)
      toast(t('tokens.deleted'))
    } catch (err) {
      toast(errMsg(err), 'error')
    }
    reload()
  }

  return (
    <Page title={t('nav.tokens')} meta={<span>{rich('tokens.meta', { v1: <code>/v1</code> })}</span>}>
      <form className="card form inline-form" onSubmit={create}>
        <div className="card-head"><Icon name="key" /><h2>{t('tokens.new')}</h2></div>
        <div className="form-row">
          <label className="field grow"><span>{t('common.name')}</span>
            <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('tokens.namePlaceholder')} />
          </label>
          <button className="btn primary" disabled={busy || !name.trim()}>{t('tokens.create')}</button>
        </div>
      </form>
      {fresh && (
        <div className="card token-box" role="status">
          <div className="card-head"><h2>{fresh.name}</h2><div className="spacer" />
            <button className="icon-btn" onClick={() => setFresh(null)} aria-label={t('common.close')}><Icon name="close" /></button>
          </div>
          <div className="token-body">
            <p className="small">{t('tokens.once')}</p>
            <div className="secret-row"><code>{fresh.token}</code><CopyButton text={fresh.token} /></div>
          </div>
        </div>
      )}
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Loading /> : !data.length ? <div className="card"><Empty icon="key"><b>{t('tokens.emptyTitle')}</b><p>{t('tokens.emptyHint')}</p></Empty></div> : (
        <div className="grid-wrap card">
          <table className="grid list-table">
            <thead><tr><th>{t('common.name')}</th><th>{t('common.created')}</th><th>{t('tokens.lastUsed')}</th><th>{t('tokens.expires')}</th><th><span className="sr-only">{t('common.actions')}</span></th></tr></thead>
            <tbody>
              {data.map((tk) => (
                <tr key={tk.id}>
                  <td className="cell-main">{tk.name}</td>
                  <td className="small">{fmtDate(tk.created_at)}</td>
                  <td className="small" title={tk.last_used_at ? fmtDate(tk.last_used_at) : undefined}>{tk.last_used_at ? ago(tk.last_used_at) : t('tokens.never')}</td>
                  <td className="small">{tk.expires_at ? fmtDate(tk.expires_at) : t('tokens.noExpiry')}</td>
                  <td><div className="row-actions end">
                    <button className="icon-btn danger" onClick={() => remove(tk.id, tk.name)} aria-label={t('common.deleteOf', { name: tk.name })} title={t('common.delete')}><Icon name="trash" /></button>
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
    platform.auditLog(org.slug, { limit: PAGE, before: String(rows[rows.length - 1].id) })
      .then((xs) => { setOlder((o) => [...o, ...xs]); setOlderFull(xs.length === PAGE) }, (e) => toast(errMsg(e), 'error'))
      .finally(() => setBusy(false))
  }
  const refresh = () => { setOlder([]); setOlderFull(true); reload() }

  return (
    <Page title={t('nav.audit')} aside={org.name} meta={<span>{t('audit.meta')}</span>} actions={<button className="icon-btn" onClick={refresh} aria-label={t('common.refresh')} title={t('common.refresh')}><Icon name="refresh" /></button>}>
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Loading /> : !rows.length ? <div className="card"><Empty icon="scroll"><b>{t('audit.emptyTitle')}</b><p>{t('audit.emptyHint')}</p></Empty></div> : (
        <>
          <div className="grid-wrap card">
            <table className="grid list-table">
              <thead><tr><th>{t('audit.time')}</th><th>{t('audit.actor')}</th><th>{t('audit.action')}</th><th>{t('audit.target')}</th><th>{t('audit.ip')}</th><th>{t('audit.result')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="small" title={fmtDate(r.at)}>{ago(r.at)}</td>
                    <td>{r.actor}</td>
                    <td className="mono">{r.action}</td>
                    <td className="mono small">{r.target ?? '—'}</td>
                    <td className="mono small">{r.ip ?? '—'}</td>
                    <td title={r.details?.body_keys?.length ? t('audit.fields', { list: r.details.body_keys.join(', ') }) : undefined}>
                      {r.details?.status == null ? '—' : <span className={`badge ${r.details.status < 400 ? 'ok' : 'danger'}`}>{r.details.status}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canMore && <button className="btn" disabled={busy} onClick={loadMore}>{t('audit.older')}</button>}
        </>
      )}
    </Page>
  )
}

export function Capacity() {
  const { data, error, reload } = useLoad(platform.capacity, [])
  const refresh = <button className="icon-btn" onClick={reload} aria-label={t('common.refresh')} title={t('common.refresh')}><Icon name="refresh" /></button>
  const title = t('nav.capacity')
  if (error) return <Page title={title} actions={refresh}><ErrorBox message={error} onRetry={reload} /></Page>
  if (!data) return <Page title={title}><Loading /></Page>
  const parts = [
    { label: t('capacity.shared'), mb: data.reserved_mb, cls: 'reserved' },
    { label: t('capacity.jobSlot'), mb: data.job_slot_mb, cls: 'job' },
    { label: t('nav.projects'), mb: data.used_mb, cls: 'used' },
    { label: t('capacity.free'), mb: data.free_mb, cls: 'free' },
  ]
  const pct = (mb: number) => `${(100 * mb) / data.budget_mb}%`
  const hostsLeft = Math.max(0, data.max_new_hosts_per_week - data.new_hosts_this_week)
  return (
    <Page title={title} aside={t('capacity.thisServer')} meta={<><span>{t('capacity.budget', { n: data.budget_mb })}</span><i>·</i><span>{t('projects.count', { n: data.projects.length })}</span></>} actions={refresh}>
      <div className="bento">
        <div className="card span8 kpi">
          <div className="micro">{t('capacity.memoryBudget')}</div>
          <div className="big"><b>{nf(data.free_mb)}</b><span className="tail">{t('capacity.mibFree')}</span></div>
          <div className="meter" role="meter" aria-label={t('capacity.memoryBudget')} aria-valuemin={0} aria-valuemax={data.budget_mb}
            aria-valuenow={data.budget_mb - data.free_mb} aria-valuetext={t('newProject.free', { n: data.free_mb })}>
            {parts.map((p) => <span key={p.cls} className={`meter-part ${p.cls}`} style={{ width: pct(p.mb) }} />)}
          </div>
          <ul className="legend">
            {parts.map((p) => <li key={p.cls}><span className={`swatch ${p.cls}`} aria-hidden="true" />{p.label}: {nf(p.mb)} MiB</li>)}
          </ul>
        </div>
        <div className="card span4 kpi">
          <div className="micro">{t('capacity.newHosts')}</div>
          <div className="big"><b>{nf(data.new_hosts_this_week)}</b><span className="tail">/ {nf(data.max_new_hosts_per_week)}</span></div>
          <Dots fill={data.max_new_hosts_per_week ? data.new_hosts_this_week / data.max_new_hosts_per_week : 0} n={data.max_new_hosts_per_week || 1} />
          <div className="foot"><span>{t('capacity.left', { n: hostsLeft })}</span><span>{t('capacity.certNote')}</span></div>
        </div>
        <div className="card span12">
          <div className="card-head"><h2>{t('nav.projects')}</h2><span className="muted small">{t('capacity.projectsHint')}</span></div>
          <div className="card-body">
            <div className="grid-wrap">
              <table className="grid list-table">
                <thead><tr><th>{t('capacity.project')}</th><th>{t('common.size')}</th><th>{t('capacity.limit')}</th><th>{t('capacity.usage')}</th><th className="hide-sm"><span className="sr-only">{t('capacity.share')}</span></th><th>{t('common.status')}</th></tr></thead>
                <tbody>
                  {data.projects.map((p) => (
                    <tr key={p.ref}>
                      <td><div className="cell-main">{p.name}</div><div className="mono small muted">{p.ref}</div></td>
                      <td className="mono">{p.size}</td>
                      <td className="mono">{nf(p.cap_mb)} MiB</td>
                      <td className="mono">{p.mem_usage_mb == null ? '—' : `${nf(p.mem_usage_mb)} MiB`}</td>
                      <td className="hide-sm">{p.mem_usage_mb != null && <span className="bar"><i style={{ width: `${Math.min(100, (100 * p.mem_usage_mb) / p.cap_mb)}%` }} /></span>}</td>
                      <td><StatusBadge status={p.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </Page>
  )
}
