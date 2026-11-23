import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { keymap } from '@codemirror/view'
import { sql as sqlLang } from '@codemirror/lang-sql'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { errMsg } from '../api.ts'
import type { SqlResult } from '../api.ts'
import { Grid, cellText } from '../Grid.tsx'
import { Drawer, Empty, ErrorBox, Icon } from '../ui.tsx'
import { sqlMemo, useAdmin, useProject } from './context.ts'
import { rich, t } from '../i18n/index.ts'


const theme = EditorView.theme({
  '&': { height: '32vh', minHeight: '120px', backgroundColor: 'var(--panel)', color: 'var(--text)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none', boxShadow: 'inset 0 0 0 2px var(--accent)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--dim)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface-2)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-soft) !important' },
})
// Token colours from the Studio palette, so both themes keep AA contrast (the CodeMirror default is light-only).
const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--violet)', fontWeight: '500' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--accent-text)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warn)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--dim)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--info)' },
  { tag: tags.operator, color: 'var(--muted)' },
]))

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
  r.columns.length ? t('sql.rows', { n: r.rowCount ?? r.rows.length })
    : r.rowCount !== null ? t('sql.affected', { n: r.rowCount })
    : t('sql.done')

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
        highlight,
        EditorView.contentAttributes.of({ 'aria-label': t('sql.editor') }),
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
    <div className="sql-layout">
    <section className="page-main">
      <div className="toolbar">
        <h1 className="title">SQL</h1>
        <span className="muted small hide-sm">{t('sql.superuser')}</span>
        <div className="spacer" />
        <span className="muted small hide-sm"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
        <button className="btn primary" onClick={run} disabled={running}>{t(running ? 'sql.running' : 'sql.run')}<span className="ic"><Icon name="play" size={12} weight="bold" /></span></button>
      </div>
      <div className="sql-editor" ref={host} />
      <div className="result-bar" aria-live="polite">
        {ok && (
          <>
            <span className="badge ok">{t('sql.success')}</span>
            <span className="muted">{resultSummary(ok)}</span>
            <span className="muted">{ok.durationMs} ms</span>
            {ok.truncated && <span className="badge warn">{t('sql.truncated', { shown: ok.rows.length, total: ok.rowCount ?? 0 })}</span>}
          </>
        )}
        {fail && <span className="badge danger">{t('sql.error')}</span>}
      </div>
      <div className="grid-area">
        {error ? <ErrorBox message={error} />
          : fail ? (
            <div className="error-box sql-error" role="alert">
              <div className="mono">{fail.message}</div>
              {fail.position !== null && (() => {
                const { line, col } = lineCol(ranQuery, fail.position)
                return <button className="link" onClick={() => goTo(fail.position!)}>{t('sql.position', { pos: fail.position, line, col })}</button>
              })()}
              {fail.hint && <div className="muted">{t('sql.hint', { hint: fail.hint })}</div>}
            </div>
          )
          : !ok ? <Empty>{rich('sql.start', { keys: <><kbd>Ctrl</kbd>+<kbd>Enter</kbd></> })}</Empty>
          : !ok.columns.length ? <Empty>{t('sql.noRows')}</Empty>
          : (
            <>
              <Grid columns={ok.columns.map((name, i) => ({ name, numeric: isNumericColumn(ok.rows, i) }))} rows={ok.rows} onRowClick={setInspect} selected={inspect} />
              {!ok.rows.length && <Empty>{t('sql.empty')}</Empty>}
            </>
          )}
      </div>
      {ok && inspect !== null && ok.rows[inspect] && (
        <Drawer title={t('sql.rowTitle', { n: inspect + 1 })} onClose={() => setInspect(null)}>
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
    <Assistant />
    </div>
  )
}

// The assistant ships later; until then the panel says so, with no input that could look usable. Hidden below 1100 px.
function Assistant() {
  return (
    <aside className="asst" aria-label={t('sql.assistant')}>
      <div className="ah">
        <span className="orb" aria-hidden="true"><Icon name="sparkle" size={12} weight="bold" /></span>
        <b>{t('sql.assistant')}</b><span className="spacer" /><span className="chip pv-chip">{t('common.preview')}</span>
      </div>
      <Empty icon="sparkle">
        <b>{t('sql.assistantOff')}</b>
        <p>{t('sql.assistantText')}</p>
      </Empty>
    </aside>
  )
}
