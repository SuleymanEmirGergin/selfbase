import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { keymap } from '@codemirror/view'
import { sql as sqlLang } from '@codemirror/lang-sql'
import { errMsg } from '../api.ts'
import type { SqlResult } from '../api.ts'
import { Grid, cellText } from '../Grid.tsx'
import { Drawer, Empty, ErrorBox, Icon } from '../ui.tsx'
import { sqlMemo, useAdmin, useProject } from './context.ts'


const theme = EditorView.theme({
  '&': { height: '32vh', minHeight: '120px', backgroundColor: 'var(--panel)', color: 'var(--text)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none', boxShadow: 'inset 0 0 0 2px var(--accent)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--dim)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface-2)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
})

/** 1-based line and column of a 1-based character position. */
const lineCol = (text: string, pos: number) => {
  const before = text.slice(0, pos - 1).split('\n')
  return { line: before.length, col: before[before.length - 1].length + 1 }
}

// The SQL result has no column types; bigint/numeric arrive as text, so right-align columns that only hold numbers.
const NUM = /^-?\d+(\.\d+)?$/
const isNumericColumn = (rows: unknown[][], i: number) =>
  rows.some((r) => r[i] !== null) && rows.every((r) => r[i] === null || typeof r[i] === 'number' || (typeof r[i] === 'string' && NUM.test(r[i] as string)))

/** Rows returned (SELECT, RETURNING), rows affected (INSERT/UPDATE/DELETE), or just done (DDL has no row count). */
const resultSummary = (r: { columns: string[]; rows: unknown[][]; rowCount: number | null }) =>
  r.columns.length ? `${(r.rowCount ?? r.rows.length).toLocaleString('tr-TR')} satır`
    : r.rowCount !== null ? `${r.rowCount.toLocaleString('tr-TR')} satır etkilendi`
    : 'Tamamlandı'

export default function Sql() {
  const api = useAdmin()
  const mem = sqlMemo(useProject().ref)
  const [query, setQuery] = useState(mem.query)
  const [result, setResult] = useState<SqlResult | null>(mem.result)
  const [ranQuery, setRanQuery] = useState(mem.query)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [inspect, setInspect] = useState<number | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)

  const run = async () => {
    if (!query.trim() || running) return
    setRunning(true)
    setError('')
    setInspect(null)
    mem.query = query
    try {
      const r = await api.sql(query)
      mem.result = r
      setResult(r)
      setRanQuery(query)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setRunning(false)
    }
  }

  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      doc: mem.query,
      extensions: [
        keymap.of([{ key: 'Mod-Enter', run: () => { runRef.current(); return true } }]), // before basicSetup: wins over its Mod-Enter
        basicSetup,
        sqlLang(),
        theme,
        EditorView.contentAttributes.of({ 'aria-label': 'SQL sorgusu' }),
        EditorView.updateListener.of((u) => { if (u.docChanged) { mem.query = u.state.doc.toString(); setQuery(mem.query) } }),
      ],
    })
    editor.current = view
    return () => view.destroy()
  }, [mem])

  const goTo = (pos: number) => {
    const view = editor.current
    if (!view) return
    const len = view.state.doc.length
    view.dispatch({ selection: { anchor: Math.min(pos - 1, len), head: Math.min(pos, len) }, scrollIntoView: true })
    view.focus()
  }

  const ok = result && !('error' in result) ? result : null
  const fail = result && 'error' in result ? result.error : null

  return (
    <section className="page-main">
      <div className="toolbar">
        <h1 className="title">SQL</h1>
        <span className="muted small hide-sm">Sorgular veritabanı süper kullanıcısıyla çalışır.</span>
        <div className="spacer" />
        <span className="muted small hide-sm"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
        <button className="btn primary" onClick={run} disabled={running}><Icon name="chevron" />{running ? 'Çalışıyor…' : 'Çalıştır'}</button>
      </div>
      <div className="sql-editor" ref={host} />
      <div className="result-bar" aria-live="polite">
        {ok && (
          <>
            <span className="badge ok">Başarılı</span>
            <span className="muted">{resultSummary(ok)}</span>
            <span className="muted">{ok.durationMs} ms</span>
            {ok.truncated && <span className="badge warn">İlk {ok.rows.length.toLocaleString('tr-TR')} satır gösteriliyor, toplam {(ok.rowCount ?? 0).toLocaleString('tr-TR')}</span>}
          </>
        )}
        {fail && <span className="badge danger">Hata</span>}
      </div>
      <div className="grid-area">
        {error ? <ErrorBox message={error} />
          : fail ? (
            <div className="error-box sql-error" role="alert">
              <div className="mono">{fail.message}</div>
              {fail.position !== null && (() => {
                const { line, col } = lineCol(ranQuery, fail.position)
                return <button className="link" onClick={() => goTo(fail.position!)}>Konum {fail.position} · satır {line}, sütun {col}</button>
              })()}
              {fail.hint && <div className="muted">İpucu: {fail.hint}</div>}
            </div>
          )
          : !ok ? <Empty>Sorguyu yazıp <kbd>Ctrl</kbd>+<kbd>Enter</kbd> ile çalıştırın.</Empty>
          : !ok.columns.length ? <Empty>Sorgu çalıştı, dönen satır yok.</Empty>
          : (
            <>
              <Grid columns={ok.columns.map((name, i) => ({ name, numeric: isNumericColumn(ok.rows, i) }))} rows={ok.rows} onRowClick={setInspect} selected={inspect} />
              {!ok.rows.length && <Empty>Sonuç boş.</Empty>}
            </>
          )}
      </div>
      {ok && inspect !== null && ok.rows[inspect] && (
        <Drawer title={`Satır ${inspect + 1}`} onClose={() => setInspect(null)}>
          <dl className="kv">
            {ok.columns.map((c, i) => {
              const v = ok.rows[inspect][i]
              return (
                <div key={i}>
                  <dt>{c}</dt>
                  <dd className="mono">{v === null ? <span className="null">NULL</span> : <pre>{typeof v === 'object' ? JSON.stringify(v, null, 2) : cellText(v)}</pre>}</dd>
                </div>
              )
            })}
          </dl>
        </Drawer>
      )}
    </section>
  )
}
