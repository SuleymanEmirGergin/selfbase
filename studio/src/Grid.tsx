import { Icon } from './ui.tsx'
import { t } from './i18n/index.ts'

// Read-only data grid shared by the Tables and SQL pages. Rows are arrays aligned with `columns`.

/** `numeric` right-aligns the column; without it the type name decides. */
export type GridColumn = { name: string; type?: string; pk?: boolean; numeric?: boolean }
export type Sort = { col: string; dir: 'asc' | 'desc' } | null

const NUMERIC = /^(smallint|integer|bigint|numeric|real|double precision|decimal|int|float|serial|bigserial)/

/** Display text of a cell value; JSON values are shown compactly. */
export const cellText = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))

function Cell({ v, numeric }: { v: unknown; numeric: boolean }) {
  if (v === null || v === undefined) return <td className="null">NULL</td>
  if (typeof v === 'boolean') return <td className={`bool ${v}`}>{String(v)}</td>
  const text = cellText(v)
  return <td className={numeric || typeof v === 'number' ? 'num' : undefined} title={text.length > 40 ? text.slice(0, 2000) : undefined}>{text}</td>
}

export function Grid({ columns, rows, sort, onSort, onRowClick, selected }: {
  columns: GridColumn[]; rows: unknown[][]; sort?: Sort; onSort?: (col: string) => void
  onRowClick?: (i: number) => void; selected?: number | null
}) {
  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            {columns.map((c, idx) => {
              const active = sort?.col === c.name
              const label = (
                <>
                  <span className="col-name">
                    {c.pk && <span className="pk" title={t('grid.pk')}><Icon name="key" size={12} /></span>}
                    {c.name}
                    {active && <Icon name={sort!.dir === 'asc' ? 'up' : 'down'} size={12} />}
                  </span>
                  {c.type && <span className="col-type">{c.type}</span>}
                </>
              )
              return (
                <th key={idx} aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {onSort ? <button className="th-btn" onClick={() => onSort(c.name)}>{label}</button> : <div className="th-btn">{label}</div>}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={selected === i ? 'selected' : undefined} onClick={onRowClick && (() => onRowClick(i))}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick && ((e) => { if (e.key === 'Enter') onRowClick(i) })}>
              {columns.map((c, j) => <Cell key={c.name + j} v={r[j]} numeric={c.numeric ?? (!!c.type && NUMERIC.test(c.type))} />)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
