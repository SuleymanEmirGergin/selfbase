import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { REF, fx, mockApi, routes } from './helpers.ts'

// v3 shell behaviour: theme switch, Ctrl+K palette, the undo toast and keyboard focus order.

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme)
const signedOut = { 'GET /me': { status: 401, body: fx('unauthorized') }, 'POST /refresh': { status: 401, body: fx('unauthorized') } }

test('the sign-in art panel is hidden from assistive tech, has nothing to focus, and loads its loop muted with the still as poster', async ({ page }) => {
  await mockApi(page, signedOut)
  await page.goto('/sign-in')
  const panel = page.locator('.si-left')
  await expect(panel).toHaveAttribute('aria-hidden', 'true')
  expect(await panel.locator('a, button, input, select, textarea, [tabindex], video[controls]').count()).toBe(0)
  await expect(page.getByRole('heading', { name: 'Tekrar hoş geldiniz' })).toBeVisible()
  const video = panel.locator('video')
  await expect(video).toHaveCount(1)
  expect(await video.evaluate((v: HTMLVideoElement) => [v.muted, v.loop, v.playsInline, v.preload, v.getAttribute('poster')]))
    .toEqual([true, true, true, 'metadata', '/signin/art.webp'])
  await expect(panel.getByText('#483')).toHaveCount(0) // no deploy number, only a sample label
})

test('under reduced motion the sign-in panel shows only the still: no video, no light passes', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await mockApi(page, signedOut)
  await page.goto('/sign-in')
  await expect(page.getByRole('heading', { name: 'Tekrar hoş geldiniz' })).toBeVisible()
  await expect(page.locator('.si-left video')).toHaveCount(0)
  await expect(page.locator('.si-left .sheen')).toHaveCount(0)
  await expect(page.locator('.si-left .a-art')).not.toHaveClass(/has-vid/)
  await expect(page.locator('.si-left .gl-c.done')).toHaveCount(4) // the sample pipeline sits finished
  await ctx.close()
})

test('on sign-in, keyboard focus starts and stays in the form', async ({ page }) => {
  await mockApi(page, signedOut)
  await page.goto('/sign-in')
  await expect(page.getByLabel('E-posta')).toBeFocused()
  const order: string[] = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab')
    order.push(await page.evaluate(() => { const el = document.activeElement as HTMLElement; return (el.getAttribute('aria-label') || el.textContent || el.getAttribute('type') || '').trim() }))
  }
  expect(order).toEqual(['Şifremi unuttum', 'password', 'Karakterleri göster', 'Giriş yap'])
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
  const api = await mockApi(page, routes())
  await page.goto(`/project/${REF}/editor`)
  const row = page.getByRole('row').filter({ hasText: 'ilk sürüm yayında' })

  await row.click()
  await page.getByRole('dialog', { name: 'Satırı düzenle' }).getByRole('button', { name: 'Sil' }).click()
  const toast = page.getByRole('status').filter({ hasText: 'Satır silindi' })
  await expect(toast).toContainText('public.notes · id=2')
  await expect(row).toHaveCount(0)
  await toast.getByRole('button', { name: 'Geri al' }).click()
  await expect(row).toHaveCount(1)
  await page.waitForTimeout(5600)
  expect(api.count(`DELETE /projects/${REF}/admin/rows/public/notes`)).toBe(0)

  await row.click()
  await page.getByRole('dialog', { name: 'Satırı düzenle' }).getByRole('button', { name: 'Sil' }).click()
  await expect(row).toHaveCount(0)
  // focus lands on Geri al and holds the count: nothing is sent while the toast keeps it
  await expect(toast.getByRole('button', { name: 'Geri al' })).toBeFocused()
  await expect(toast).toContainText('durdu')
  await page.waitForTimeout(5600)
  expect(api.count(`DELETE /projects/${REF}/admin/rows/public/notes`)).toBe(0)
  await page.getByRole('heading', { level: 1 }).click() // moving on resumes the count
  await expect(toast).toContainText(/\d sn/)
  await page.waitForTimeout(2000)
  expect(api.count(`DELETE /projects/${REF}/admin/rows/public/notes`)).toBe(0) // still inside the window
  await expect.poll(() => api.count(`DELETE /projects/${REF}/admin/rows/public/notes`), { timeout: 6000 }).toBe(1)
  expect(api.calls.find((c) => c.key.startsWith('DELETE'))!.body).toEqual({ pk: { id: 2 } })
  await expect(page.getByRole('status').filter({ hasText: 'Satır silindi' })).toHaveCount(0)
  await expect(row).toHaveCount(0)
})

test('a keyboard delete puts focus on Geri al; Enter there keeps the row and nothing is sent', async ({ page }) => {
  const api = await mockApi(page, routes())
  await page.goto(`/project/${REF}/editor`)
  const row = page.getByRole('row').filter({ hasText: 'ilk sürüm yayında' })
  await row.focus()
  await page.keyboard.press('Enter')
  const sheet = page.getByRole('dialog', { name: 'Satırı düzenle' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Sil' }).focus()
  await page.keyboard.press('Enter')

  const toast = page.getByRole('status').filter({ hasText: 'Satır silindi' })
  const undo = toast.getByRole('button', { name: 'Geri al' })
  await expect(row).toHaveCount(0)
  await expect(undo).toBeFocused()
  // a screen reader hears what Geri al would bring back
  await expect(undo).toHaveAccessibleDescription(/Satır silindi.*public\.notes · id=2/)
  await page.keyboard.press('Enter')
  await expect(row).toHaveCount(1)
  await expect(toast).toHaveCount(0)
  await expect(row).toBeFocused() // back where the delete started
  await page.waitForTimeout(5600)
  expect(api.count(`DELETE /projects/${REF}/admin/rows/public/notes`)).toBe(0)
})

test('keyboard focus runs skip link, sidebar, top bar, then the page; the skip link jumps to the content', async ({ page }) => {
  await mockApi(page, routes())
  await page.goto('/org/acme')
  await expect(page.getByRole('heading', { name: 'Projeler' })).toBeVisible()
  const names: string[] = []
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab')
    names.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      return (el.getAttribute('aria-label') || el.textContent || '').trim()
    }))
  }
  expect(names).toEqual([
    'İçeriğe geç', 'Organizasyon',
    'Projeler', 'Üyeler', 'Erişim belirteçleri', 'Denetim kaydı', 'Kapasite',
    'Çıkış', 'Acme', 'Ara veya komut çalıştır…CtrlK', 'Temayı değiştir',
    'Yenile', 'İçe aktar', 'Yeni proje', expect.stringContaining('Tümü'),
  ])

  await page.goto('/org/acme')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'İçeriğe geç' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main.content')).toBeFocused()
})
