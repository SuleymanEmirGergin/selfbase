import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

// Small shared pieces: icons, state views, the row drawer, the confirm dialog and toasts.

const paths: Record<string, string> = {
  table: 'M3 4h18v16H3zM3 9h18M3 14h18M9 4v16',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  users: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21c0-3.9 3.1-7 7-7s7 3.1 7 7M16 3.1a4 4 0 010 7.8M22 21c0-3.4-2.2-6.2-5-6.9',
  folder: 'M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
  key: 'M14 10a4 4 0 11-8 0 4 4 0 018 0zM13 12l7 7M17 16l2-2',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM16 16l5 5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  chevron: 'M9 6l6 6-6 6',
}

export function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={paths[name]} />
    </svg>
  )
}

export const Loading = ({ label = 'Yükleniyor…' }: { label?: string }) => (
  <div className="state" role="status"><span className="spinner" aria-hidden="true" />{label}</div>
)
export const Empty = ({ children }: { children: ReactNode }) => <div className="state">{children}</div>
export const ErrorBox = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="error-box" role="alert">
    <div>{message}</div>
    {onRetry && <button className="btn sm" onClick={onRetry}>Tekrar dene</button>}
  </div>
)

/** Right-hand panel for editing or inspecting one record. Esc closes; focus moves in on open and back on close. */
export function Drawer({ title, subtitle, onClose, children, footer }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button.btn')
    ;(first ?? ref.current)?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); before?.focus?.() }
  }, [onClose])
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title} ref={ref} tabIndex={-1}>
        <header className="drawer-head">
          <div className="drawer-title">
            <h2>{title}</h2>
            {subtitle && <div className="muted mono small">{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Kapat"><Icon name="close" /></button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </>
  )
}

type ConfirmReq = { title: string; message: ReactNode; confirmLabel: string; resolve: (ok: boolean) => void }
let openConfirm: (r: ConfirmReq) => void = () => {}

/** Asks before a destructive action; resolves true only on the explicit confirm button. */
export const confirmDanger = (title: string, message: ReactNode, confirmLabel = 'Sil') =>
  new Promise<boolean>((resolve) => openConfirm({ title, message, confirmLabel, resolve }))

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmReq | null>(null)
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { openConfirm = setReq }, [])
  useEffect(() => { if (req) ref.current?.showModal() }, [req])
  const done = (ok: boolean) => {
    ref.current?.close()
    req?.resolve(ok)
    setReq(null)
  }
  return (
    <dialog ref={ref} className="confirm" onCancel={(e) => { e.preventDefault(); done(false) }} aria-labelledby="confirm-title">
      {req && (
        <>
          <h2 id="confirm-title">{req.title}</h2>
          <div className="confirm-msg">{req.message}</div>
          <div className="row-actions end">
            <button className="btn" onClick={() => done(false)} autoFocus>Vazgeç</button>
            <button className="btn danger" onClick={() => done(true)}>{req.confirmLabel}</button>
          </div>
        </>
      )}
    </dialog>
  )
}

type Toast = { id: number; text: string; kind: 'ok' | 'error' }
let pushToast: (t: Toast) => void = () => {}
let toastId = 0
export const toast = (text: string, kind: Toast['kind'] = 'ok') => pushToast({ id: ++toastId, text, kind })

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([])
  useEffect(() => {
    pushToast = (t) => {
      setItems((xs) => [...xs, t])
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.kind === 'error' ? 8000 : 3000)
    }
  }, [])
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>{t.text}</div>)}
    </div>
  )
}

export const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '—'

export const fmtSize = (n: number | undefined) =>
  n === undefined ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
