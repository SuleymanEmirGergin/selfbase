// tr-TR formatting used across Studio.

export const nf = (n: number, digits = 0) =>
  new Intl.NumberFormat('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)

export const pct = (v: number, digits = 1) =>
  new Intl.NumberFormat('tr-TR', { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)

const RTF = new Intl.RelativeTimeFormat('tr', { numeric: 'auto' })

/** "şimdi", "3 dakika önce", "dün"; an empty value is a dash. */
export function ago(at: string | null | undefined, now = Date.now()) {
  if (!at) return '—'
  const min = Math.round((now - Date.parse(at)) / 60000)
  if (min < 1) return 'şimdi'
  if (min < 60) return RTF.format(-min, 'minute')
  if (min < 1440) return RTF.format(-Math.round(min / 60), 'hour')
  const days = Math.round(min / 1440)
  return days === 1 ? 'dün' : `${nf(days)} gün önce` // Intl says "evvelsi gün" for two days, which reads archaic
}
