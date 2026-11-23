import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg } from '../api.ts'
import { useAdmin, useCan } from './context.ts'
import type { Column, Relation, Row } from '../api.ts'
import { Grid, cellText } from '../Grid.tsx'
import type { Sort } from '../Grid.tsx'
import { Drawer, Empty, ErrorBox, Icon, Loading, toast, toastUndo } from '../ui.tsx'

const PAGE = 50
const OPS = [
  ['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['like', 'like'], ['ilike', 'ilike'], ['is', 'is'],
] as const
const JSON_TYPES = new Set(['json', 'jsonb'])

/** Shared by Tables and RLS: schema list with the selected schema. */
export function SchemaSelect({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const [schemas, setSchemas] = useState<string[]>([value])
  const [error, setError] = useState('')
  const api = useAdmin()
  useEffect(() => {
    let live = true
    api.schemas().then((s) => live && setSchemas(s), (e) => live && setError(errMsg(e)))
    return () => { live = false }
  }, [])
  return (
    <div className="schema-select">
      <label className="field inline">
        <span>Şema</span>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {schemas.map((s) => <option key={s}>{s}</option>)}
        </select>
      </label>
      {error && <div className="field-error" role="alert">Şemalar alınamadı: {error}</div>}
    </div>
  )
}

/** Plain and partitioned tables; views, materialized views and foreign tables cannot have RLS. */
export const hasRls = (rel: Relation) => rel.relkind === 'r' || rel.relkind === 'p'
const KIND: Record<string, string> = { v: 'görünüm', m: 'mat. görünüm', f: 'yabancı tablo' }

export const RlsBadge = ({ rel }: { rel: Relation }) =>
  !hasRls(rel) ? <span className="badge">{KIND[rel.relkind] ?? rel.relkind}</span>
    : rel.rls_enabled ? <span className="badge ok">RLS</span> : <span className="badge danger">RLS kapalı</span>

export default function Tables() {
  const [schema, setSchema] = useState('public')
  const [tables, setTables] = useState<Relation[] | null>(null)
  const [tablesErr, setTablesErr] = useState('')
  const [search, setSearch] = useState('')
  const [name, setName] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const api = useAdmin()

  useEffect(() => {
    let live = true // a response for a schema that is no longer selected is dropped
    setTables(null)
    setTablesErr('')
    api.tables(schema).then((t) => {
      if (!live) return
      setTables(t)
      setName((n) => (n && t.some((x) => x.name === n) ? n : t[0]?.name ?? null))
    }, (e) => live && setTablesErr(errMsg(e)))
    return () => { live = false }
  }, [schema, tick])

  const shown = tables?.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())) ?? []
  const rel = tables?.find((t) => t.name === name) ?? null

  return (
    <div className="split">
      <aside className="subnav" aria-label="Tablolar">
        <div className="subnav-head">
          <SchemaSelect value={schema} onChange={(s) => { setSchema(s); setName(null) }} />
          <label className="search">
            <Icon name="search" size={14} />
            <input type="search" placeholder="Tablo ara" aria-label="Tablo ara" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        </div>
        {tablesErr ? <ErrorBox message={tablesErr} onRetry={() => setTick((t) => t + 1)} />
          : !tables ? <Loading />
          : !shown.length ? <Empty>{tables.length ? 'Eşleşen tablo yok' : 'Bu şemada tablo yok'}</Empty>
          : (
            <ul className="list">
              {shown.map((t) => (
                <li key={t.name}>
                  <button className={t.name === name ? 'active' : undefined} onClick={() => setName(t.name)} aria-current={t.name === name}>
                    <Icon name="table" size={14} />
                    <span className="list-name">{t.name}</span>
                    {(!hasRls(t) || !t.rls_enabled) && <RlsBadge rel={t} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
      </aside>
      {rel ? <TableView key={`${rel.schema}.${rel.name}`} rel={rel} /> : (
        <section className="page-main">{tables && <Empty>Soldan bir tablo seçin.</Empty>}</section>
      )}
    </div>
  )
}

function TableView({ rel }: { rel: Relation }) {
  const [data, setData] = useState<{ rows: Row[]; total: number } | null>(null)
  const [error, setError] = useState('')
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<Sort>(null)
  const [filter, setFilter] = useState({ col: rel.columns[0]?.name ?? '', op: 'eq', value: '' })
  const [applied, setApplied] = useState('')
  const [editing, setEditing] = useState<'new' | number | null>(null)
  const [tick, setTick] = useState(0)
  // Rows deleted but still inside their undo window: hidden here, sent to the server only when the window ends.
  const [hidden, setHidden] = useState<string[]>([])
  const pkCols = rel.columns.filter((c) => c.is_pk)
  const api = useAdmin()
  const canWrite = useCan()('project.write')
  const pkOf = (r: Row) => Object.fromEntries(pkCols.map((c) => [c.name, r[c.name]]))
  const keyOf = (r: Row) => JSON.stringify(pkOf(r))

  useEffect(() => {
    let live = true // only the latest page/sort/filter request may land
    setError('')
    api.rows(rel.schema, rel.name, { limit: PAGE, offset, order: sort ? `${sort.col}.${sort.dir}` : undefined, filter: applied || undefined })
      .then((d) => live && setData(d), (e) => { if (live) { setError(errMsg(e)); setData(null) } })
    return () => { live = false }
  }, [rel, offset, sort, applied, tick])

  const onSort = (col: string) => {
    setOffset(0)
    setSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null))
  }
  const applyFilter = (e: FormEvent) => {
    e.preventDefault()
    setOffset(0)
    setApplied(filter.value === '' && filter.op !== 'is' ? '' : `${filter.col}.${filter.op}.${filter.op === 'is' ? filter.value || 'null' : filter.value}`)
  }
  const clearFilter = () => { setFilter((f) => ({ ...f, value: '' })); setApplied(''); setOffset(0) }

  const columns = rel.columns.map((c) => ({ name: c.name, type: c.type, pk: c.is_pk }))
  const visible = useMemo(() => data?.rows.filter((r) => !hidden.includes(keyOf(r))) ?? [], [data, hidden])
  const rows = useMemo(() => visible.map((r) => rel.columns.map((c) => r[c.name])), [visible, rel])
  const total = Math.max(0, (data?.total ?? 0) - (data ? data.rows.length - visible.length : 0))
  const editRow = typeof editing === 'number' ? visible[editing] : undefined

  const deleteRow = (row: Row) => {
    const key = keyOf(row)
    const label = Object.entries(pkOf(row)).map(([k, v]) => `${k}=${cellText(v)}`).join(', ')
    const unhide = () => setHidden((h) => h.filter((k) => k !== key))
    setEditing(null)
    setHidden((h) => [...h, key])
    toastUndo('Satır silindi', `${rel.schema}.${rel.name} · ${label}`, () => {
      api.deleteRow(rel.schema, rel.name, pkOf(row)).then(() => { unhide(); setTick((t) => t + 1) }, (e) => { unhide(); toast(errMsg(e), 'error') })
    }, unhide)
  }

  return (
    <section className="page-main">
      <div className="toolbar">
        <h1 className="title mono"><span className="muted">{rel.schema}.</span>{rel.name}</h1>
        <RlsBadge rel={rel} />
        <div className="spacer" />
        <button className="icon-btn" onClick={() => setTick((t) => t + 1)} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>
        {canWrite && <button className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" />Satır ekle</button>}
      </div>
      <form className="filterbar" onSubmit={applyFilter} aria-label="Filtre">
        <select aria-label="Filtre kolonu" value={filter.col} onChange={(e) => setFilter({ ...filter, col: e.target.value })}>
          {rel.columns.map((c) => <option key={c.name}>{c.name}</option>)}
        </select>
        <select aria-label="Operatör" value={filter.op} onChange={(e) => setFilter({ ...filter, op: e.target.value, value: '' })}>
          {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {filter.op === 'is' ? (
          <select aria-label="Değer" value={filter.value || 'null'} onChange={(e) => setFilter({ ...filter, value: e.target.value })}>
            <option>null</option><option>true</option><option>false</option>
          </select>
        ) : (
          <input className="mono grow" aria-label="Değer" placeholder={filter.op.includes('like') ? '%örnek%' : 'değer'} value={filter.value}
            onChange={(e) => setFilter({ ...filter, value: e.target.value })} />
        )}
        <button className="btn">Filtrele</button>
        {applied && <button type="button" className="btn ghost" onClick={clearFilter}>Temizle</button>}
      </form>

      <div className="grid-area">
        {error ? <ErrorBox message={error} onRetry={() => setTick((t) => t + 1)} />
          : !data ? <Loading />
          : (
            <>
              <Grid columns={columns} rows={rows} sort={sort} onSort={onSort} onRowClick={(i) => setEditing(i)}
                selected={typeof editing === 'number' ? editing : null} />
              {!rows.length && <Empty>{applied ? 'Filtreye uyan satır yok.' : 'Bu tablo boş.'}</Empty>}
            </>
          )}
      </div>

      <div className="pager">
        <span className="muted">
          {total ? `${offset + 1}–${Math.min(offset + PAGE, total)} / ${total.toLocaleString('tr-TR')} satır` : '0 satır'}
          {!pkCols.length && ' · birincil anahtar yok, satırlar düzenlenemez'}
        </span>
        <div className="spacer" />
        <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Önceki</button>
        <button className="btn sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Sonraki</button>
      </div>

      {editing !== null && (editing === 'new' || editRow) && (
        <RowDrawer rel={rel} row={editing === 'new' ? null : editRow!} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setTick((t) => t + 1) }} onDelete={deleteRow} />
      )}
    </section>
  )
}

type FieldState = { text: string; isNull: boolean }
const initial = (row: Row | null, c: Column): FieldState =>
  row ? { text: row[c.name] === null ? '' : cellText(row[c.name]), isNull: row[c.name] === null } : { text: '', isNull: false }

function RowDrawer({ rel, row, onClose, onSaved, onDelete }: {
  rel: Relation; row: Row | null; onClose: () => void; onSaved: () => void; onDelete: (row: Row) => void
}) {
  const start = useMemo(() => Object.fromEntries(rel.columns.map((c) => [c.name, initial(row, c)])), [rel, row])
  const [form, setForm] = useState<Record<string, FieldState>>(start)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pkCols = rel.columns.filter((c) => c.is_pk)
  const pk = row && pkCols.length ? Object.fromEntries(pkCols.map((c) => [c.name, row[c.name]])) : null
  const pkLabel = pk ? Object.entries(pk).map(([k, v]) => `${k}=${cellText(v)}`).join(', ') : ''
  const api = useAdmin()
  const canWrite = useCan()('project.write')
  const noPk = !!row && !pk
  const readOnly = noPk || !canWrite

  const set = (name: string, patch: Partial<FieldState>) => setForm((f) => ({ ...f, [name]: { ...f[name], ...patch } }))

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    const values: Row = {}
    try {
      for (const c of rel.columns) {
        const f = form[c.name]
        const changed = row ? f.text !== start[c.name].text || f.isNull !== start[c.name].isNull : f.isNull || f.text !== ''
        if (!changed) continue
        values[c.name] = f.isNull ? null : JSON_TYPES.has(c.type) ? JSON.parse(f.text) : f.text
      }
    } catch {
      setError('JSON kolonundaki değer geçerli JSON değil.')
      return
    }
    if (row && !Object.keys(values).length) return onClose()
    setBusy(true)
    try {
      if (row) await api.updateRow(rel.schema, rel.name, pk!, values)
      else await api.insertRow(rel.schema, rel.name, values)
      toast(row ? 'Satır güncellendi' : 'Satır eklendi')
      onSaved()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer title={row ? 'Satırı düzenle' : 'Satır ekle'} subtitle={row ? `${rel.schema}.${rel.name} · ${pkLabel || 'birincil anahtar yok'}` : `${rel.schema}.${rel.name}`}
      onClose={onClose}
      footer={
        <>
          {row && pk && canWrite && <button type="button" className="btn danger" onClick={() => onDelete(row)} disabled={busy}><Icon name="trash" />Sil</button>}
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          {!readOnly && <button className="btn primary" form="row-form" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</button>}
        </>
      }>
      <form id="row-form" className="form" onSubmit={save}>
        {noPk && <div className="note">Bu tablonun birincil anahtarı yok; satır yalnızca görüntülenebilir.</div>}
        {rel.columns.map((c) => {
          const f = form[c.name]
          const id = `f-${c.name}`
          const long = JSON_TYPES.has(c.type) || c.type === 'text' || c.type.endsWith('[]')
          const placeholder = f.isNull ? 'NULL' : !row && c.default ? `varsayılan: ${c.default}` : !row ? 'boş bırakılırsa varsayılan' : ''
          const common = { id, className: 'mono', 'data-pk': c.is_pk || undefined, value: f.text, disabled: f.isNull || readOnly, placeholder, onChange: (e: { target: { value: string } }) => set(c.name, { text: e.target.value }) }
          return (
            <div className="field" key={c.name}>
              <div className="field-label">
                <label htmlFor={id}>
                  {c.is_pk && <span className="pk"><Icon name="key" size={12} /></span>}{c.name}
                </label>
                <span className="col-type">{c.type}{!c.nullable && ' · zorunlu'}</span>
                {c.nullable && !readOnly && (
                  <label className="null-toggle">
                    <input type="checkbox" checked={f.isNull} onChange={(e) => set(c.name, { isNull: e.target.checked })} />NULL
                  </label>
                )}
              </div>
              {c.type === 'boolean' ? (
                <select {...common}>
                  <option value="">{placeholder || '—'}</option><option value="true">true</option><option value="false">false</option>
                </select>
              ) : long ? <textarea rows={c.type === 'text' ? 2 : 4} {...common} /> : <input {...common} />}
            </div>
          )
        })}
        {error && <ErrorBox message={error} />}
      </form>
    </Drawer>
  )
}
