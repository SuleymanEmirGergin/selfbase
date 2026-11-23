import { expect, test } from '@playwright/test'
import { ago, nf, pct } from '../src/lib/format.ts'
import { nextTheme, readTheme, saveTheme } from '../src/lib/theme.ts'
import { filterCommands, norm } from '../src/lib/palette.ts'
import { startUndo } from '../src/lib/undo.ts'

// Plain logic: no page, so Playwright runs these without a browser.

test('tr-TR numbers, percentages and relative times', () => {
  expect(nf(12408)).toBe('12.408')
  expect(nf(1255.75, 2)).toBe('1.255,75')
  expect(pct(0.962)).toBe('%96,2')
  const now = Date.parse('2026-11-23T12:00:00Z')
  expect(ago('2026-11-23T11:59:40Z', now)).toBe('şimdi')
  expect(ago('2026-11-23T11:57:00Z', now)).toBe('3 dakika önce')
  expect(ago('2026-11-23T09:00:00Z', now)).toBe('3 saat önce')
  expect(ago('2026-11-22T12:00:00Z', now)).toBe('dün')
  expect(ago('2026-11-21T12:00:00Z', now)).toBe('2 gün önce') // not Intl's "evvelsi gün"
  expect(ago('2026-11-13T12:00:00Z', now)).toBe('10 gün önce')
  expect(ago(null, now)).toBe('—')
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
})
