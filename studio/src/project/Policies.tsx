import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg } from '../api.ts'
import { useAdmin, useCan } from './context.ts'
import type { Policy, Relation } from '../api.ts'
import { Drawer, Empty, ErrorBox, Icon, Loading, confirmDanger, toast } from '../ui.tsx'
import { RlsBadge, SchemaSelect, hasRls } from './Tables.tsx'

const COMMANDS = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']

export default function Policies() {
  const [schema, setSchema] = useState('public')
  const [data, setData] = useState<{ tables: Relation[]; policies: Policy[] } | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)
  const api = useAdmin()
  const canWrite = useCan()('project.write')

  useEffect(() => {
    let live = true // a late response for the previous schema must not show (or be edited) under the new one
    setError('')
    Promise.all([api.tables(schema), api.policies(schema)])
      .then(([tables, policies]) => live && setData({ tables, policies }), (e) => live && setError(errMsg(e)))
    return () => { live = false }
  }, [schema, tick])

  const setRls = async (t: Relation, enabled: boolean) => {
    if (!enabled && !(await confirmDanger('RLS kapatılsın mı?',
      <><code>{t.schema}.{t.name}</code> için RLS kapatılırsa policy'ler devre dışı kalır ve tabloya erişimi olan her rol tüm satırları görebilir.</>,
      'RLS kapat'))) return
    try {
      await api.setRls(t.schema, t.name, enabled)
      toast(enabled ? `RLS açıldı: ${t.name}` : `RLS kapatıldı: ${t.name}`)
      reload()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  const drop = async (p: Policy) => {
    if (!(await confirmDanger('Policy silinsin mi?', <><code>{p.schema}.{p.table}</code> tablosundaki <code>{p.name}</code> policy'si silinecek.</>))) return
    try {
      await api.dropPolicy(p.schema, p.table, p.name)
      toast('Policy silindi')
      reload()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  const tables = data?.tables.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())) ?? []
  const off = data?.tables.filter((t) => hasRls(t) && !t.rls_enabled).length ?? 0

  return (
    <section className="page-main">
      <div className="toolbar">
        <h1 className="title">RLS policy'leri</h1>
        <div className="spacer" />
        <SchemaSelect value={schema} onChange={(s) => { setSchema(s); setData(null) }} />
        <label className="search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Tablo ara" aria-label="Tablo ara" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>
      <div className="scroll-area">
        {error ? <ErrorBox message={error} onRetry={reload} />
          : !data ? <Loading />
          : !data.tables.length ? <Empty>Bu şemada tablo yok.</Empty>
          : (
            <>
              {off > 0 && (
                <div className="warn-banner" role="note">
                  <strong>{off} tabloda RLS kapalı.</strong> RLS kapalı bir tabloda policy'ler hiç uygulanmaz: tabloda yetkisi olan
                  her rol (anon ve authenticated dahil) bütün satırları okuyup değiştirebilir. Bu tablolar için RLS'i açın ve gereken policy'leri ekleyin.
                </div>
              )}
              {!tables.length && <Empty>Eşleşen tablo yok.</Empty>}
              {tables.map((t) => {
                const ps = data.policies.filter((p) => p.table === t.name)
                if (!hasRls(t)) return (
                  <article key={t.name} className="card" aria-label={t.name}>
                    <header className="card-head">
                      <h2 className="mono">{t.name}</h2>
                      <RlsBadge rel={t} />
                    </header>
                    <p className="card-empty muted">Bu bir {t.relkind === 'f' ? 'yabancı tablo' : 'görünüm'}; RLS ve policy tanımlanamaz.</p>
                  </article>
                )
                return (
                  <article key={t.name} className={`card ${t.rls_enabled ? '' : 'card-danger'}`} aria-label={t.name}>
                    <header className="card-head">
                      <h2 className="mono">{t.name}</h2>
                      <RlsBadge rel={t} />
                      <span className="muted small">{ps.length} policy</span>
                      <div className="spacer" />
                      {canWrite && <>
                        <button role="switch" aria-checked={t.rls_enabled} className="switch" onClick={() => setRls(t, !t.rls_enabled)}
                          aria-label={`${t.name} için RLS`}>
                          <span className="switch-track"><span className="switch-thumb" /></span>
                          {t.rls_enabled ? 'RLS açık' : 'RLS kapalı'}
                        </button>
                        <button className="btn sm" onClick={() => setAdding(t.name)}><Icon name="plus" size={14} />Policy ekle</button>
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
                                <button className="icon-btn danger" onClick={() => drop(p)} aria-label={`${p.name} policy'sini sil`} title="Sil">
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
                        {t.rls_enabled ? 'Policy yok. RLS açık olduğundan tablo sahibi ve service_role dışında kimse satırlara erişemez.' : 'Policy yok.'}
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
  const schema = tables.find((t) => t.name === f.table)!.schema
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
      toast('Policy eklendi')
      onSaved()
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }

  return (
    <Drawer title="Policy ekle" subtitle={`${schema}.${f.table}`} onClose={onClose}
      footer={<><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Vazgeç</button>
        <button className="btn primary" form="policy-form" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</button></>}>
      <form id="policy-form" className="form" onSubmit={save}>
        <label className="field"><span>Ad</span>
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ör. kendi satırlarını okur" />
        </label>
        <label className="field"><span>Tablo</span>
          <select value={f.table} onChange={(e) => setF({ ...f, table: e.target.value })}>
            {tables.map((t) => <option key={t.name}>{t.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Komut</span>
          <select value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })}>
            {COMMANDS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field"><span>Roller <span className="muted">(virgülle ayırın)</span></span>
          <input className="mono" required value={f.roles} onChange={(e) => setF({ ...f, roles: e.target.value })} placeholder="authenticated, anon" />
        </label>
        <label className="field"><span>USING {noUsing && <span className="muted">· INSERT için kullanılmaz</span>}</span>
          <textarea className="mono" rows={3} disabled={noUsing} value={f.using} onChange={(e) => setF({ ...f, using: e.target.value })}
            placeholder="auth.uid() = user_id" />
        </label>
        <label className="field"><span>WITH CHECK {noCheck && <span className="muted">· {f.command} için kullanılmaz</span>}</span>
          <textarea className="mono" rows={3} disabled={noCheck} value={f.check} onChange={(e) => setF({ ...f, check: e.target.value })}
            placeholder="auth.uid() = user_id" />
        </label>
        {error && <ErrorBox message={error} />}
      </form>
    </Drawer>
  )
}
