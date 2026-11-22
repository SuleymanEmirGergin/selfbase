import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page, Request } from '@playwright/test'

// Studio shell against /platform fixtures (shapes of plan Tasks 10 and 13). No server: every call is intercepted.
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

type Reply = { status?: number; body?: unknown }
type Handler = Reply | ((req: Request) => Reply)
type Routes = Record<string, Handler>

/** Signed-in defaults, keyed `METHOD /path` relative to /platform (query string ignored). */
const signedIn = (): Routes => ({
  'GET /me': { body: fx('me') },
  'GET /projects': { body: fx('projects') },
  'GET /capacity': { body: fx('capacity') },
  'GET /organizations/acme/members': { body: fx('members') },
  'GET /access-tokens': { body: fx('access-tokens') },
  'GET /organizations/acme/audit-log': { body: fx('audit-log') },
})

async function mockApi(page: Page, routes: Routes) {
  const calls: { key: string; body: unknown }[] = []
  await page.route('**/platform/**', async (route) => {
    const req = route.request()
    const key = `${req.method()} ${new URL(req.url()).pathname.replace(/^\/platform/, '')}`
    let body: unknown = null
    try { body = req.postDataJSON() } catch { body = req.postData() }
    calls.push({ key, body })
    const h = routes[key]
    const reply = typeof h === 'function' ? h(req) : h ?? { status: 404, body: { message: `no fixture for ${key}` } }
    await route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body ?? {}) })
  })
  return { calls, count: (key: string) => calls.filter((c) => c.key === key).length }
}

test('sign-in shows the projects of the organization', async ({ page }) => {
  let session = false
  await mockApi(page, {
    ...signedIn(),
    'GET /me': () => (session ? { body: fx('me') } : { status: 401, body: fx('unauthorized') }),
    'POST /refresh': { status: 401, body: fx('unauthorized') },
    'POST /login': () => { session = true; return { body: fx('login') } },
  })
  await page.goto('/')
  await expect(page).toHaveURL(/\/sign-in/)
  await page.getByLabel('E-posta').fill('owner@example.test')
  await page.getByLabel('Parola').fill('correct horse battery')
  await page.getByRole('button', { name: 'Giriş yap' }).click()

  await expect(page).toHaveURL(/\/org\/acme$/)
  await expect(page.getByRole('heading', { name: 'Projeler' })).toBeVisible()
  const cards = page.getByRole('list', { name: 'Projeler' }).getByRole('listitem')
  await expect(cards).toHaveCount(3)
  await expect(cards.filter({ hasText: 'corteqs' })).toContainText('Çalışıyor')
  await expect(cards.filter({ hasText: 'staging' })).toContainText('Başlatılıyor')
  await expect(cards.filter({ hasText: 'staging' })).toContainText('sertifika bekleniyor')
  await expect(cards.filter({ hasText: 'archive' })).toContainText('Duraklatıldı')
  await expect(cards.filter({ hasText: 'corteqs' })).not.toContainText('sertifika bekleniyor')
  // organization switcher
  await expect(page.getByLabel('Organizasyon')).toHaveValue('acme')
})

test('a wrong password shows the error and stays on the sign-in screen', async ({ page }) => {
  await mockApi(page, {
    'GET /me': { status: 401, body: fx('unauthorized') },
    'POST /refresh': { status: 401, body: fx('unauthorized') },
    'POST /login': { status: 400, body: fx('login-wrong-password') },
  })
  await page.goto('/sign-in')
  await page.getByLabel('E-posta').fill('owner@example.test')
  await page.getByLabel('Parola').fill('wrong password!')
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await expect(page.getByRole('alert')).toContainText('E-posta ya da parola hatalı')
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(page.getByLabel('Parola')).toBeVisible()
})

test('create project posts organization_slug, name and size and follows the job to the project', async ({ page }) => {
  let polls = 0
  const api = await mockApi(page, {
    ...signedIn(),
    'POST /projects': { status: 201, body: fx('project-created') },
    'GET /jobs/5b7e0c3d-0000-4000-8000-0000000000f1': () => ({ body: fx(++polls < 2 ? 'job-running' : 'job-succeeded') }),
  })
  await page.goto('/org/acme')
  await page.getByRole('link', { name: 'Yeni proje' }).click()
  await expect(page).toHaveURL(/\/new\/acme$/)
  await expect(page.getByText('9632 MiB boş')).toBeVisible()
  await expect(page.getByText('Bu hafta kalan yeni adres: 1 / 3')).toBeVisible()
  await expect(page.getByRole('radio', { name: /micro.*1184 MiB/ })).toBeChecked()
  await expect(page.getByRole('radio', { name: /small.*2336 MiB/ })).toBeVisible()
  await expect(page.getByRole('radio', { name: /medium.*3872 MiB/ })).toBeVisible()

  await page.getByLabel('Proje adı').fill('demo')
  await page.getByRole('radio', { name: /small/ }).check()
  await page.getByRole('button', { name: 'Proje oluştur' }).click()
  await expect(page.getByRole('list', { name: 'Adımlar' })).toBeVisible()
  await expect(page).toHaveURL(/\/project\/demoprojectrefdddddd(\/|$)/)
  expect(api.calls.find((c) => c.key === 'POST /projects')!.body).toEqual({ organization_slug: 'acme', name: 'demo', size: 'small' })
  expect(polls).toBeGreaterThanOrEqual(2)
})

test('a refused create shows the server message unchanged', async ({ page }) => {
  const refused = fx('project-create-host-cap')
  await mockApi(page, { ...signedIn(), 'POST /projects': { status: 400, body: refused } })
  await page.goto('/new/acme')
  await page.getByLabel('Proje adı').fill('demo')
  await page.getByRole('button', { name: 'Proje oluştur' }).click()
  await expect(page.getByRole('alert')).toHaveText(refused.message)
  await expect(page).toHaveURL(/\/new\/acme$/)
})

test('a new access token is shown once and not after a reload', async ({ page }) => {
  const created = fx('access-token-created')
  const api = await mockApi(page, { ...signedIn(), 'POST /access-tokens': { status: 201, body: created } })
  await page.goto('/org/acme/tokens')
  await expect(page.getByRole('cell', { name: 'ci', exact: true })).toBeVisible()
  await page.getByLabel('Ad').fill('laptop')
  await page.getByRole('button', { name: 'Belirteç oluştur' }).click()
  await expect(page.getByText(created.token)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Kopyala' })).toBeVisible()
  expect(api.calls.find((c) => c.key === 'POST /access-tokens')!.body).toEqual({ name: 'laptop' })
  await page.reload()
  await expect(page.getByRole('cell', { name: 'ci', exact: true })).toBeVisible()
  await expect(page.getByText(created.token)).toHaveCount(0)
})

test('a read_only member sees no create, import or member actions', async ({ page }) => {
  await mockApi(page, { ...signedIn(), 'GET /me': { body: fx('me-read-only') } })
  await page.goto('/org/acme')
  await expect(page.getByRole('list', { name: 'Projeler' }).getByRole('listitem')).toHaveCount(3)
  await expect(page.getByRole('link', { name: 'Yeni proje' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'İçe aktar' })).toHaveCount(0)
  await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Üyeler' }).click()
  await expect(page.getByRole('cell', { name: 'dev@example.test' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Davet et' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: /^Rol:/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Çıkar:/ })).toHaveCount(0)
})

test('an owner can invite, change a role and remove a member', async ({ page }) => {
  const api = await mockApi(page, {
    ...signedIn(),
    'POST /organizations/acme/invitations': { status: 201, body: fx('invitation-created') },
    'PATCH /organizations/acme/members/4f1c2a9e-0000-4000-8000-000000000002': { body: {} },
    'DELETE /organizations/acme/members/4f1c2a9e-0000-4000-8000-000000000002': { body: {} },
  })
  await page.goto('/org/acme/members')
  await page.getByLabel('E-posta').fill('new@example.test')
  await page.getByRole('combobox', { name: 'Rol', exact: true }).selectOption('developer')
  await page.getByRole('button', { name: 'Davet et' }).click()
  await expect(page.getByText(fx('invitation-created').link)).toBeVisible()
  expect(api.calls.find((c) => c.key === 'POST /organizations/acme/invitations')!.body).toEqual({ email: 'new@example.test', role: 'developer' })

  await page.getByRole('combobox', { name: 'Rol: dev@example.test' }).selectOption('administrator')
  await expect.poll(() => api.count('PATCH /organizations/acme/members/4f1c2a9e-0000-4000-8000-000000000002')).toBe(1)
  await page.getByRole('button', { name: 'Çıkar: dev@example.test' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Çıkar' }).click()
  await expect.poll(() => api.count('DELETE /organizations/acme/members/4f1c2a9e-0000-4000-8000-000000000002')).toBe(1)
})

test('import shows ignored and unknown key names and the job steps', async ({ page }) => {
  const api = await mockApi(page, {
    ...signedIn(),
    'POST /projects/import': { status: 202, body: fx('import-created') },
    'GET /jobs/5b7e0c3d-0000-4000-8000-0000000000f2': { body: fx('job-running') },
  })
  await page.goto('/import/acme')
  await page.getByLabel('Proje adı').fill('legacy')
  await page.getByLabel('Yedek dizini').fill('corteqs/2026-11-21T03-15-00Z')
  await page.getByLabel('Env dosyası').setInputFiles({ name: '.env', mimeType: 'text/plain', buffer: Buffer.from('JWT_SECRET=x\n') })
  await page.getByRole('button', { name: 'İçe aktar' }).click()
  await expect(page.getByText('PANEL_ADMIN_PASSWORD_HASH')).toBeVisible()
  await expect(page.getByText('FOO', { exact: true })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Adımlar' })).toBeVisible()
  const post = api.calls.find((c) => c.key === 'POST /projects/import')!
  expect(String(post.body)).toContain('name="backup_dir"')
  expect(String(post.body)).toContain('name="env_file"')
})

test('audit log and capacity render', async ({ page }) => {
  await mockApi(page, signedIn())
  await page.goto('/org/acme/audit')
  await expect(page.getByRole('cell', { name: 'POST /platform/access-tokens' })).toBeVisible()
  await page.goto('/org/acme/capacity')
  await expect(page.getByRole('meter', { name: 'Bellek bütçesi' })).toBeVisible()
  await expect(page.getByRole('cell', { name: '2336 MiB' })).toBeVisible()
})

test('a 401 triggers one refresh, then the sign-in screen', async ({ page }) => {
  const api = await mockApi(page, {
    ...signedIn(),
    'GET /organizations/acme/audit-log': { status: 401, body: fx('unauthorized') },
    'POST /refresh': { status: 401, body: fx('unauthorized') },
  })
  await page.goto('/org/acme/audit')
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible()
  expect(api.count('POST /refresh')).toBe(1)
  expect(api.count('GET /organizations/acme/audit-log')).toBe(1)
})

test('a 401 followed by a good refresh retries the call once', async ({ page }) => {
  let first = true
  const api = await mockApi(page, {
    ...signedIn(),
    'GET /organizations/acme/audit-log': () => (first ? ((first = false), { status: 401, body: fx('unauthorized') }) : { body: fx('audit-log') }),
    'POST /refresh': { body: {} },
  })
  await page.goto('/org/acme/audit')
  await expect(page.getByRole('cell', { name: 'POST /platform/access-tokens' })).toBeVisible()
  expect(api.count('POST /refresh')).toBe(1)
  expect(api.count('GET /organizations/acme/audit-log')).toBe(2)
})

test('at 375 px nothing overflows horizontally', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await mockApi(page, { ...signedIn(), 'GET /me': () => ({ status: 401, body: fx('unauthorized') }), 'POST /refresh': { status: 401 } })
  // the page and every scrolling area inside it
  const overflow = () => page.evaluate(() =>
    Math.max(...[document.documentElement, ...document.querySelectorAll('.scroll-area, .grid-wrap')].map((el) => el.scrollWidth - el.clientWidth)))
  await page.goto('/sign-in')
  await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible()
  expect(await overflow()).toBeLessThanOrEqual(0)

  await page.unrouteAll()
  await mockApi(page, signedIn())
  for (const path of ['/org/acme', '/org/acme/members', '/org/acme/tokens', '/org/acme/audit', '/org/acme/capacity', '/new/acme', '/import/acme']) {
    await page.goto(path)
    await expect(page.locator('main h1')).toBeVisible()
    expect(await overflow(), path).toBeLessThanOrEqual(0)
  }
})

test('next is followed only when it stays on this origin', async ({ page }) => {
  let session = false
  const routes = {
    ...signedIn(),
    'GET /me': () => (session ? { body: fx('me') } : { status: 401, body: fx('unauthorized') }),
    'POST /refresh': { status: 401, body: fx('unauthorized') },
    'POST /login': () => { session = true; return { body: fx('login') } },
  }
  const signIn = async (next: string) => {
    session = false
    await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
    await page.getByLabel('E-posta').fill('owner@example.test')
    await page.getByLabel('Parola').fill('correct horse battery')
    await page.getByRole('button', { name: 'Giriş yap' }).click()
  }
  await mockApi(page, routes)
  await signIn('/\\evil.com')
  await expect(page).toHaveURL(/\/org\/acme$/)
  await expect(page.getByRole('heading', { name: 'Projeler' })).toBeVisible()
  await signIn('//evil.com/x')
  await expect(page).toHaveURL(/\/org\/acme$/)
  await signIn('/org/acme/members')
  await expect(page).toHaveURL(/\/org\/acme\/members$/)
})

test('an explicit sign-out drops next', async ({ page }) => {
  const api = await mockApi(page, { ...signedIn(), 'POST /logout': { body: {} } })
  await page.goto('/org/acme/members')
  await page.getByRole('button', { name: 'Çıkış' }).click()
  await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible()
  await expect(page).toHaveURL(/\/sign-in$/)
  expect(api.count('POST /logout')).toBe(1)
})

test('the reset screen strips the fragment and never shows its error text', async ({ page }) => {
  await mockApi(page, { 'GET /me': { status: 401, body: fx('unauthorized') }, 'POST /refresh': { status: 401, body: fx('unauthorized') } })
  await page.goto('/reset-password#error=access_denied&error_description=Call+555+to+restore+your+account')
  await expect(page.getByRole('alert')).toHaveText('Bağlantı geçersiz ya da süresi dolmuş. Yeni bir sıfırlama bağlantısı isteyin.')
  await expect(page.getByText('555')).toHaveCount(0)
  expect(await page.evaluate(() => location.hash)).toBe('')

  let bearer = ''
  await page.unrouteAll()
  await page.goto('about:blank') // a hash-only change would not remount the screen
  await mockApi(page, {
    'GET /me': { status: 401, body: fx('unauthorized') },
    'POST /refresh': { status: 401, body: fx('unauthorized') },
    'PUT /auth/v1/user': (req) => { bearer = req.headers().authorization ?? ''; return { body: {} } },
  })
  await page.goto('/reset-password#access_token=recovery-token-for-tests&type=recovery')
  await expect(page.getByRole('heading', { name: 'Yeni parola' })).toBeVisible()
  expect(await page.evaluate(() => location.hash)).toBe('')
  await page.getByLabel('Yeni parola', { exact: true }).fill('a long new password')
  await page.getByLabel('Yeni parola (tekrar)').fill('a long new password')
  await page.getByRole('button', { name: 'Parolayı kaydet' }).click()
  await expect(page.getByRole('heading', { name: 'Parola değişti' })).toBeVisible()
  expect(bearer).toBe('Bearer recovery-token-for-tests')
})
