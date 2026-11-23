import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { REF, fx, mockApi, routes } from './helpers.ts'

// These specs match the Turkish copy, so they run in Turkish; i18n.spec.ts covers the English default.
const inTurkish = () => localStorage.setItem('studio-locale', 'tr')
test.beforeEach(({ page }) => page.addInitScript(inTurkish))

// v3 shell behaviour: theme switch, Ctrl+K palette, the undo toast and keyboard focus order.

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme)
const signedOut = { 'GET /me': { status: 401, body: fx('unauthorized') }, 'POST /refresh': { status: 401, body: fx('unauthorized') } }

const focusables = 'a, button, input, select, textarea, [tabindex], video[controls]'

test('the sign-in art is hidden from assistive tech, its only control is the video toggle, and the loop loads muted with the still as poster', async ({ page }) => {
  await mockApi(page, signedOut)
  await page.goto('/sign-in')
  const art = page.locator('.si-left .a-panel')
  await expect(art).toHaveAttribute('aria-hidden', 'true')
  expect(await art.locator(focusables).count()).toBe(0)
  await expect(page.locator('.si-left').locator(focusables)).toHaveCount(1)
  await expect(page.locator('.si-left [aria-hidden] button, .si-left[aria-hidden]')).toHaveCount(0) // the toggle is not inside the hidden art
  await expect(page.getByRole('heading', { name: 'Tekrar hoş geldin' })).toBeVisible()
  const panel = page.locator('.si-left')
  const video = panel.locator('video')
  await expect(video).toHaveCount(1)
  expect(await video.evaluate((v: HTMLVideoElement) => [v.muted, v.hasAttribute('muted'), v.loop, v.playsInline, v.preload, v.getAttribute('poster')]))
    .toEqual([true, true, true, true, 'metadata', '/signin/art.webp'])
  await expect(panel.getByText('#483')).toHaveCount(0) // no deploy number, only a sample label
})

test('under reduced motion the sign-in panel shows only the still: no video, no light passes', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' })
  await ctx.addInitScript(inTurkish)
  const page = await ctx.newPage()
  await mockApi(page, signedOut)
  await page.goto('/sign-in')
  await expect(page.getByRole('heading', { name: 'Tekrar hoş geldin' })).toBeVisible()
  await expect(page.locator('.si-left video')).toHaveCount(0)
  await expect(page.locator('.si-left .sheen')).toHaveCount(0)
  await expect(page.locator('.si-left .a-art')).not.toHaveClass(/has-vid/)
  await expect(page.locator('.si-left .gl-c.done')).toHaveCount(4) // the sample pipeline sits finished
  await ctx.close()
})

test('the video toggle is reachable by keyboard, pauses to the still and stays paused for the session', async ({ page }) => {
  await mockApi(page, signedOut)
  await page.goto('/sign-in')
  await expect(page.getByLabel('E-posta')).toBeFocused()
  await page.keyboard.press('Shift+Tab') // the panel comes before the form
  const stop = page.getByRole('button', { name: 'Videoyu durdur' })
  await expect(stop).toBeFocused()
  // AA focus ring: the global ring is drawn as a box-shadow
  expect(await stop.evaluate((b) => getComputedStyle(b).boxShadow)).toContain('rgb(201, 246, 94)')
  await page.keyboard.press('Enter')
  const play = page.getByRole('button', { name: 'Videoyu oynat' })
  await expect(play).toBeFocused()
  await expect(page.locator('.si-left video')).toHaveCount(0)
  await expect(page.locator('.si-left .a-art')).not.toHaveClass(/has-vid/)
  await expect(page.locator('.si-left .sheen')).toHaveCount(0)
  await expect(page.locator('.si-left .gl-c.done')).toHaveCount(4)

  await page.reload()
  await expect(play).toBeVisible()
  await expect(page.locator('.si-left video')).toHaveCount(0)
  await play.focus()
  await page.keyboard.press('Space')
  await expect(stop).toBeVisible()
  await expect(page.locator('.si-left video')).toHaveCount(1)
})

test('a phone strip or Data Saver gets the still only: no video element, no toggle, no video request', async ({ browser }) => {
  for (const opts of [{ viewport: { width: 390, height: 844 } }, { saveData: true }]) {
    const ctx = await browser.newContext('viewport' in opts ? opts : {})
    await ctx.addInitScript(inTurkish)
    const page = await ctx.newPage()
    if ('saveData' in opts) await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true } }))
    const media: string[] = []
    page.on('request', (r) => { if (/\.(mp4|webm)(\?|$)/.test(r.url())) media.push(r.url()) })
    await mockApi(page, signedOut)
    await page.goto('/sign-in')
    await expect(page.getByRole('heading', { name: 'Tekrar hoş geldin' })).toBeVisible()
    await page.waitForTimeout(500)
    await expect(page.locator('.si-left video')).toHaveCount(0)
    await expect(page.locator('.si-left button')).toHaveCount(0)
    expect(media).toEqual([])
    await ctx.close()
  }
})

test('turning reduced motion on while the page is open stops the video and the pipeline', async ({ page }) => {
  await mockApi(page, signedOut)
  await page.goto('/sign-in')
  await expect(page.locator('.si-left video')).toHaveCount(1)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.si-left video')).toHaveCount(0)
  await expect(page.locator('.si-left button')).toHaveCount(0)
  await expect(page.locator('.si-left .gl-c.done')).toHaveCount(4)
  const k = await page.locator('.si-left .gl-c.done').count()
  await page.waitForTimeout(1600) // more than one step: nothing moves any more
  await expect(page.locator('.si-left .gl-c.done')).toHaveCount(k)
})

test('on sign-in, keyboard focus starts and stays in the form', async ({ page }) => {
  await mockApi(page, signedOut)
  await page.goto('/sign-in')
  await expect(page.getByLabel('E-posta')).toBeFocused()
  const order: string[] = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab')
    order.push(await page.evaluate(() => { const el = document.activeElement as HTMLInputElement; return (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.textContent || '').trim() }))
  }
  // the forgot link comes after the password field and its show toggle, not between e-mail and password
  expect(order).toEqual(['Şifre', 'Karakterleri göster', 'Şifremi unuttum', 'Giriş yap'])
})

test('the theme follows the system first, then the switch, and the choice survives a reload', async ({ page }) => {
  await mockApi(page, routes())
  await page.goto('/org/acme')
  await expect(page.getByRole('heading', { name: 'Projeler' })).toBeVisible()
  expect(await theme(page)).toBe('dark') // the config runs Chromium with a dark colour scheme

  await page.getByRole('button', { name: 'Temayı değiştir' }).click()
  await expect.poll(() => theme(page)).toBe('light')
  expect(await page.evaluate(() => localStorage.getItem('studio-theme'))).toBe('light')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Projeler' })).toBeVisible()
  expect(await theme(page)).toBe('light')

  await page.keyboard.press('Control+Shift+L')
  await expect.poll(() => theme(page)).toBe('dark')
})

test('a light system with nothing stored starts light; reduced motion switches without the reveal', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'light', reducedMotion: 'reduce' })
  await ctx.addInitScript(inTurkish)
  const page = await ctx.newPage()
  await mockApi(page, routes())
  await page.goto('/org/acme')
  await expect(page.getByRole('heading', { name: 'Projeler' })).toBeVisible()
  expect(await theme(page)).toBe('light')
  await page.getByRole('button', { name: 'Temayı değiştir' }).click()
  expect(await theme(page)).toBe('dark') // synchronous: no view transition and no overlay under reduced motion
  await expect(page.locator('.reveal')).toHaveCount(0)
  await ctx.close()
})

test('Ctrl+K opens the palette; search ignores Turkish letters, arrows and Enter run a command, Esc closes', async ({ page }) => {
  await mockApi(page, routes())
  await page.goto('/org/acme')
  const opener = page.getByRole('button', { name: 'Ara veya komut çalıştır…' })
  await opener.focus()
  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Komut paleti' })
  await expect(palette).toBeVisible()
  const input = palette.getByRole('combobox', { name: 'Komut ara' })
  await expect(input).toBeFocused()

  await input.fill('uyeler')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await expect(palette.getByRole('option', { selected: true })).toContainText('Üyeler')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/org\/acme\/members$/)
  await expect(palette).toHaveCount(0)

  // projects come from the API once the palette opens; arrows move the selection
  await page.keyboard.press('Control+K')
  const pal = page.getByRole('dialog', { name: 'Komut paleti' })
  await pal.getByRole('combobox', { name: 'Komut ara' }).fill('proje')
  const options = pal.getByRole('option')
  await expect(options.nth(1)).toBeVisible()
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false')
  await pal.getByRole('combobox', { name: 'Komut ara' }).fill('staging')
  await expect(pal.getByRole('option', { name: /staging/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/project\/stagingprojectrefbbb/)

  // no match shows the empty state; Esc closes and gives focus back
  await page.goto('/org/acme')
  await opener.click()
  await page.getByRole('combobox', { name: 'Komut ara' }).fill('zzzz')
  await expect(page.getByText('Sonuç yok')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Komut paleti' })).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('deleting a row waits five seconds; Geri al keeps it and nothing is sent', async ({ page }) => {
  await page.clock.install() // the 5 s undo window runs on a fake clock, not real waits
  const api = await mockApi(page, routes())
  await page.goto(`/project/${REF}/editor`)
  const row = page.getByRole('row').filter({ hasText: 'ilk sürüm yayında' })

  await row.click()
  await page.getByRole('dialog', { name: 'Satırı düzenle' }).getByRole('button', { name: 'Sil' }).click()
  const toast = page.getByRole('status').filter({ hasText: 'Satır siliniyor' })
  await expect(toast).toContainText('public.notes · id=2')
  await expect(row).toHaveCount(0)
  await toast.getByRole('button', { name: 'Geri al' }).click()
  await expect(row).toHaveCount(1)
  await page.clock.runFor(5600)
  expect(api.count(`DELETE /projects/${REF}/admin/rows/public/notes`)).toBe(0)

  await row.click()
  await page.getByRole('dialog', { name: 'Satırı düzenle' }).getByRole('button', { name: 'Sil' }).click()
  await expect(row).toHaveCount(0)
  // focus lands on Geri al and holds the count: nothing is sent while the toast keeps it
  await expect(toast.getByRole('button', { name: 'Geri al' })).toBeFocused()
  await expect(toast).toContainText('durdu')
  await page.clock.runFor(5600)
  expect(api.count(`DELETE /projects/${REF}/admin/rows/public/notes`)).toBe(0)
  await page.getByRole('heading', { level: 1 }).click() // moving on resumes the count
  await expect(toast).toContainText(/\d sn/)
  await page.clock.runFor(2000)
  expect(api.count(`DELETE /projects/${REF}/admin/rows/public/notes`)).toBe(0) // still inside the window
  await page.clock.runFor(3600)
  await expect.poll(() => api.count(`DELETE /projects/${REF}/admin/rows/public/notes`)).toBe(1)
  expect(api.calls.find((c) => c.key.startsWith('DELETE'))!.body).toEqual({ pk: { id: 2 } })
  await expect(page.getByRole('status').filter({ hasText: 'Satır siliniyor' })).toHaveCount(0)
  await expect(row).toHaveCount(0)
})

test('a keyboard delete puts focus on Geri al; Enter there keeps the row and nothing is sent', async ({ page }) => {
  await page.clock.install() // the 5 s undo window runs on a fake clock, not real waits
  const api = await mockApi(page, routes())
  await page.goto(`/project/${REF}/editor`)
  const row = page.getByRole('row').filter({ hasText: 'ilk sürüm yayında' })
  await row.focus()
  await page.keyboard.press('Enter')
  const sheet = page.getByRole('dialog', { name: 'Satırı düzenle' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Sil' }).focus()
  await page.keyboard.press('Enter')

  const toast = page.getByRole('status').filter({ hasText: 'Satır siliniyor' })
  const undo = toast.getByRole('button', { name: 'Geri al' })
  await expect(row).toHaveCount(0)
  await expect(undo).toBeFocused()
  // a screen reader hears what Geri al would bring back
  await expect(undo).toHaveAccessibleDescription(/Satır siliniyor….*public\.notes · id=2/)
  await page.keyboard.press('Enter')
  await expect(row).toHaveCount(1)
  await expect(toast).toHaveCount(0)
  await expect(row).toBeFocused() // back where the delete started
  await page.clock.runFor(5600)
  expect(api.count(`DELETE /projects/${REF}/admin/rows/public/notes`)).toBe(0)
})

test('a tap on the undo toast does not hold the delete; a mouse hover does, and says so to a screen reader', async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true })
  await ctx.addInitScript(inTurkish)
  const page = await ctx.newPage()
  await page.clock.install() // the 5 s undo window runs on a fake clock, not real waits
  const api = await mockApi(page, routes())
  const DEL = `DELETE /projects/${REF}/admin/rows/public/notes`
  await page.goto(`/project/${REF}/editor`)
  await page.getByRole('row').filter({ hasText: 'ilk sürüm yayında' }).click()
  await page.getByRole('dialog', { name: 'Satırı düzenle' }).getByRole('button', { name: 'Sil' }).click()
  const toast = page.getByRole('status').filter({ hasText: 'Satır siliniyor' })
  await expect(toast.getByText('Geri sayım durdu')).toHaveCount(1) // focus holds it: announced in the live region
  await page.getByRole('heading', { level: 1 }).tap() // focus leaves: the count runs
  await expect(toast.getByText('Geri sayım durdu')).toHaveCount(0)
  // what a phone sends for a tap: a touch pointer, then compat mouse events (Playwright's CDP tap omits the latter)
  const tx = toast.locator('.tx')
  await tx.dispatchEvent('pointerover', { pointerType: 'touch' })
  await tx.dispatchEvent('mouseover')
  await page.waitForTimeout(300)
  await expect(toast).not.toContainText('durdu')
  await toast.locator('.tx').hover() // a real mouse does hold it
  await expect(toast).toContainText('durdu')
  await page.clock.runFor(5600)
  expect(api.count(DEL)).toBe(0)
  await page.mouse.move(700, 40)
  await page.clock.runFor(5600)
  await expect.poll(() => api.count(DEL)).toBe(1)
  await ctx.close()
})

test('key-value labels keep identifiers in their own case under lang="tr": id, not İD', async ({ page }) => {
  const r = routes()
  r[`POST /projects/${REF}/admin/sql`] = { body: { columns: ['id', 'is_admin'], rows: [[7, true]], rowCount: 1, durationMs: 2 } }
  await mockApi(page, r)
  await page.goto(`/project/${REF}/sql`)
  await page.getByRole('textbox', { name: 'SQL sorgusu' }).click()
  await page.keyboard.type('select id, is_admin from profiles')
  await page.keyboard.press('Control+Enter')
  await page.getByRole('cell', { name: '7', exact: true }).click()
  // innerText is what is painted, so it includes any text-transform
  await expect(page.getByRole('dialog', { name: 'Satır 1' }).locator('dt')).toHaveText(['id', 'is_admin'], { useInnerText: true })

  await page.goto(`/project/${REF}`)
  await expect(page.locator('dl.kv dt').filter({ hasText: 'service_role' })).toHaveText('service_role (gizli)', { useInnerText: true })
})

test('keyboard focus runs skip link, sidebar, top bar, then the page; the skip link jumps to the content', async ({ page }) => {
  await mockApi(page, routes())
  await page.goto('/org/acme')
  await expect(page.getByRole('heading', { name: 'Projeler' })).toBeVisible()
  const names: string[] = []
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab')
    names.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      return (el.getAttribute('aria-label') || el.textContent || '').trim()
    }))
  }
  expect(names).toEqual([
    'İçeriğe geç', 'Organizasyon',
    'Projeler', 'Üyeler', 'Erişim belirteçleri', 'Denetim kaydı', 'Kapasite', 'Dil',
    'Çıkış', 'Acme', 'Ara veya komut çalıştır…CtrlK', 'Temayı değiştir',
    'Yenile', 'İçe aktar', 'Yeni proje', expect.stringContaining('Tümü'),
  ])

  await page.goto('/org/acme')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'İçeriğe geç' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main.content')).toBeFocused()
})

test('two quick theme switches land back on the first theme', async ({ page }) => {
  await mockApi(page, routes())
  await page.goto('/org/acme')
  await expect(page.getByRole('heading', { name: 'Projeler' })).toBeVisible()
  expect(await theme(page)).toBe('dark')
  // two presses in one task: the second comes before the first reveal has swapped the theme
  await page.evaluate(() => { for (let i = 0; i < 2; i++) dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true })) })
  await page.waitForTimeout(1200) // both reveals done
  expect(await theme(page)).toBe('dark')
  expect(await page.evaluate(() => localStorage.getItem('studio-theme'))).toBe('dark')
})
