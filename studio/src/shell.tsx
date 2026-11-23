import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKey, ReactNode } from 'react'
import { Link, navigate, usePath } from './router.tsx'
import { Icon } from './ui.tsx'
import { Brand } from './glyphs.tsx'
import { toggleTheme } from './theme.ts'
import { filterCommands } from './lib/palette.ts'
import { LANGS, locale, rich, setLocale, t, upper } from './i18n/index.ts'

// The app frame shared by the organization and project areas: sidebar, top bar and the Ctrl+K palette.

export type NavItem = { to: string; label: string; icon: string; group?: string; active: boolean; preview?: boolean }
export type Crumb = { label: string; to?: string }
export type Command = { label: string; hint?: string; icon: string; group: string; run: () => void; keys?: string[] }

const isMac = /Mac|iP(hone|ad)/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'

function Nav({ items }: { items: NavItem[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const ind = useRef<HTMLSpanElement>(null)
  // the highlight slides to the active link
  useLayoutEffect(() => {
    const a = ref.current?.querySelector<HTMLElement>('a[aria-current="page"]')
    if (!ind.current) return
    ind.current.style.opacity = a ? '1' : '0'
    if (a) ind.current.style.transform = `translateY(${a.offsetTop}px)`
  })
  return (
    <div className="navlist" ref={ref}>
      <span className="ind" ref={ind} aria-hidden="true" />
      <ul className="nav">
      {items.map((s, i) => (
        <li key={s.to}>
          {s.group && s.group !== items[i - 1]?.group && <div className="grp">{s.group}</div>}
          <Link to={s.to} className={s.active ? 'on' : undefined} aria-current={s.active ? 'page' : undefined}>
            <Icon name={s.icon} weight={s.active ? 'duotone' : 'regular'} />{s.label}
            {s.preview && <span className="pv">{t('common.preview')}</span>}
          </Link>
        </li>
      ))}
      </ul>
    </div>
  )
}

function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const shown = filterCommands(commands, q)
  const run = (c: Command | undefined) => { if (!c) return; onClose(); c.run() }
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])
  const onKey = (e: ReactKey) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(shown[active]) }
    else if (e.key === 'Tab') e.preventDefault() // focus stays on the search field; arrows move the selection
  }
  let group = ''
  return (
    <div className="cmdk" role="dialog" aria-modal="true" aria-label={t('palette.label')} onKeyDown={onKey}>
      <div className="scrim" onClick={onClose} />
      <div className="pal"><div className="core">
        <div className="q">
          <Icon name="search" size={18} />
          <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0) }} placeholder={t('palette.placeholder')}
            aria-label={t('palette.search')} role="combobox" aria-expanded="true" aria-controls="cmdk-list" autoComplete="off"
            aria-activedescendant={shown[active] ? `cmdk-${active}` : undefined} />
          <span className="kbd">esc</span>
        </div>
        <div className="list" id="cmdk-list" role="listbox" aria-label={t('palette.results')} ref={list}>
          {shown.map((c, i) => {
            const head = c.group !== group ? (group = c.group) : null
            return (
              <div key={`${c.group}/${c.label}/${i}`}>
                {head && <div className="gh" role="presentation">{head}</div>}
                <div id={`cmdk-${i}`} role="option" aria-selected={i === active} className={`it ${i === active ? 'on' : ''}`}
                  onPointerMove={() => i !== active && setActive(i)} onClick={() => run(c)}>
                  <span className="tile"><Icon name={c.icon} /></span>
                  <span className="lab">{c.label}{c.hint && <small>{c.hint}</small>}</span>
                  {c.keys && <span className="hint">{c.keys.map((k) => <span key={k} className="kbd">{k}</span>)}</span>}
                  <span className="go"><Icon name="arrow-right" /></span>
                </div>
              </div>
            )
          })}
          {!shown.length && (
            <div className="state empty"><span className="eg"><Icon name="search" size={28} weight="duotone" /></span>
              <div><b>{t('palette.noResults')}</b><p>{rich('palette.noResultsHint', { esc: <span className="kbd">esc</span> })}</p></div></div>
          )}
        </div>
        <div className="ft">
          <span><span className="kbd">↑</span><span className="kbd">↓</span> {t('palette.navigate')}</span><span><span className="kbd">↵</span> {t('palette.open')}</span>
          <span><span className="kbd">esc</span> {t('palette.close')}</span><span className="sp" /><span>{t('palette.fold')}</span>
        </div>
      </div></div>
    </div>
  )
}

export function Shell({ switcher, nav, crumbs, commands, loadCommands, email, onSignOut, foot, children }: {
  switcher: ReactNode; nav: NavItem[]; crumbs: Crumb[]; commands: Command[]; loadCommands?: () => Promise<Command[]>
  email: string; onSignOut: () => void; foot?: ReactNode; children: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [palette, setPalette] = useState(false)
  const [extra, setExtra] = useState<Command[]>([])
  const opener = useRef<Element | null>(null)
  const themeBtn = useRef<HTMLButtonElement>(null)
  const path = usePath()
  useEffect(() => { setMenuOpen(false); setPalette(false) }, [path])

  const open = () => {
    opener.current = document.activeElement
    setPalette(true)
    loadCommands?.().then(setExtra, () => setExtra([]))
  }
  const close = () => {
    setPalette(false)
    const el = opener.current as HTMLElement | null
    if (el?.isConnected) el.focus()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); palette ? close() : open() }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); toggleTheme(themeBtn.current) }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  const all: Command[] = [
    ...nav.map((n) => ({ label: n.label, hint: n.group, icon: n.icon, group: t('palette.groupNav'), run: () => navigate(n.to) })),
    ...commands,
    ...extra,
    { label: t('cmd.theme'), hint: t('cmd.themeHint'), icon: 'theme', group: t('palette.groupActions'), keys: [MOD, '⇧', 'L'], run: () => toggleTheme(themeBtn.current) },
    ...LANGS.filter((l) => l.id !== locale()).map((l) => ({ label: t('cmd.language', { name: l.name }), hint: t('cmd.languageHint'), icon: 'globe', group: t('palette.groupActions'), run: () => setLocale(l.id) })),
    { label: t('cmd.signOut'), hint: email, icon: 'logout', group: t('palette.groupActions'), run: onSignOut },
  ]

  return (
    <div className={`app ${menuOpen ? 'menu-open' : ''}`}>
      <a className="skip" href="#content">{t('shell.skip')}</a>
      <nav className="side" aria-label={t('shell.mainMenu')}>
        <div className="side-brand"><Brand /></div>
        {switcher}
        <div className="navwrap"><Nav items={nav} /></div>
        <div className="side-foot">
          {foot}
          <label className="lang">
            <Icon name="globe" /><span>{t('shell.language')}</span>
            <select aria-label={t('shell.language')} value={locale()} onChange={(e) => setLocale(e.target.value as typeof LANGS[number]['id'])}>
              {LANGS.map((l) => <option key={l.id} value={l.id} lang={l.id}>{l.name}</option>)}
            </select>
          </label>
          <div className="user">
            <span className="avatar v" aria-hidden="true">{upper(email.slice(0, 1))}</span>
            <span className="t mono" title={email}>{email}</span>
            <button className="icon-btn" onClick={onSignOut} aria-label={t('common.signOut')} title={t('common.signOut')}><Icon name="logout" /></button>
          </div>
        </div>
      </nav>
      <div className="main">
        <header className="top">
          <button className="icon-btn menu-toggle" aria-label={t('shell.menu')} aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}><Icon name="menu" /></button>
          <nav className="crumbs" aria-label={t('shell.crumbs')}>
            {crumbs.map((c, i) => (
              <span key={i} className="crumb">
                {i > 0 && <span className="sep" aria-hidden="true">/</span>}
                {c.to && i < crumbs.length - 1 ? <Link to={c.to}>{c.label}</Link> : <span className="cur" aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>}
              </span>
            ))}
          </nav>
          <span className="sp" />
          <button className="topsearch" onClick={open} aria-keyshortcuts="Control+K">
            <Icon name="search" /><span className="lab">{t('shell.search')}</span><span className="kbd">{MOD}</span><span className="kbd">K</span>
          </button>
          <button className="theme-sw" ref={themeBtn} onClick={(e) => toggleTheme(e.currentTarget)} aria-label={t('shell.theme')} title={t('shell.themeTitle', { keys: `${MOD}+⇧+L` })}>
            <span className="sun"><Icon name="sun" size={14} /></span><span className="moon"><Icon name="moon" size={14} /></span>
          </button>
        </header>
        <main className="content" id="content" tabIndex={-1}>{children}</main>
      </div>
      {palette && <Palette commands={all} onClose={close} />}
    </div>
  )
}
