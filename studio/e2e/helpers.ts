import { expect, request } from '@playwright/test'
import type { Page } from '@playwright/test'

export const EMAIL = process.env.PANEL_E2E_EMAIL ?? ''
export const PASSWORD = process.env.PANEL_E2E_PASSWORD ?? ''
if (!EMAIL || !PASSWORD) throw new Error('set PANEL_E2E_EMAIL and PANEL_E2E_PASSWORD (the panel admin login of the stack under test)')

/** Logged-in Admin API context for seeding; runs SQL through /admin/sql and fails on an SQL error. */
export async function adminApi(baseURL: string) {
  const ctx = await request.newContext({ baseURL })
  const login = await ctx.post('/admin/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(login.status()).toBe(200)
  return {
    ctx,
    sql: async (query: string) => {
      const body = await (await ctx.post('/admin/sql', { data: { query } })).json()
      if (body.error) throw new Error(`seed sql failed: ${body.error.message}`)
      return body
    },
  }
}

export async function login(page: Page) {
  await page.goto('/panel/')
  await page.getByLabel('E-posta').fill(EMAIL)
  await page.getByLabel('Parola').fill(PASSWORD)
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await expect(page.getByRole('navigation', { name: 'Ana menü' })).toBeVisible()
}

export const nav = (page: Page, label: string) =>
  page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: label }).click()
