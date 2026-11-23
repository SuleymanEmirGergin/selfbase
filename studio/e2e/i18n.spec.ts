import { expect, test } from '@playwright/test'
import { REF, fx, mockApi, routes } from './helpers.ts'

// Studio is English unless the viewer picks Türkçe; the choice changes the copy, <html lang> and number formatting,
// and survives a reload.

const signedOut = { 'GET /me': { status: 401, body: fx('unauthorized') }, 'POST /refresh': { status: 401, body: fx('unauthorized') } }
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
  page.on('request', (r) => { if (/\/i18n\/tr(\.ts)?[.?-]|\/tr-[\w-]+\.js/.test(r.url())) trLoads.push(r.url()) })
  await mockApi(page, routes())
  await page.goto('/org/acme')
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
  expect(trLoads).toEqual([])
  await page.getByLabel('Language').selectOption('tr')
  await expect(page.getByRole('heading', { name: 'Projeler', level: 1 })).toBeVisible()
  expect(trLoads.length).toBeGreaterThan(0)
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

test('server errors read in the chosen language: known codes from the catalogue, others generic with the code', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('studio-locale', 'tr'))
  const fail = (body: object) => ({ ...routes(), 'GET /projects': { status: 409, body } })
  await mockApi(page, fail({ error: 'project_busy', message: 'another operation is running on this project; try again when it ends' }))
  await page.goto('/org/acme')
  await expect(page.getByRole('alert')).toContainText('Bu projede başka bir işlem sürüyor')
  await expect(page.getByRole('alert')).not.toContainText('another operation')

  await page.unrouteAll()
  await mockApi(page, fail({ error: 'quota_exceeded', message: 'over quota' }))
  await page.reload()
  await expect(page.getByRole('alert').locator('code')).toHaveText('quota_exceeded')
  await expect(page.getByRole('alert')).not.toContainText('over quota')

  // a code whose message is the detail (which field, the SQL error) keeps the server's words
  await page.unrouteAll()
  await mockApi(page, fail({ error: 'validation_failed', message: 'name must be 1 to 100 characters' }))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('name must be 1 to 100 characters')
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
