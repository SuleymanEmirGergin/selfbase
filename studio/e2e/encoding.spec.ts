import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// UTF-8 text decoded as Windows-1252 and saved again turns "ı" into "Ä±", "—" into "â€”" and so on.
const MOJIBAKE = ['Ã', 'Ä±', 'â€']

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p] })

test('no file under studio/src is double-encoded', () => {
  const src = fileURLToPath(new URL('../src', import.meta.url))
  const bad = files(src).flatMap((f) => {
    const text = readFileSync(f, 'utf8')
    return MOJIBAKE.filter((m) => text.includes(m)).map((m) => `${f}: ${m}`)
  })
  expect(bad).toEqual([])
})
