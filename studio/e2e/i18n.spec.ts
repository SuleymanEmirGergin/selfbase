import { expect, test } from '@playwright/test'
import { fx, mockApi, routes } from './helpers.ts'

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
