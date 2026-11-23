import { expect, test } from '@playwright/test'
import { ago, fmtDate, fmtSize, nf, pct } from '../src/lib/format.ts'
import { fill, readLocale, saveLocale } from '../src/lib/locale.ts'
import { nextTheme, readTheme, saveTheme } from '../src/lib/theme.ts'
import { filterCommands, norm } from '../src/lib/palette.ts'
import { startUndo } from '../src/lib/undo.ts'
import { en } from '../src/i18n/en.ts'
import { tr } from '../src/i18n/tr.ts'

// Plain logic: no page, so Playwright runs these without a browser.

test('numbers, percentages, sizes and relative times follow the locale', () => {
  expect(nf(12408, 0, 'tr')).toBe('12.408')
  expect(nf(1255.75, 2, 'tr')).toBe('1.255,75')
  expect(pct(0.962, 1, 'tr')).toBe('%96,2')
  expect(nf(12408, 0, 'en')).toBe('12,408')
  expect(nf(1255.75, 2, 'en')).toBe('1,255.75')
  expect(pct(0.962, 1, 'en')).toBe('96.2%')
  expect(fmtSize(1536, 'tr')).toBe('1,5 KB')
  expect(fmtSize(1536, 'en')).toBe('1.5 KB')
  expect(fmtSize(undefined, 'en')).toBe('—')
  expect(fmtDate('not a date', 'en')).toBe('not a date') // a log line with an odd timestamp keeps it
  expect(fmtDate(null, 'en')).toBe('—')
  const now = Date.parse('2026-11-23T12:00:00Z')
  expect(ago('2026-11-23T11:59:40Z', now, 'tr')).toBe('şimdi')
  expect(ago('2026-11-23T11:57:00Z', now, 'tr')).toBe('3 dakika önce')
  expect(ago('2026-11-23T09:00:00Z', now, 'tr')).toBe('3 saat önce')
  expect(ago('2026-11-22T12:00:00Z', now, 'tr')).toBe('dün')
  expect(ago('2026-11-21T12:00:00Z', now, 'tr')).toBe('2 gün önce') // not Intl's "evvelsi gün"
  expect(ago('2026-11-13T12:00:00Z', now, 'tr')).toBe('10 gün önce')
  expect(ago(null, now, 'tr')).toBe('—')
  expect(ago('2026-11-23T11:59:40Z', now, 'en')).toBe('now')
  expect(ago('2026-11-23T11:57:00Z', now, 'en')).toBe('3 minutes ago')
  expect(ago('2026-11-22T12:00:00Z', now, 'en')).toBe('yesterday')
  expect(ago('2026-11-21T12:00:00Z', now, 'en')).toBe('2 days ago')
})

test('the locale is English unless Turkish was chosen, and a broken storage does not throw', () => {
  const mem = new Map<string, string>()
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  expect(readLocale(store)).toBe('en')
  saveLocale(store, 'tr')
  expect(readLocale(store)).toBe('tr')
  mem.set('studio-locale', 'de')
  expect(readLocale(store)).toBe('en')
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  expect(readLocale(broken)).toBe('en')
  expect(() => saveLocale(broken, 'tr')).not.toThrow()
})

test('messages fill their parameters, format numbers for the locale and pick the English plural', () => {
  expect(fill('{n} project|{n} projects', { n: 1 }, 'en')).toBe('1 project')
  expect(fill('{n} project|{n} projects', { n: 2336 }, 'en')).toBe('2,336 projects')
  expect(fill('{n} proje', { n: 2336 }, 'tr')).toBe('2.336 proje')
  expect(fill('{used} / {total} GiB', { used: '1,5', total: '12' }, 'tr')).toBe('1,5 / 12 GiB')
  expect(fill('Role: {email}', { email: 'a@b.test' }, 'en')).toBe('Role: a@b.test')
  expect(fill('left as is: {x}', undefined, 'en')).toBe('left as is: {x}')
})

test('the Turkish catalogue has exactly the keys and parameters of the English one', () => {
  const params = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join()
  expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort())
  const keys = Object.keys(en) as (keyof typeof en)[]
  expect(keys.filter((k) => params(en[k]) !== params(tr[k]))).toEqual([])
  // Turkish has no plural after a number, so an English "one|other" pair must not leak into it
  expect(keys.filter((k) => tr[k].includes('|'))).toEqual([])
})

test('the theme is read back from storage, falls back to the system, and a broken storage does not throw', () => {
  const mem = new Map<string, string>()
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  expect(readTheme(store, true)).toBe('dark')
  expect(readTheme(store, false)).toBe('light')
  saveTheme(store, 'light')
  expect(readTheme(store, true)).toBe('light')
  mem.set('studio-theme', 'purple')
  expect(readTheme(store, false)).toBe('light')
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  expect(readTheme(broken, true)).toBe('dark')
  expect(() => saveTheme(broken, 'dark')).not.toThrow()
  expect(nextTheme('dark')).toBe('light')
  expect(nextTheme('light')).toBe('dark')
})

test('palette search ignores case and the dotted/dotless i, ş, ğ, ü, ö, ç', () => {
  expect(norm('İçe Aktar')).toBe('ice aktar')
  expect(norm('ŞİFRE ığüöç')).toBe('sifre iguoc')
  const cmds = [
    { label: 'Kullanıcılar', hint: 'Kimlik doğrulama' },
    { label: 'Temayı değiştir', hint: 'koyu / açık' },
    { label: 'Projeler', hint: '' },
  ]
  expect(filterCommands(cmds, '').map((c) => c.label)).toEqual(['Kullanıcılar', 'Temayı değiştir', 'Projeler'])
  expect(filterCommands(cmds, 'kullanici').map((c) => c.label)).toEqual(['Kullanıcılar'])
  expect(filterCommands(cmds, 'DOGRU').map((c) => c.label)).toEqual(['Kullanıcılar'])
  expect(filterCommands(cmds, 'acik').map((c) => c.label)).toEqual(['Temayı değiştir'])
  expect(filterCommands(cmds, 'yok böyle')).toEqual([])
})

test('the undo timer commits once after the delay, never after an undo', () => {
  // a fake clock: advance() fires due timers in order, including ones they schedule
  const timers: { at: number; fn: () => void; done?: true }[] = []
  let now = 0
  const clock = {
    set: (fn: () => void, ms: number) => timers.push({ at: now + ms, fn }) - 1,
    clear: (id: number) => { timers[id].done = true },
  }
  const advance = (ms: number) => {
    const end = now + ms
    for (let t; (t = timers.find((x) => !x.done && x.at <= end));) { now = t.at; t.done = true; t.fn() }
    now = end
  }
  let commits = 0
  const ticks: number[] = []
  const a = startUndo(5000, () => commits++, (left) => ticks.push(left), clock)
  advance(1000)
  advance(1000)
  expect(ticks).toEqual([5, 4, 3])
  expect(commits).toBe(0)
  advance(3000)
  expect(commits).toBe(1)
  a.undo() // too late: no effect
  advance(5000)
  expect(commits).toBe(1)

  const b = startUndo(5000, () => commits++, () => {}, clock)
  advance(2000)
  expect(b.undo()).toBe(true)
  advance(10000)
  expect(commits).toBe(1)
  expect(b.undo()).toBe(false)

  // paused (focus or hover on the toast): time stands still; resumed: the count goes on from where it was
  const seen: number[] = []
  const c = startUndo(5000, () => commits++, (left) => seen.push(left), clock)
  advance(2000) // 5, 4, 3 shown
  c.pause()
  c.pause() // idempotent
  advance(60000)
  expect(commits).toBe(1)
  expect(seen).toEqual([5, 4, 3])
  c.resume()
  c.resume() // idempotent: one timer, not two
  advance(2000)
  expect(seen).toEqual([5, 4, 3, 2, 1])
  expect(commits).toBe(1)
  advance(1000)
  expect(commits).toBe(2)
  c.resume() // after the commit: nothing
  advance(5000)
  expect(commits).toBe(2)

  const d = startUndo(5000, () => commits++, () => {}, clock)
  d.pause()
  expect(d.undo()).toBe(true) // undo while paused still cancels
  d.resume()
  advance(10000)
  expect(commits).toBe(2)

  // flush (sign-out inside the window): commits at once, exactly once, even while paused; nothing after an undo
  const e = startUndo(5000, () => commits++, () => {}, clock)
  e.pause()
  expect(e.flush()).toBe(true)
  expect(commits).toBe(3)
  expect(e.flush()).toBe(false)
  expect(e.undo()).toBe(false)
  advance(10000)
  expect(commits).toBe(3)
  const f = startUndo(5000, () => commits++, () => {}, clock)
  f.undo()
  expect(f.flush()).toBe(false)
  expect(commits).toBe(3)
})
