import { TAG, nf } from './format.ts'
import type { Lang } from './format.ts'

// Locale choice and message filling. English unless Turkish was chosen in this browser.

type Store = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void }
const KEY = 'studio-locale'

export function readLocale(store: Store): Lang {
  let v: string | null = null
  try { v = store.getItem(KEY) } catch { /* private mode or blocked storage */ }
  return v === 'tr' ? 'tr' : 'en'
}

export function saveLocale(store: Store, l: Lang) {
  try { store.setItem(KEY, l) } catch { /* the choice just does not persist */ }
}

export type Params = Record<string, string | number>

/**
 * Fills `{name}` from `params`; numbers are formatted for the locale. An English "one|other" pair picks its form by
 * `{n}` (Turkish needs no plural after a number). A placeholder without a value stays as written.
 */
export function fill(template: string, params: Params | undefined, lang: Lang) {
  let s = template
  if (s.includes('|')) {
    const [one, other] = s.split('|')
    s = new Intl.PluralRules(TAG[lang]).select(Number(params?.n)) === 'one' ? one : other
  }
  return s.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = params?.[k]
    return v === undefined ? m : typeof v === 'number' ? nf(v, 0, lang) : v
  })
}
