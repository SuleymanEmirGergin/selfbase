// Command palette search: Turkish letters fold to their ASCII base, so "kullanici" finds "Kullanıcılar".

const FOLD: Record<string, string> = { ı: 'i', ş: 's', ğ: 'g', ü: 'u', ö: 'o', ç: 'c' }
export const norm = (s: string) => s.toLocaleLowerCase('tr').replace(/[ışğüöç]/g, (c) => FOLD[c])

export const filterCommands = <T extends { label: string; hint?: string }>(cmds: T[], q: string) => {
  const n = norm(q.trim())
  return n ? cmds.filter((c) => norm(`${c.label} ${c.hint ?? ''}`).includes(n)) : cmds
}
