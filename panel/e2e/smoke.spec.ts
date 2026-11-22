import { expect, test } from '@playwright/test'
import { adminApi, login, nav } from './helpers.ts'

// Smoke test of the panel against a running stack: one pass through every page.
const id = Date.now().toString(36)
const TABLE = `smoke_${id}`
const BUCKET = `smoke-${id}`

test.beforeAll(async ({ baseURL }) => {
  const { ctx, sql } = await adminApi(baseURL!)
  await sql(`create table public.${TABLE} (id serial primary key, note text not null, done boolean default false);
    alter table public.${TABLE} enable row level security;
    insert into auth.users (email, aud, role) values ('${TABLE}@example.test', 'authenticated', 'authenticated');`)
  expect((await ctx.post('/admin/buckets', { data: { id: BUCKET, public: false } })).status()).toBe(200)
  await ctx.dispose()
})

test('panel smoke: tables, sql, rls, users, files', async ({ page }) => {
  await test.step('login', () => login(page))

  await test.step('tables: add a row and see it in the grid', async () => {
    await nav(page, 'Tablolar')
    await page.getByRole('complementary', { name: 'Tablolar' }).getByRole('button', { name: TABLE }).click()
    await expect(page.getByText('Bu tablo boş.')).toBeVisible()
    await page.getByRole('button', { name: 'Satır ekle' }).click()
    await page.getByRole('dialog', { name: 'Satır ekle' }).getByLabel('note').fill('merhaba panel')
    await page.getByRole('button', { name: 'Kaydet' }).click()
    await expect(page.getByRole('cell', { name: 'merhaba panel' })).toBeVisible()
    await expect(page.getByText('1–1 / 1 satır')).toBeVisible()
  })

  await test.step('tables: delete asks for confirmation', async () => {
    await page.getByRole('cell', { name: 'merhaba panel' }).click()
    await page.getByRole('dialog', { name: 'Satırı düzenle' }).getByRole('button', { name: 'Sil' }).click()
    const confirm = page.locator('dialog.confirm')
    await expect(confirm).toContainText(`public.${TABLE}`)
    await confirm.getByRole('button', { name: 'Vazgeç' }).click()
    await expect(page.getByRole('cell', { name: 'merhaba panel' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Satırı düzenle' })).toBeHidden()
  })

  await test.step('sql: select 1', async () => {
    await nav(page, 'SQL')
    const editor = page.getByLabel('SQL sorgusu')
    await editor.fill('select 1 as one')
    await editor.press('Control+Enter')
    await expect(page.getByRole('columnheader', { name: 'one' })).toBeVisible()
    await expect(page.getByRole('cell', { name: '1', exact: true })).toBeVisible()
    await editor.fill('select nope')
    await page.getByRole('button', { name: 'Çalıştır' }).click()
    await expect(page.getByRole('alert')).toContainText('column "nope" does not exist')
  })

  await test.step('rls: add a policy and see it listed', async () => {
    await nav(page, 'RLS')
    const card = page.getByRole('article', { name: TABLE })
    await card.getByRole('button', { name: 'Policy ekle' }).click()
    const drawer = page.getByRole('dialog', { name: 'Policy ekle' })
    await drawer.getByLabel('Ad').fill('smoke read')
    await drawer.getByLabel('Komut').selectOption('SELECT')
    await drawer.getByLabel('Roller').fill('anon')
    await drawer.getByLabel('USING').fill('true')
    await drawer.getByRole('button', { name: 'Kaydet' }).click()
    await expect(card.getByText('smoke read')).toBeVisible()
    await expect(card.getByText('SELECT', { exact: true })).toBeVisible()
  })

  await test.step('users: list opens', async () => {
    await nav(page, 'Kullanıcılar')
    await page.getByLabel('Kullanıcı ara').fill(TABLE)
    await expect(page.getByText(`${TABLE}@example.test`)).toBeVisible()
  })

  await test.step('files: upload and see it listed', async () => {
    await nav(page, 'Dosyalar')
    await page.getByRole('complementary', { name: "Bucket'lar" }).getByRole('button', { name: BUCKET }).click()
    await expect(page.getByText('Bu bucket boş.', { exact: false })).toBeVisible()
    await page.getByLabel('Yüklenecek dosyalar').setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect(page.getByRole('cell', { name: 'hello.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'text/plain', exact: true })).toBeVisible()
  })
})

test('no horizontal page scroll at 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await login(page)
  for (const hash of ['tables', 'rls', 'sql', 'users', 'files']) {
    await page.goto(`/panel/#/${hash}`)
    await page.waitForLoadState('networkidle')
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
    expect(scrollWidth, `#/${hash}`).toBeLessThanOrEqual(innerWidth)
  }
})
