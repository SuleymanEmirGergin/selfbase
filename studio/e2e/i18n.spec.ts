import { expect, test } from '@playwright/test'
import { REF, fx, mockApi, routes } from './helpers.ts'

// Studio is English unless the viewer picks Türkçe; the choice changes the copy, <html lang> and number formatting,
// and survives a reload.

const signedOut = { 'GET /me': { status: 401, body: fx('unauthorized') }, 'POST /refresh': { status: 401, body: fx('unauthorized') } }
// the Turkish catalogue: its source module on the dev server, its own chunk in the build
const TR_CHUNK = /\/src\/i18n\/tr\.ts$|\/assets\/tr-[\w-]+\.js$/
const lang = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.lang)

test('a first visit is in English, with <html lang="en">', async ({ page }) => {
  await mockApi(page, signedOut)
  await page.goto('/sign-in')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(await lang(page)).toBe('en')
})

test('an English visit does not download the Turkish catalogue; switching loads it', async ({ page }) => {
  const trLoads: string[] = []
  page.on('request', (r) => { if (TR_CHUNK.test(new URL(r.url()).pathname)) trLoads.push(r.url()) })
  await mockApi(page, routes())
  await page.goto('/org/acme')
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
  expect(trLoads).toEqual([])
  await page.getByLabel('Language').selectOption('tr')
  await expect(page.getByRole('heading', { name: 'Projeler', level: 1 })).toBeVisible()
  expect(trLoads.length).toBeGreaterThan(0)
})

test('the signed-out screens have their own language switch', async ({ page }) => {
  await mockApi(page, signedOut)
  await page.goto('/sign-in')
  await page.getByLabel('Language').selectOption('tr')
  await expect(page.getByRole('heading', { name: 'Tekrar hoş geldin' })).toBeVisible()
  await page.goto('/reset-password')
  await expect(page.getByLabel('Dil')).toHaveValue('tr')
  await page.getByLabel('Dil').selectOption('en')
  await expect(page.getByRole('button', { name: 'Send link' })).toBeVisible()
})

const blockTurkish = (page: import('@playwright/test').Page) => page.route((u) => TR_CHUNK.test(u.pathname), (r) => r.abort())

test('a stored Turkish choice whose catalogue fails to load starts the session wholly in English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('studio-locale', 'tr'))
  await blockTurkish(page)
  await mockApi(page, routes())
  await page.goto('/org/acme/capacity')
  await expect(page.getByRole('heading', { name: 'Capacity', level: 1 })).toBeVisible()
  expect(await lang(page)).toBe('en')
  await expect(page.getByRole('cell', { name: '2,336 MiB' })).toBeVisible() // English numbers too, not "2.336"
  await expect(page.getByLabel('Language')).toHaveValue('en')
  expect(await page.evaluate(() => localStorage.getItem('studio-locale'))).toBe('tr') // the next visit tries again
})

test('a catalogue that stalls holds the first paint about 2 seconds, then the app starts in English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('studio-locale', 'tr'))
  await page.route((u) => TR_CHUNK.test(u.pathname), () => {}) // never answered
  await mockApi(page, routes())
  await page.goto('/org/acme')
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible({ timeout: 4000 })
  expect(await lang(page)).toBe('en')
})

test('picking Türkçe when its catalogue cannot load says so and stays in English', async ({ page }) => {
  await blockTurkish(page)
  await mockApi(page, routes())
  await page.goto('/org/acme')
  await page.getByLabel('Language').selectOption('tr')
  await expect(page.getByRole('alert')).toContainText('Could not load that language')
  await expect(page.getByLabel('Language')).toHaveValue('en')
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
  // the palette command takes the same path
  await page.keyboard.press('Control+K')
  await page.getByRole('combobox', { name: 'Search commands' }).fill('türkçe')
  await page.getByRole('option', { name: /Language: Türkçe/ }).click()
  await expect(page.getByRole('alert')).toHaveCount(2)
  expect(await lang(page)).toBe('en')
})

test('switching to Türkçe in the sidebar changes the copy, lang and numbers, and survives a reload', async ({ page }) => {
  await mockApi(page, routes())
  await page.goto('/org/acme/capacity')
  await expect(page.getByRole('heading', { name: 'Capacity', level: 1 })).toBeVisible()
  await expect(page.getByRole('cell', { name: '2,336 MiB' })).toBeVisible()

  await page.getByLabel('Language').selectOption('tr')
  await expect(page.getByRole('heading', { name: 'Kapasite', level: 1 })).toBeVisible()
  await expect(page.getByRole('cell', { name: '2.336 MiB' })).toBeVisible()
  expect(await lang(page)).toBe('tr')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Kapasite', level: 1 })).toBeVisible()
  await expect(page.getByLabel('Dil')).toHaveValue('tr')
  expect(await lang(page)).toBe('tr')
})

test('a switch on Members also changes the role options in the invite form', async ({ page }) => {
  await mockApi(page, routes())
  await page.goto('/org/acme/members')
  const roles = page.locator('form select').first()
  await expect(roles.locator('option')).toHaveText(['Owner', 'Administrator', 'Developer', 'Read-only'])
  await page.getByLabel('Language').selectOption('tr')
  await expect(roles.locator('option')).toHaveText(['Sahip', 'Yönetici', 'Geliştirici', 'Salt okunur'])
})

test('server errors: a known code with its exact message reads in the chosen language; any other keeps the server words and its code', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('studio-locale', 'tr'))
  const fail = (body: object) => ({ ...routes(), 'GET /projects': { status: 409, body } })
  const alert = page.getByRole('alert')
  await mockApi(page, fail({ error: 'project_busy', message: 'another operation is running on this project; try again when it ends' }))
  await page.goto('/org/acme')
  await expect(alert).toContainText('Bu projede başka bir işlem sürüyor')
  await expect(alert).not.toContainText('another operation')

  // a refusal written for the user, with no catalogue copy: the server's words stay, the code sits beside them
  const taken = 'api.example.com is already used by another project'
  for (const body of [{ error: 'hostname_taken', message: taken }, { error: 'quota_exceeded', message: 'over quota' }]) {
    await page.unrouteAll()
    await mockApi(page, fail(body))
    await page.reload()
    await expect(alert).toContainText(body.message)
    await expect(alert.locator('code')).toHaveText(body.error)
  }

  // a mapped code whose message says more than the copy would (here a different 403): the server's words again
  await page.unrouteAll()
  await mockApi(page, fail({ error: 'forbidden', message: 'Only an organization owner can create an organization' }))
  await page.reload()
  await expect(alert).toContainText('Only an organization owner can create an organization')

  // the weak-password minimum is carried into the copy
  await page.unrouteAll()
  await mockApi(page, fail({ error: 'weak_password', message: 'Password should be at least 12 characters.' }))
  await page.reload()
  await expect(alert).toContainText('Şifre en az 12 karakter olmalı.')
})

test('a full server refuses a new project in Turkish copy that keeps both numbers', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('studio-locale', 'tr'))
  await mockApi(page, { ...routes(), 'POST /projects': { status: 409, body: {
    error: 'insufficient_memory', details: { neededMb: 1024, freeMb: 412 },
    message: 'This server has 412 MiB of memory free and a medium project needs 1024 MiB. Pause or delete a project you do not use, or choose a smaller size.',
  } } })
  await page.goto('/new/acme')
  await page.getByLabel('Proje adı').fill('demo')
  await page.getByRole('button', { name: 'Proje oluştur' }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('412 MiB')
  await expect(alert).toContainText('1.024 MiB')
  await expect(alert).not.toContainText('This server')
})

test('the reset screen shows the auth server rate limit in its own words', async ({ page }) => {
  const msg = 'For security purposes, you can only request this after 52 seconds.'
  await mockApi(page, { ...signedOut, 'POST /auth/v1/recover': { status: 429, body: { error: 'over_email_send_rate_limit', message: msg } } })
  await page.goto('/reset-password')
  await page.getByLabel('Email').fill('a@example.test')
  await page.getByRole('button', { name: 'Send link' }).click()
  await expect(page.getByRole('alert')).toContainText(msg)
  await expect(page.getByRole('alert').locator('code')).toHaveText('over_email_send_rate_limit')
})

test('on the SQL screen a switch renames the editor for screen readers and reformats the duration', async ({ page }) => {
  await mockApi(page, { ...routes(), [`POST /projects/${REF}/admin/sql`]: { body: { columns: ['n'], rows: [[1]], rowCount: 1, durationMs: 1234 } } })
  await page.goto(`/project/${REF}/sql`)
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toBeVisible()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText('1,234 ms')).toBeVisible()
  await page.getByLabel('Language').selectOption('tr')
  await expect(page.getByRole('textbox', { name: 'SQL sorgusu' })).toBeVisible()
  await expect(page.getByText('1.234 ms')).toBeVisible()
})

test('the Ctrl+K palette offers the other language and switches to it', async ({ page }) => {
  await mockApi(page, routes())
  await page.goto('/org/acme')
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
  await page.keyboard.press('Control+K')
  await page.getByRole('combobox', { name: 'Search commands' }).fill('türkçe')
  await page.getByRole('option', { name: /Language: Türkçe/ }).click()
  await expect(page.getByRole('heading', { name: 'Projeler', level: 1 })).toBeVisible()
  expect(await lang(page)).toBe('tr')

  // and back: the palette now offers English
  await page.keyboard.press('Control+K')
  await page.getByRole('combobox', { name: 'Komut ara' }).fill('english')
  await page.getByRole('option', { name: /Dil: English/ }).click()
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
  expect(await lang(page)).toBe('en')
})
