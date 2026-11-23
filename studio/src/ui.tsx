import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IconWeight } from '@phosphor-icons/react'
import {
  ArrowClockwiseIcon, ArrowDownIcon, ArrowRightIcon, ArrowUUpLeftIcon, ArrowUpIcon, ArrowUpRightIcon, BracketsCurlyIcon,
  CaretDownIcon, CaretLeftIcon, CaretRightIcon, CaretUpDownIcon, CheckCircleIcon, CheckIcon, CircleDashedIcon, CircleHalfIcon,
  CopyIcon, DatabaseIcon, DownloadSimpleIcon, EnvelopeSimpleIcon, EyeIcon, EyeSlashIcon, FileTextIcon, FlowArrowIcon, FolderSimpleIcon, FunnelSimpleIcon,
  GaugeIcon, GearSixIcon, GlobeSimpleIcon, HouseIcon, InfoIcon, KeyIcon, LinkSimpleIcon, ListIcon, LockKeyIcon, MagnifyingGlassIcon, MoonIcon, PauseIcon, PlayIcon,
  PlusIcon, PulseIcon, ScrollIcon, ShieldCheckIcon, SignOutIcon, SparkleIcon, SpinnerGapIcon, SquaresFourIcon, SunIcon, TableIcon,
  TerminalWindowIcon, TrashIcon, TrayIcon, UploadSimpleIcon, UsersIcon, WarningCircleIcon, XCircleIcon, XIcon,
} from '@phosphor-icons/react'
import { GLYPHS } from './glyphs.tsx'
import { startUndo } from './lib/undo.ts'
import { t } from './i18n/index.ts'

// Small shared pieces: icons, status pills, state views, the side sheet, the confirm dialog and toasts.

type IconC = (p: { size?: number; weight?: IconWeight; className?: string }) => ReactNode
const ICONS: Record<string, IconC> = {
  table: TableIcon, shield: ShieldCheckIcon, terminal: TerminalWindowIcon, users: UsersIcon, folder: FolderSimpleIcon,
  file: FileTextIcon, logout: SignOutIcon, close: XIcon, plus: PlusIcon, refresh: ArrowClockwiseIcon, key: KeyIcon,
  search: MagnifyingGlassIcon, menu: ListIcon, up: ArrowUpIcon, down: ArrowDownIcon, upload: UploadSimpleIcon,
  download: DownloadSimpleIcon, trash: TrashIcon, chevron: CaretRightIcon, play: PlayIcon, pause: PauseIcon, home: HouseIcon,
  projects: SquaresFourIcon, scroll: ScrollIcon, gauge: GaugeIcon, pulse: PulseIcon, gear: GearSixIcon, sun: SunIcon,
  moon: MoonIcon, 'caret-up-down': CaretUpDownIcon, 'caret-left': CaretLeftIcon, 'caret-right': CaretRightIcon,
  'caret-down': CaretDownIcon, 'arrow-right': ArrowRightIcon, 'arrow-up-right': ArrowUpRightIcon, copy: CopyIcon,
  check: CheckIcon, 'check-circle': CheckCircleIcon, 'x-circle': XCircleIcon, undo: ArrowUUpLeftIcon, info: InfoIcon,
  warning: WarningCircleIcon, mail: EnvelopeSimpleIcon, lock: LockKeyIcon, eye: EyeIcon, 'eye-slash': EyeSlashIcon, link: LinkSimpleIcon, braces: BracketsCurlyIcon,
  flow: FlowArrowIcon, database: DatabaseIcon, sparkle: SparkleIcon, spinner: SpinnerGapIcon, dashed: CircleDashedIcon,
  theme: CircleHalfIcon, globe: GlobeSimpleIcon, funnel: FunnelSimpleIcon, empty: TrayIcon, ...GLYPHS,
}

/** Phosphor Regular by default; Duotone for active nav and empty states, Bold only at 12 px. */
export function Icon({ name, size = 16, weight }: { name: string; size?: number; weight?: IconWeight }) {
  const C = ICONS[name] ?? CircleDashedIcon
  return <C size={size} weight={weight} className="icon" />
}

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'mute' | 'violet'
/** Status pill: colour and dot shape both carry the state (circle ok, diamond warn, square error). */
export const Status = ({ tone, live, title, children }: { tone: Tone; live?: boolean; title?: string; children?: ReactNode }) => (
  <span className={`status s-${tone}${live ? ' live' : ''}`} title={title}><span className="dot" aria-hidden="true" />{children}</span>
)

/** Segmented meter: green, then amber past 60 %, red past 85 %. */
export const Dots = ({ fill, n = 32 }: { fill: number; n?: number }) => (
  <div className="dots" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }} aria-hidden="true">
    {Array.from({ length: n }, (_, i) => {
      const r = (i + 1) / n
      return <i key={i} className={i < Math.round(fill * n) ? (r <= 0.6 ? 'f g' : r <= 0.85 ? 'f a' : 'f r') : undefined} style={{ ['--d' as string]: i }} />
    })}
  </div>
)

/** A skeleton while data loads; screen readers hear the label. */
export const Loading = ({ label = t('common.loading') }: { label?: string }) => (
  <div className="state loading" role="status">
    <span className="sr-only">{label}</span>
    <span className="sk-block" aria-hidden="true"><span className="sk" /><span className="sk" /><span className="sk short" /></span>
  </div>
)
export const Empty = ({ icon = 'empty', children }: { icon?: string; children: ReactNode }) => (
  <div className="state empty">
    <span className="eg" aria-hidden="true"><Icon name={icon} size={28} weight="duotone" /></span>
    <div>{children}</div>
  </div>
)
export const ErrorBox = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="error-box" role="alert">
    <Icon name="warning" />
    <div className="grow">{message}</div>
    {onRetry && <button className="btn sm" onClick={onRetry}>{t('common.retry')}</button>}
  </div>
)

/** Copies `text`; the icon turns into a check for a moment. */
export function Copy({ text, label = t('common.copy') }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false)
  const copy = () => navigator.clipboard.writeText(text).then(() => {
    setOk(true)
    setTimeout(() => setOk(false), 1500)
    toast(t('common.copied'))
  }, () => toast(t('common.copyFailed'), 'error'))
  return (
    <button type="button" className={`copy ${ok ? 'ok' : ''}`} onClick={copy} aria-label={label} title={label}>
      <CopyIcon size={13} className="icon a" /><CheckIcon size={13} weight="bold" className="icon b" />
    </button>
  )
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
const FIELD = 'input:not(:disabled):not([data-pk]), textarea:not(:disabled), select:not(:disabled)'

/**
 * Right-hand modal panel for editing or inspecting one record. Esc closes, Tab stays inside, focus starts on the first
 * editable non-key field and returns to the element that opened it.
 */
export function Drawer({ title, subtitle, onClose, children, footer }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose // parents pass fresh closures; the mount effect below must not re-run for them
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const el = ref.current!
    ;(el.querySelector<HTMLElement>(`.drawer-body :is(${FIELD})`) ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus()
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return // the confirm dialog handles its own keys
      if (e.key === 'Escape') close.current()
      if (e.key !== 'Tab') return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null)
      if (!items.length) return
      const [first, last] = [items[0], items[items.length - 1]]
      if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus() }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); if (before?.isConnected) before.focus() }
  }, [])
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <header className="drawer-head">
          <div className="drawer-title">
            <h2>{title}</h2>
            {subtitle && <div className="muted mono small">{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}><Icon name="close" /></button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </div>
    </>
  )
}

type ConfirmReq = { title: string; message: ReactNode; confirmLabel: string; resolve: (ok: boolean) => void }
let openConfirm: (r: ConfirmReq) => void = () => {}

/** Asks before a destructive action; resolves true only on the explicit confirm button. */
export const confirmDanger = (title: string, message: ReactNode, confirmLabel = t('common.delete')) =>
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
            <button className="btn" onClick={() => done(false)} autoFocus>{t('common.cancel')}</button>
            <button className="btn danger" onClick={() => done(true)}>{req.confirmLabel}</button>
          </div>
        </>
      )}
    </dialog>
  )
}

type Toast = { id: number; text: string; kind: 'ok' | 'error' } | { id: number; text: string; kind: 'undo'; body: string; commit: () => void; undo: () => void }
let pushToast: (t: Toast) => void = () => {}
let toastId = 0
export const toast = (text: string, kind: 'ok' | 'error' = 'ok') => pushToast({ id: ++toastId, text, kind })
/**
 * A reversible action instead of a confirm dialog: `commit` runs after 5 seconds unless Undo is pressed first, in
 * which case `undo` restores what the caller hid. Sign-out commits at once; a page closed before then never commits
 * (the toast says "Deleting…", not "Deleted").
 */
export const toastUndo = (text: string, body: string, commit: () => void, undo: () => void) =>
  pushToast({ id: ++toastId, text, kind: 'undo', body, commit, undo })

const UNDO_MS = 5000
// pending undo windows; sign-out commits them first, while the session that may send them still exists
const flushers = new Set<() => void>()
export const flushUndo = () => flushers.forEach((f) => f())

function UndoToast({ item, close }: { item: Extract<Toast, { kind: 'undo' }>; close: () => void }) {
  const [left, setLeft] = useState(UNDO_MS / 1000)
  const [held, setHeld] = useState({ focus: false, hover: false })
  const timer = useRef<ReturnType<typeof startUndo> | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const before = useRef<HTMLElement | null>(null)
  // Focus leaves the toast for where it was before, or the page content when that is gone (the deleted row).
  const finish = () => {
    if (box.current?.contains(document.activeElement)) {
      const back = before.current?.isConnected ? before.current : document.getElementById('content')
      back?.focus()
    }
    close()
  }
  useEffect(() => {
    before.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    // the only way back is this button: keyboard and screen-reader users land on it at once
    button.current?.focus()
    timer.current = startUndo(UNDO_MS, () => { item.commit(); finish() }, setLeft)
    const flush = () => { timer.current?.flush() }
    flushers.add(flush)
    return () => { flushers.delete(flush); timer.current?.undo() } // unmounted without an answer: nothing is committed
  }, [])
  const paused = held.focus || held.hover
  useEffect(() => { if (paused) timer.current?.pause(); else timer.current?.resume() }, [paused])
  const id = `undo-${item.id}`
  return (
    <div className={`toast${paused ? ' paused' : ''}`} role="status" ref={box}
      onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setHeld((h) => ({ ...h, focus: false }))}
      // a mouse only: a tap emulates mouseenter with no leave until the next tap, which would hold the delete
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHeld((h) => ({ ...h, hover: true }))}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setHeld((h) => ({ ...h, hover: false }))}>
      <span className="ti s-mute"><Icon name="trash" /></span>
      <span className="tx" id={id}><b>{item.text}</b><span>{item.body}</span></span>
      <span className="cd" aria-hidden="true">{paused ? t('undo.held') : t('undo.seconds', { n: left })}</span>
      {paused && <span className="sr-only">{t('undo.heldSr')}</span>}
      <button className="btn sm" ref={button} aria-describedby={id} onClick={() => { if (timer.current?.undo()) item.undo(); finish() }}>
        <Icon name="undo" />{t('undo.undo')}
      </button>
      {/* driven by the count, not a CSS clock, so a pause or a slow tick never lets the bar run ahead of the time left */}
      <span className="drain" aria-hidden="true"
        style={{ transform: `scaleX(${(paused ? left : left - 1) / (UNDO_MS / 1000)})`, transition: paused ? 'none' : 'transform 1s linear' }} />
    </div>
  )
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([])
  const drop = (id: number) => setItems((xs) => xs.filter((x) => x.id !== id))
  useEffect(() => {
    pushToast = (t) => {
      setItems((xs) => [...xs, t])
      if (t.kind !== 'undo') setTimeout(() => drop(t.id), t.kind === 'error' ? 8000 : 3000)
    }
  }, [])
  return (
    <div className="toasts" aria-live="polite">
      {items.map((x) => x.kind === 'undo' ? <UndoToast key={x.id} item={x} close={() => drop(x.id)} /> : (
        <div key={x.id} className={`toast ${x.kind}`} role={x.kind === 'error' ? 'alert' : 'status'}>
          <span className={`ti ${x.kind === 'error' ? 's-err' : 's-ok'}`}><Icon name={x.kind === 'error' ? 'x-circle' : 'check-circle'} /></span>
          <span className="tx"><b>{x.text}</b></span>
          <button className="icon-btn sm" onClick={() => drop(x.id)} aria-label={t('toast.dismiss')}><Icon name="close" size={14} /></button>
        </div>
      ))}
    </div>
  )
}

