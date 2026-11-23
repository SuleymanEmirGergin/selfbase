import { Fragment, createElement, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { en } from './en.ts'
import type { Key } from './en.ts'
import { tr } from './tr.ts'
import * as F from '../lib/format.ts'
import type { Lang } from '../lib/format.ts'
import { fill, readLocale, saveLocale } from '../lib/locale.ts'
import type { Params } from '../lib/locale.ts'

// The current locale, t() and the locale-bound formatters. App subscribes with useLocale(), so a switch re-renders the
// whole tree and every t() call reads the new catalogue.

export type { Key, Lang }
export const LANGS: { id: Lang; name: string }[] = [{ id: 'en', name: 'English' }, { id: 'tr', name: 'Türkçe' }]
const CATALOGUE = { en, tr }

const store = (() => { try { return window.localStorage } catch { return { getItem: () => null, setItem: () => {} } } })()
let current: Lang = readLocale(store)
const listeners = new Set<() => void>()

export const locale = () => current
/** Before the first paint, like the theme: <html lang> drives hyphenation, CSS uppercase and screen-reader voice. */
export const applyStoredLocale = () => { document.documentElement.lang = current }
export function setLocale(l: Lang) {
  current = l
  saveLocale(store, l)
  document.documentElement.lang = l
  listeners.forEach((f) => f())
}
export const useLocale = () => useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f) } }, () => current)

export const t = (key: Key, params?: Params) => fill(CATALOGUE[current][key], params, current)
/** For keys built at run time (a status or step id from the server): false when the catalogue has no such entry. */
export const has = (key: string): key is Key => key in en

/** Like t(), with React nodes for some {params} (a <code>, a <strong>, a link). */
export function rich(key: Key, nodes: Record<string, ReactNode>, params?: Params) {
  const parts = t(key, params).split(/\{(\w+)\}/)
  return createElement(Fragment, null, ...parts.map((p, i) => (i % 2 ? nodes[p] ?? `{${p}}` : p)))
}

// the format.ts helpers, bound to the current locale
export const nf = (n: number, digits = 0) => F.nf(n, digits, current)
export const fmtSize = (n: number | undefined) => F.fmtSize(n, current)
export const fmtDate = (s: string | null | undefined, timeStyle?: 'short' | 'medium') => F.fmtDate(s, current, timeStyle)
export const ago = (at: string | null | undefined) => F.ago(at, Date.now(), current)
export const upper = (s: string) => s.toLocaleUpperCase(current)
export const lower = (s: string) => s.toLocaleLowerCase(current)
