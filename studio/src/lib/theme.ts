// Theme choice: stored per browser; without one, the system setting decides.

export type Theme = 'dark' | 'light'
type Store = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void }
const KEY = 'studio-theme'

export function readTheme(store: Store, prefersDark: boolean): Theme {
  let v: string | null = null
  try { v = store.getItem(KEY) } catch { /* private mode or blocked storage */ }
  return v === 'dark' || v === 'light' ? v : prefersDark ? 'dark' : 'light'
}

export function saveTheme(store: Store, t: Theme) {
  try { store.setItem(KEY, t) } catch { /* the choice just does not persist */ }
}

export const nextTheme = (t: Theme): Theme => (t === 'dark' ? 'light' : 'dark')
