import { nextTheme, readTheme, saveTheme } from './lib/theme.ts'
import type { Theme } from './lib/theme.ts'

// Applies the theme to <html data-theme>; the switch reveals the next theme as a circle growing from the toggle.

const store = (() => { try { return window.localStorage } catch { return { getItem: () => null, setItem: () => {} } } })()
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const current = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark') as Theme
// the theme a switch in flight is heading to: a second press before it lands toggles from there, not from the old one
let pending: Theme | null = null

export const applyStoredTheme = () => {
  document.documentElement.dataset.theme = readTheme(store, matchMedia('(prefers-color-scheme: dark)').matches)
}

export function toggleTheme(from?: Element | null) {
  const root = document.documentElement
  const next = nextTheme(pending ?? current())
  pending = next
  const set = () => { root.dataset.theme = next; saveTheme(store, next); if (pending === next) pending = null }
  if (reduced()) return set()
  const b = from?.getBoundingClientRect()
  const x = b ? b.left + b.width / 2 : innerWidth - 40, y = b ? b.top + b.height / 2 : 30
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  const clipPath = [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`]
  const opts = { duration: 780, easing: 'cubic-bezier(.22,1,.36,1)' }
  if (document.startViewTransition) {
    const vt = document.startViewTransition(set)
    vt.ready.then(() => root.animate({ clipPath }, { ...opts, pseudoElement: '::view-transition-new(root)' }), () => {})
    return
  }
  // fallback: paint the next theme's panel colour (its own tokens, via data-theme) as a growing circle, then swap
  const o = document.createElement('div')
  o.className = 'reveal'
  o.dataset.theme = next
  document.body.append(o)
  o.animate({ clipPath }, opts).finished.then(() => {
    set()
    o.animate({ opacity: [1, 0] }, { duration: 260 }).finished.then(() => o.remove())
  })
}
