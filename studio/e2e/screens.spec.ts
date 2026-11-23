import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PAUSED, REF, fx, mockApi, routes } from './helpers.ts'
import type { Routes } from './helpers.ts'

// Every screen in English, dark and light, at 1440x900, written to docs/screens/studio-v3, plus a Turkish set of
// sign-in and project home. Opt-in (STUDIO_SHOTS=1) so a normal
// run never rewrites the committed images. Reduced motion makes the shots deterministic (entrance animations end at once).
test.skip(!process.env.STUDIO_SHOTS, 'set STUDIO_SHOTS=1 to write the screenshots')
test.use({ reducedMotion: 'reduce' })

const OUT = new URL('../../docs/screens/studio-v3/', import.meta.url)
const signedOut: Routes = { 'GET /me': { status: 401, body: fx('unauthorized') }, 'POST /refresh': { status: 401, body: fx('unauthorized') } }

type Shot = { name: string; path: string; ready: (p: Page) => Promise<unknown>; r?: Routes; then?: (p: Page) => Promise<unknown> }
const h1 = (name: string | RegExp) => (p: Page) => expect(p.getByRole('heading', { name }).first()).toBeVisible()
const P = `/project/${REF}`

const SHOTS: Shot[] = [
  { name: 'sign-in', path: '/sign-in', r: signedOut, ready: h1('Welcome back') },
  { name: 'invite', path: '/invite/tok123', r: signedOut, ready: (p) => expect(p.getByRole('button', { name: 'Accept the invitation' })).toBeVisible() },
  { name: 'reset-password', path: '/reset-password', r: signedOut, ready: (p) => expect(p.getByRole('button', { name: 'Send link' })).toBeVisible() },
  { name: 'org-projects', path: '/org/acme', ready: h1('Projects') },
  { name: 'org-new-project', path: '/new/acme', ready: (p) => expect(p.getByText('9,632 MiB free')).toBeVisible() },
  { name: 'org-import', path: '/import/acme', ready: (p) => expect(p.getByLabel('Backup directory')).toBeVisible() },
  { name: 'org-members', path: '/org/acme/members', ready: (p) => expect(p.getByRole('cell').first()).toBeVisible() },
  { name: 'org-tokens', path: '/org/acme/tokens', ready: (p) => expect(p.getByRole('cell', { name: 'ci', exact: true })).toBeVisible() },
  { name: 'org-audit', path: '/org/acme/audit', ready: (p) => expect(p.getByRole('cell').first()).toBeVisible() },
  { name: 'org-capacity', path: '/org/acme/capacity', ready: (p) => expect(p.getByRole('cell', { name: '2,336 MiB' })).toBeVisible() },
  { name: 'project-home', path: `${P}/home`, ready: (p) => expect(p.getByRole('cell', { name: '412 / 1,024 MiB' })).toBeVisible() },
  { name: 'project-tables', path: `${P}/editor`, ready: (p) => expect(p.getByRole('cell', { name: 'merhaba studio' })).toBeVisible() },
  { name: 'project-row-sheet', path: `${P}/editor`, ready: (p) => expect(p.getByRole('cell', { name: 'merhaba studio' })).toBeVisible(),
    then: (p) => p.getByRole('cell', { name: 'merhaba studio' }).click() },
  { name: 'project-sql', path: `${P}/sql`, ready: (p) => expect(p.getByRole('textbox', { name: 'SQL query' })).toBeVisible(),
    then: async (p) => { await p.getByRole('button', { name: /Run/ }).click(); await p.waitForTimeout(300) } },
  { name: 'project-rls', path: `${P}/policies`, ready: (p) => expect(p.getByRole('button', { name: 'Add policy' }).first()).toBeVisible() },
  { name: 'project-users', path: `${P}/auth/users`, ready: (p) => expect(p.getByRole('cell').first()).toBeVisible() },
  { name: 'project-storage', path: `${P}/storage`, ready: (p) => expect(p.getByRole('button', { name: /media/ }).first()).toBeVisible() },
  { name: 'project-sites', path: `${P}/sites`, ready: h1('Sites') },
  { name: 'project-logs', path: `${P}/logs`, ready: (p) => expect(p.getByLabel('Service')).toBeVisible() },
  { name: 'project-settings', path: `${P}/settings`, ready: h1(/Settings/) },
  { name: 'project-paused', path: `/project/${PAUSED}/editor`, ready: h1('Project paused') },
  { name: 'state-palette', path: '/org/acme', ready: h1('Projects'),
    then: async (p) => { await p.keyboard.press('Control+K'); await p.getByRole('combobox', { name: 'Search commands' }).fill('pro') } },
  { name: 'state-undo-toast', path: `${P}/editor`, ready: (p) => expect(p.getByRole('cell', { name: 'ilk sürüm yayında' })).toBeVisible(),
    then: async (p) => {
      await p.getByRole('cell', { name: 'ilk sürüm yayında' }).click()
      await p.getByRole('dialog', { name: 'Edit row' }).getByRole('button', { name: 'Delete' }).click()
      await expect(p.getByText('Undo', { exact: true })).toBeVisible()
    } },
  { name: 'state-empty', path: '/org/acme/tokens', r: { 'GET /access-tokens': { body: [] } }, ready: (p) => expect(p.getByText('No tokens yet')).toBeVisible() },
  { name: 'state-error', path: '/org/acme', r: { 'GET /projects': { status: 500, body: { message: 'Could not reach the control service.' } } },
    ready: (p) => expect(p.getByText('Could not reach the control service.')).toBeVisible() },
  { name: 'state-skeleton', path: '/org/acme', r: { 'GET /projects': { delay: 20_000, body: [] } }, ready: (p) => expect(p.locator('.sk').first()).toBeVisible() },
]

for (const scheme of ['dark', 'light'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme })
    for (const s of SHOTS) {
      test(s.name, async ({ page }) => {
        await mockApi(page, { ...routes(), ...s.r })
        await page.goto(s.path)
        await s.ready(page)
        await s.then?.(page)
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: fileURLToPath(new URL(`${s.name}-${scheme}.png`, OUT)) })
      })
    }
  })
}

// The Turkish set: sign-in and project home, dark and light.
const TURKISH: Shot[] = [
  { name: 'sign-in-tr', path: '/sign-in', r: signedOut, ready: h1('Tekrar hoş geldin') },
  { name: 'project-home-tr', path: `${P}/home`, ready: (p) => expect(p.getByRole('cell', { name: '412 / 1.024 MiB' })).toBeVisible() },
]
for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme} tr`, () => {
    test.use({ colorScheme: scheme })
    for (const s of TURKISH) {
      test(s.name, async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('studio-locale', 'tr'))
        await mockApi(page, { ...routes(), ...s.r })
        await page.goto(s.path)
        await s.ready(page)
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: fileURLToPath(new URL(`${s.name}-${scheme}.png`, OUT)) })
      })
    }
  })
}

// Sign-in at phone width (the art becomes a band over the form), and once with motion so the loop video is captured.
test.describe('sign-in extras', () => {
  test('sign-in-phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockApi(page, signedOut)
    await page.goto('/sign-in')
    await h1('Welcome back')(page)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: fileURLToPath(new URL('sign-in-phone-dark.png', OUT)) })
  })
  // between phone and desktop: below 900 px the art stacks over the form instead of squeezing it
  test('sign-in-800', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 })
    await mockApi(page, signedOut)
    await page.goto('/sign-in')
    await h1('Welcome back')(page)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: fileURLToPath(new URL('sign-in-800-dark.png', OUT)) })
  })
  test('sign-in-video', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'no-preference' })
    const page = await ctx.newPage()
    await mockApi(page, signedOut)
    await page.goto('/sign-in')
    await expect(page.locator('.a-art.has-vid')).toHaveCount(1, { timeout: 10_000 }) // the loop really plays
    await page.waitForTimeout(1500) // past the fade-in
    await page.screenshot({ path: fileURLToPath(new URL('sign-in-video-dark.png', OUT)) })
    await ctx.close()
  })
})
