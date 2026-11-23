// Number, size, date and relative-time formatting for Studio's two locales. Pure: the caller passes the locale
// (components use the bound versions in i18n/index.ts).

export type Lang = 'en' | 'tr'
export const TAG: Record<Lang, string> = { en: 'en-US', tr: 'tr-TR' }

export const nf = (n: number, digits: number, lang: Lang) =>
  new Intl.NumberFormat(TAG[lang], { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)

export const pct = (v: number, digits: number, lang: Lang) =>
  new Intl.NumberFormat(TAG[lang], { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)

export const fmtSize = (n: number | undefined, lang: Lang) =>
  n === undefined ? '—' : n < 1024 ? `${nf(n, 0, lang)} B` : n < 1048576 ? `${nf(n / 1024, 1, lang)} KB` : `${nf(n / 1048576, 1, lang)} MB`

/** Short date and time; a value that does not parse is shown as it came. */
export function fmtDate(s: string | null | undefined, lang: Lang, timeStyle: 'short' | 'medium' = 'short') {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(TAG[lang], { dateStyle: 'short', timeStyle })
}

/** "now", "3 minutes ago", "yesterday" ("şimdi", "3 dakika önce", "dün"); an empty value is a dash. */
export function ago(at: string | null | undefined, now: number, lang: Lang) {
  if (!at) return '—'
  const auto = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const min = Math.round((now - Date.parse(at)) / 60000)
  if (min < 1) return auto.format(0, 'second')
  if (min < 60) return auto.format(-min, 'minute')
  if (min < 1440) return auto.format(-Math.round(min / 60), 'hour')
  const days = Math.round(min / 1440)
  // "always" past one day: Intl's Turkish "evvelsi gün" for two days reads archaic
  return days === 1 ? auto.format(-1, 'day') : new Intl.RelativeTimeFormat(lang, { numeric: 'always' }).format(-days, 'day')
}
