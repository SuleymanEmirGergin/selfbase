import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'
import { adminApi, login, nav } from './helpers.ts'

// Smoke test of the panel against a running stack: one pass through every page. Everything it creates is dropped after.
const id = Date.now().toString(36)
const TABLE = `smoke_${id}`
const BUCKET = `smoke-${id}`
const SCHEMA2 = `smoke_${id}_s` // second schema for the stale-response test
const OTHER = `other_${id}`

test.beforeAll(async ({ baseURL }) => {
  const { ctx, sql } = await adminApi(baseURL!)
  await sql(`create table public.${TABLE} (id serial primary key, note text not null, done boolean default false);
    alter table public.${TABLE} enable row level security;
    create schema ${SCHEMA2};
    create table ${SCHEMA2}.${OTHER} (id int primary key);
    alter table ${SCHEMA2}.${OTHER} enable row level security;
    insert into auth.users (email, aud, role) values ('${TABLE}@example.test', 'authenticated', 'authenticated');`)
  expect((await ctx.post('/admin/buckets', { data: { id: BUCKET, public: false } })).status()).toBe(200)
  await ctx.dispose()
})

test.afterAll(async ({ baseURL }) => {
  const { ctx, sql } = await adminApi(baseURL!)
  await ctx.delete(`/admin/files/${BUCKET}/hello.txt`) // 404 when the upload step never ran
  await sql(`drop table if exists public.${TABLE};
    drop schema if exists ${SCHEMA2} cascade;
    delete from auth.users where email = '${TABLE}@example.test';
    delete from storage.objects where bucket_id = '${BUCKET}';
    delete from storage.buckets where id = '${BUCKET}';`)
  await ctx.dispose()
})

test('panel smoke: tables, sql, rls, users, files', async ({ page }) => {
  await test.step('login', () => login(page))

  await test.step('tables: add a row and see it in the grid', async () => {
    await nav(page, 'Tablolar')
    await page.getByRole('complementary', { name: 'Tablolar' }).getByRole('button', { name: TABLE }).click()
    await expect(page.getByText('Bu tablo boş.')).toBeVisible()
    await page.getByRole('button', { name: 'Satır ekle' }).click()
    const note = page.getByRole('dialog', { name: 'Satır ekle' }).getByLabel('note')
    await expect(page.getByRole('dialog', { name: 'Satır ekle' }).getByLabel('id')).not.toBeFocused() // focus skips the key
    await note.fill('merhaba panel')
    await page.getByRole('button', { name: 'Kaydet' }).click()
    await expect(page.getByRole('cell', { name: 'merhaba panel' })).toBeVisible()
    await expect(page.getByText('1–1 / 1 satır')).toBeVisible()
  })

  await test.step('tables: delete asks for confirmation; drawer traps focus and returns it', async () => {
    const cell = page.getByRole('cell', { name: 'merhaba panel' })
    await cell.click()
    const drawer = page.getByRole('dialog', { name: 'Satırı düzenle' })
    await expect(drawer.getByLabel('note')).toBeFocused()
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
    expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await drawer.getByRole('button', { name: 'Sil' }).click()
    const confirm = page.locator('dialog.confirm')
    await expect(confirm).toContainText(`public.${TABLE}`)
    await confirm.getByRole('button', { name: 'Vazgeç' }).click()
    await expect(cell).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(page.getByRole('row').filter({ has: cell })).toBeFocused()
  })

  await test.step('sql: select 1', async () => {
    await nav(page, 'SQL')
    const editor = page.getByLabel('SQL sorgusu')
    await editor.fill('select 1 as one')
    await editor.press('Control+Enter')
    await expect(page.getByRole('columnheader', { name: 'one' })).toBeVisible()
    await expect(page.getByRole('cell', { name: '1', exact: true })).toBeVisible()
    await expect(page.getByText('1 satır', { exact: true })).toBeVisible()
    await editor.fill('set statement_timeout = 0')
    await editor.press('Control+Enter')
    await expect(page.getByText('Tamamlandı', { exact: true })).toBeVisible()
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

test('rls: a late response for the previous schema is dropped, and create uses the shown table schema', async ({ page }) => {
  await login(page)
  // hold the first schema's listing back until after the operator has switched schema
  const hold = async (route: import('@playwright/test').Route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue() }
  await page.route('**/admin/tables?schema=public', hold)
  await page.route('**/admin/policies?schema=public', hold)
  await nav(page, 'RLS')
  await page.getByLabel('Şema').selectOption(SCHEMA2)
  await expect(page.getByRole('article', { name: OTHER })).toBeVisible()
  await page.waitForTimeout(2000) // the held public responses have landed by now
  await expect(page.getByRole('article', { name: OTHER })).toBeVisible()
  await expect(page.getByRole('article', { name: TABLE })).toHaveCount(0)

  await page.getByRole('article', { name: OTHER }).getByRole('button', { name: 'Policy ekle' }).click()
  const drawer = page.getByRole('dialog', { name: 'Policy ekle' })
  await drawer.getByLabel('Ad').fill('stale check')
  await drawer.getByLabel('USING').fill('true')
  const sent = page.waitForRequest((r) => r.url().endsWith('/admin/policies') && r.method() === 'POST')
  await drawer.getByRole('button', { name: 'Kaydet' }).click()
  expect((await sent).postDataJSON()).toMatchObject({ schema: SCHEMA2, table: OTHER })
  await expect(page.getByRole('article', { name: OTHER }).getByText('stale check')).toBeVisible()
})

const W = 375
const H = 812
async function inViewport(loc: Locator) {
  const b = await loc.boundingBox()
  expect(b, 'element has a box').not.toBeNull()
  expect(b!.x).toBeGreaterThanOrEqual(0)
  expect(b!.y).toBeGreaterThanOrEqual(0)
  expect(b!.x + b!.width).toBeLessThanOrEqual(W + 0.5)
  expect(b!.y + b!.height).toBeLessThanOrEqual(H + 0.5)
}

test('375 px: no horizontal page scroll, menu, drawer and primary actions stay on screen', async ({ page }) => {
  await page.setViewportSize({ width: W, height: H })
  await login(page)
  const primary: Record<string, (l: typeof page) => Locator> = {
    tables: (p) => p.getByRole('button', { name: 'Satır ekle' }),
    rls: (p) => p.getByRole('button', { name: 'Policy ekle' }).first(),
    sql: (p) => p.getByRole('button', { name: 'Çalıştır' }),
    users: (p) => p.getByLabel('Kullanıcı ara'),
    files: (p) => p.getByRole('button', { name: 'Yükle' }),
  }
  for (const [hash, get] of Object.entries(primary)) {
    await page.goto(`/panel/#/${hash}`)
    await page.waitForLoadState('networkidle')
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
    expect(scrollWidth, `#/${hash}`).toBeLessThanOrEqual(innerWidth)
    const action = get(page)
    await expect(action, `#/${hash} primary action`).toBeVisible()
    await inViewport(action)
    await action.click({ trial: true })
  }

  await page.goto('/panel/#/tables')
  await page.getByRole('button', { name: 'Menü' }).click()
  const menu = page.getByRole('navigation', { name: 'Ana menü' }).getByRole('list')
  await expect(menu).toBeVisible()
  await inViewport(menu)
  await inViewport(page.getByRole('button', { name: 'Çıkış' }))
  await page.getByRole('button', { name: 'Menü' }).click()
  await expect(menu).toBeHidden()

  await page.getByRole('complementary', { name: 'Tablolar' }).getByRole('button', { name: TABLE }).click()
  await page.getByRole('button', { name: 'Satır ekle' }).click()
  const drawer = page.getByRole('dialog', { name: 'Satır ekle' })
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))) // measure after the slide-in
  await inViewport(drawer)
  const save = drawer.getByRole('button', { name: 'Kaydet' })
  await expect(save).toBeVisible()
  await inViewport(save)
  await save.click({ trial: true })
})
