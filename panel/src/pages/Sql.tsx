import { useRef, useState } from 'react'
import { api, errMsg } from '../api.ts'
import type { SqlResult } from '../api.ts'
import { Grid, cellText } from '../Grid.tsx'
import { Drawer, Empty, ErrorBox, Icon } from '../ui.tsx'

// -- shortcut: plain textarea, swap for CodeMirror when autocomplete is asked for
// Last query and result live in module memory: they survive page switches, not a reload (nothing goes to storage).
let lastQuery = 'select now();'
let lastResult: SqlResult | null = null

/** 1-based line and column of a 1-based character position. */
const lineCol = (text: string, pos: number) => {
  const before = text.slice(0, pos - 1).split('\n')
  return { line: before.length, col: before[before.length - 1].length + 1 }
}

// The SQL result has no column types; bigint/numeric arrive as text, so right-align columns that only hold numbers.
const NUM = /^-?\d+(\.\d+)?$/
const isNumericColumn = (rows: unknown[][], i: number) =>
  rows.some((r) => r[i] !== null) && rows.every((r) => r[i] === null || typeof r[i] === 'number' || (typeof r[i] === 'string' && NUM.test(r[i] as string)))

export default function Sql() {
  const [query, setQuery] = useState(lastQuery)
  const [result, setResult] = useState<SqlResult | null>(lastResult)
  const [ranQuery, setRanQuery] = useState(lastQuery)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [inspect, setInspect] = useState<number | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null)

  const run = async () => {
    if (!query.trim() || running) return
    setRunning(true)
    setError('')
    setInspect(null)
    lastQuery = query
    try {
      const r = await api.sql(query)
      lastResult = r
      setResult(r)
      setRanQuery(query)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setRunning(false)
    }
  }

  const goTo = (pos: number) => {
    editor.current?.focus()
    editor.current?.setSelectionRange(pos - 1, pos)
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
      <div className="sql-editor">
        <textarea ref={editor} className="mono" aria-label="SQL sorgusu" spellCheck={false} value={query}
          onChange={(e) => { setQuery(e.target.value); lastQuery = e.target.value }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run() } }} />
      </div>
      <div className="result-bar" aria-live="polite">
        {ok && (
          <>
            <span className="badge ok">Başarılı</span>
            <span className="muted">{ok.rows.length ? `${ok.rows.length.toLocaleString('tr-TR')} satır` : `${ok.rowCount ?? 0} satır etkilendi`}</span>
            <span className="muted">{ok.durationMs} ms</span>
            {ok.truncated && <span className="badge warn">İlk 1000 satır gösteriliyor</span>}
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
