import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg } from '../api.ts'
import { useAdmin, useCan } from './context.ts'
import type { Policy, Relation } from '../api.ts'
import { Drawer, Empty, ErrorBox, Icon, Loading, confirmDanger, toast } from '../ui.tsx'
import { RlsBadge, SchemaSelect, hasRls, kindLabel } from './Tables.tsx'
import { rich, t } from '../i18n/index.ts'

const COMMANDS = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']

export default function Policies() {
  const [schema, setSchema] = useState('public')
  const [data, setData] = useState<{ tables: Relation[]; policies: Policy[] } | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const reload = () => setTick((n) => n + 1)
  const api = useAdmin()
  const canWrite = useCan()('project.write')

  useEffect(() => {
    let live = true // a late response for the previous schema must not show (or be edited) under the new one
    setError('')
    Promise.all([api.tables(schema), api.policies(schema)])
      .then(([tables, policies]) => live && setData({ tables, policies }), (e) => live && setError(errMsg(e)))
    return () => { live = false }
  }, [schema, tick])

  const setRls = async (rel: Relation, enabled: boolean) => {
    if (!enabled && !(await confirmDanger(t('rls.disableConfirm'),
      rich('rls.disableMsg', { table: <code>{rel.schema}.{rel.name}</code> }),
      t('rls.disableBtn')))) return
    try {
      await api.setRls(rel.schema, rel.name, enabled)
      toast(t(enabled ? 'rls.enabled' : 'rls.disabled', { table: rel.name }))
      reload()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  const drop = async (p: Policy) => {
    if (!(await confirmDanger(t('rls.dropConfirm'), rich('rls.dropMsg', { policy: <code>{p.name}</code>, table: <code>{p.schema}.{p.table}</code> })))) return
    try {
      await api.dropPolicy(p.schema, p.table, p.name)
      toast(t('rls.dropped'))
      reload()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  const tables = data?.tables.filter((x) => x.name.toLowerCase().includes(search.toLowerCase())) ?? []
  const off = data?.tables.filter((x) => hasRls(x) && !x.rls_enabled).length ?? 0

  return (
    <section className="page-main">
      <div className="toolbar">
        <h1 className="title">{t('rls.title')}</h1>
        <div className="spacer" />
        <SchemaSelect value={schema} onChange={(s) => { setSchema(s); setData(null) }} />
        <label className="search">
          <Icon name="search" size={14} />
          <input type="search" placeholder={t('tables.search')} aria-label={t('tables.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>
      <div className="scroll-area">
        {error ? <ErrorBox message={error} onRetry={reload} />
          : !data ? <Loading />
          : !data.tables.length ? <Empty>{t('tables.noTables')}</Empty>
          : (
            <>
              {off > 0 && (
                <div className="warn-banner" role="note">
                  <strong>{t('rls.offCount', { n: off })}</strong> {t('rls.offText')}
                </div>
              )}
              {!tables.length && <Empty>{t('tables.noMatch')}</Empty>}
              {tables.map((rel) => {
                const ps = data.policies.filter((p) => p.table === rel.name)
                if (!hasRls(rel)) return (
                  <article key={rel.name} className="card" aria-label={rel.name}>
                    <header className="card-head">
                      <h2 className="mono">{rel.name}</h2>
                      <RlsBadge rel={rel} />
                    </header>
                    <p className="card-empty muted">{t('rls.noRls', { kind: kindLabel(rel.relkind) })}</p>
                  </article>
                )
                return (
                  <article key={rel.name} className={`card ${rel.rls_enabled ? '' : 'card-danger'}`} aria-label={rel.name}>
                    <header className="card-head">
                      <h2 className="mono">{rel.name}</h2>
                      <RlsBadge rel={rel} />
                      <span className="muted small">{t('rls.policyCount', { n: ps.length })}</span>
                      <div className="spacer" />
                      {canWrite && <>
                        <button role="switch" aria-checked={rel.rls_enabled} className="switch" onClick={() => setRls(rel, !rel.rls_enabled)}
                          aria-label={t('rls.switch', { table: rel.name })}>
                          <span className="switch-track"><span className="switch-thumb" /></span>
                          {t(rel.rls_enabled ? 'rls.on' : 'rls.off')}
                        </button>
                        <button className="btn sm" onClick={() => setAdding(rel.name)}><Icon name="plus" size={14} />{t('rls.add')}</button>
                      </>}
                    </header>
                    {ps.length ? (
                      <ul className="policies">
                        {ps.map((p) => (
                          <li key={p.name} className="policy">
                            <div className="policy-head">
                              <span className="policy-name">{p.name}</span>
                              <span className="chip">{p.command}</span>
                              {!p.permissive && <span className="chip warn">RESTRICTIVE</span>}
                              <span className="mono small muted">{p.roles.join(', ')}</span>
                              <div className="spacer" />
                              {canWrite && (
                                <button className="icon-btn danger" onClick={() => drop(p)} aria-label={t('rls.dropOf', { policy: p.name })} title={t('common.delete')}>
                                  <Icon name="trash" />
                                </button>
                              )}
                            </div>
                            <dl className="policy-exprs">
                              <dt>USING</dt><dd>{p.using ? <code>{p.using}</code> : <span className="muted">—</span>}</dd>
                              <dt>WITH CHECK</dt><dd>{p.check ? <code>{p.check}</code> : <span className="muted">—</span>}</dd>
                            </dl>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="card-empty muted">
                        {t(rel.rls_enabled ? 'rls.noneOn' : 'rls.none')}
                      </p>
                    )}
                  </article>
                )
              })}
            </>
          )}
      </div>
      {adding && data && (
        <PolicyDrawer tables={data.tables.filter(hasRls)} table={adding} onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); reload() }} />
      )}
    </section>
  )
}

function PolicyDrawer({ tables, table, onClose, onSaved }: {
  tables: Relation[]; table: string; onClose: () => void; onSaved: () => void
}) {
  const [f, setF] = useState({ table, name: '', command: 'ALL', roles: 'public', using: '', check: '' })
  // the schema always comes from the relation the form names, never from the current selector
  const schema = tables.find((x) => x.name === f.table)!.schema
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const api = useAdmin()
  const noUsing = f.command === 'INSERT'
  const noCheck = f.command === 'SELECT' || f.command === 'DELETE'

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.createPolicy({
        schema, table: f.table, name: f.name.trim(), command: f.command,
        roles: f.roles.split(',').map((r) => r.trim()).filter(Boolean),
        using: noUsing ? undefined : f.using.trim() || undefined,
        check: noCheck ? undefined : f.check.trim() || undefined,
      })
      toast(t('rls.added'))
      onSaved()
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }

  return (
    <Drawer title={t('rls.add')} subtitle={`${schema}.${f.table}`} onClose={onClose}
      footer={<><div className="spacer" /><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" form="policy-form" disabled={busy}>{t(busy ? 'common.saving' : 'common.save')}</button></>}>
      <form id="policy-form" className="form" onSubmit={save}>
        <label className="field"><span>{t('common.name')}</span>
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('rls.namePlaceholder')} />
        </label>
        <label className="field"><span>{t('rls.table')}</span>
          <select value={f.table} onChange={(e) => setF({ ...f, table: e.target.value })}>
            {tables.map((x) => <option key={x.name}>{x.name}</option>)}
          </select>
        </label>
        <label className="field"><span>{t('rls.command')}</span>
          <select value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })}>
            {COMMANDS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field"><span>{t('rls.roles')} <span className="muted">{t('rls.rolesHint')}</span></span>
          <input className="mono" required value={f.roles} onChange={(e) => setF({ ...f, roles: e.target.value })} placeholder="authenticated, anon" />
        </label>
        <label className="field"><span>USING {noUsing && <span className="muted">{t('rls.notFor', { cmd: 'INSERT' })}</span>}</span>
          <textarea className="mono" rows={3} disabled={noUsing} value={f.using} onChange={(e) => setF({ ...f, using: e.target.value })}
            placeholder="auth.uid() = user_id" />
        </label>
        <label className="field"><span>WITH CHECK {noCheck && <span className="muted">{t('rls.notFor', { cmd: f.command })}</span>}</span>
          <textarea className="mono" rows={3} disabled={noCheck} value={f.check} onChange={(e) => setF({ ...f, check: e.target.value })}
            placeholder="auth.uid() = user_id" />
        </label>
        {error && <ErrorBox message={error} />}
      </form>
    </Drawer>
  )
}
