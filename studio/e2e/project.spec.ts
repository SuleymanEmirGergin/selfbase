import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page, Request } from '@playwright/test'

// Project screens against /platform fixtures (shapes of plan Tasks 13 and 14). Every call is intercepted.
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }
type Handler = Reply | ((req: Request) => Reply)
type Routes = Record<string, Handler>

const REF = 'corteqsprojectrefaaa'
const PAUSED = 'archiveprojectrefccc'
const P = `/projects/${REF}`
const A = `${P}/admin`
const JOB = fx('project-job').job_id

const withRole = (role: string) => {
  const me = fx('me')
  me.organizations[0].role = role
  return me
}

/** An owner on an active project; admin routes keep a little state so the v1 flows can see their own writes. */
function routes(): Routes {
  const rows: unknown[] = []
  const policies: unknown[] = []
  const files: unknown[] = []
  return {
    'GET /me': { body: fx('me') },
    'GET /projects': { body: fx('projects') },
    [`GET ${P}`]: { body: fx('project-detail') },
    [`GET /projects/${PAUSED}`]: { body: fx('project-paused') },
    [`GET ${P}/api-keys`]: { body: fx('project-api-keys') },
    [`POST ${P}/api-keys/reveal`]: { body: fx('project-api-key-revealed') },
    [`GET ${P}/logs`]: { body: fx('project-logs') },
    [`GET ${P}/domains`]: { body: fx('project-domains') },
    [`GET ${P}/backups`]: { body: fx('project-backups') },
    [`DELETE ${P}`]: { status: 202, body: fx('project-job') },
    [`POST /projects/${PAUSED}/restore`]: { status: 202, body: fx('project-job') },
    [`GET /jobs/${JOB}`]: { body: fx('job-succeeded') },
    [`GET ${A}/schemas`]: { body: fx('project-schemas') },
    [`GET ${A}/tables`]: { body: fx('project-tables') },
    [`GET ${A}/rows/public/notes`]: () => ({ body: { rows, total: rows.length } }),
    [`POST ${A}/rows/public/notes`]: () => { rows.push(fx('project-row-inserted')); return { body: fx('project-row-inserted') } },
    [`POST ${A}/sql`]: { body: fx('project-sql-select1') },
    [`GET ${A}/policies`]: () => ({ body: policies }),
    [`POST ${A}/policies`]: () => { policies.push(fx('project-policy-created')); return { body: {} } },
    [`GET ${A}/users`]: { body: fx('project-users') },
    [`GET ${A}/buckets`]: { body: fx('project-buckets') },
    [`GET ${A}/files/media`]: () => ({ body: files }),
    [`POST ${A}/files/media/hello.txt`]: () => { files.push(fx('project-file-uploaded')); return { body: {} } },
  }
}

async function mockApi(page: Page, r: Routes) {
  const calls: { key: string; url: URL; body: unknown }[] = []
  await page.route('**/platform/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const key = `${req.method()} ${url.pathname.replace(/^\/platform/, '')}`
    let body: unknown = null
    try { body = req.postDataJSON() } catch { body = req.postData() }
    calls.push({ key, url, body })
    const h = r[key]
    const reply = typeof h === 'function' ? h(req) : h ?? { status: 404, body: { message: `no fixture for ${key}` } }
    await route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', headers: reply.headers, body: JSON.stringify(reply.body ?? {}) })
  })
  return { calls, count: (key: string) => calls.filter((c) => c.key === key).length }
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name, exact: true }).click()

/** Horizontal overflow of the page and of every scrolling area inside it. */
const overflow = (page: Page) => page.evaluate(() =>
  Math.max(...[document.documentElement, ...document.querySelectorAll('.scroll-area, .grid-wrap')].map((el) => el.scrollWidth - el.clientWidth)))

test('v1 smoke flow on the platform admin routes: row, select 1, policy, users, file', async ({ page }) => {
  const api = await mockApi(page, routes())
  await page.goto(`/project/${REF}/editor`)

  await test.step('tables: insert a row and see it', async () => {
    await page.getByRole('complementary', { name: 'Tablolar' }).getByRole('button', { name: 'notes' }).click()
    await expect(page.getByText('Bu tablo boş.')).toBeVisible()
    await page.getByRole('button', { name: 'Satır ekle' }).click()
    await page.getByRole('dialog', { name: 'Satır ekle' }).getByLabel('note').fill('merhaba studio')
    await page.getByRole('button', { name: 'Kaydet' }).click()
    await expect(page.getByRole('cell', { name: 'merhaba studio' })).toBeVisible()
    expect(api.calls.find((c) => c.key === `POST ${A}/rows/public/notes`)!.body).toEqual({ values: { note: 'merhaba studio' } })
  })

  await test.step('sql: select 1 with Ctrl+Enter in CodeMirror', async () => {
    await nav(page, 'SQL')
    await expect(page).toHaveURL(new RegExp(`/project/${REF}/sql$`))
    const editor = page.getByRole('textbox', { name: 'SQL sorgusu' })
    await editor.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('select 1 as one')
    await page.keyboard.press('Control+Enter')
    await expect(page.getByRole('columnheader', { name: 'one' })).toBeVisible()
    await expect(page.getByRole('cell', { name: '1', exact: true })).toBeVisible()
    expect(api.calls.find((c) => c.key === `POST ${A}/sql`)!.body).toEqual({ query: 'select 1 as one' })
  })

  await test.step('rls: add a policy and see it', async () => {
    await nav(page, 'RLS')
    const card = page.getByRole('article', { name: 'notes' })
    await card.getByRole('button', { name: 'Policy ekle' }).click()
    const drawer = page.getByRole('dialog', { name: 'Policy ekle' })
    await drawer.getByLabel('Ad').fill('read all')
    await drawer.getByLabel('Komut').selectOption('SELECT')
    await drawer.getByLabel('Roller').fill('anon')
    await drawer.getByLabel('USING').fill('true')
    await drawer.getByRole('button', { name: 'Kaydet' }).click()
    await expect(card.getByText('read all')).toBeVisible()
  })

  await test.step('users: the list opens', async () => {
    await nav(page, 'Kullanıcılar')
    await expect(page.getByText('ada@example.test')).toBeVisible()
  })

  await test.step('files: upload and see it', async () => {
    await nav(page, 'Dosyalar')
    await page.getByLabel('Yüklenecek dosyalar').setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect(page.getByRole('cell', { name: 'hello.txt', exact: true })).toBeVisible()
  })

  // nothing went to a module-level or v1 path
  expect(api.calls.every((c) => c.url.pathname.startsWith('/platform/'))).toBe(true)
})

test('home shows the masked service key and the full one after göster', async ({ page }) => {
  const api = await mockApi(page, routes())
  await page.goto(`/project/${REF}`)
  await expect(page.getByRole('heading', { name: 'Ana sayfa' })).toBeVisible()
  await expect(page.getByText('https://corteqsprojectrefaaa.example.test')).toBeVisible()
  await expect(page.getByText('https://selfbase-corteqs.example.test')).toBeVisible()
  await expect(page.getByLabel('anon anahtarı')).toHaveText(fx('project-api-keys')[0].api_key)
  const service = page.getByLabel('service_role anahtarı')
  await expect(service).toHaveText(fx('project-api-keys')[1].api_key)
  await expect(page.getByRole('cell', { name: '412 / 1024 MiB' })).toBeVisible()
  await expect(page.getByText('project.backup')).toBeVisible()
  await page.getByRole('button', { name: 'göster' }).click()
  await expect(service).toHaveText(fx('project-api-key-revealed').api_key)
  expect(api.calls.find((c) => c.key === `POST ${P}/api-keys/reveal`)!.body).toEqual({ name: 'service_role' })
})

test('logs render, and the fallback notice appears only with the container source header', async ({ page }) => {
  const r = routes()
  let container = false
  r[`GET ${P}/logs`] = () => ({ body: fx('project-logs'), headers: container ? { 'x-selfbase-log-source': 'container' } : undefined })
  const api = await mockApi(page, r)
  await page.goto(`/project/${REF}/logs`)
  await expect(page.getByText('POST /admin/sql 200 12ms')).toBeVisible()
  await expect(page.getByText(/Günlük deposuna ulaşılamadı/)).toHaveCount(0)
  const first = api.calls.find((c) => c.key === `GET ${P}/logs`)!.url
  expect([first.searchParams.get('service'), first.searchParams.get('limit')]).toEqual(['core', '200'])

  container = true
  await page.getByLabel('Servis').selectOption('db')
  await expect(page.getByText(/Günlük deposuna ulaşılamadı/)).toBeVisible()
  expect(api.calls.filter((c) => c.key === `GET ${P}/logs`).at(-1)!.url.searchParams.get('service')).toBe('db')
  await page.getByRole('button', { name: 'Yenile' }).click()
  await expect.poll(() => api.count(`GET ${P}/logs`)).toBe(3)
})

test('settings: delete stays disabled until the project name is typed', async ({ page }) => {
  const api = await mockApi(page, routes())
  await page.goto(`/project/${REF}/settings`)
  await expect(page.getByRole('button', { name: 'güncelle' })).toBeVisible()
  await expect(page.getByText('selfbase-corteqs.example.test')).toBeVisible()
  await expect(page.getByRole('button', { name: 'şimdi yedekle' })).toBeVisible()
  const del = page.getByRole('button', { name: 'Projeyi sil' })
  await expect(del).toBeDisabled()
  await page.getByLabel('Proje adı').fill('corteq')
  await expect(del).toBeDisabled()
  await page.getByLabel('Proje adı').fill('corteqs')
  await expect(del).toBeEnabled()
  await del.click()
  await expect(page).toHaveURL(/\/org\/acme$/)
  expect(api.calls.find((c) => c.key === `DELETE ${P}`)!.body).toEqual({ confirm_name: 'corteqs' })
})

test('a paused project shows Devam ettir and no editor', async ({ page }) => {
  const api = await mockApi(page, routes())
  await page.goto(`/project/${PAUSED}/editor`)
  await expect(page.getByRole('heading', { name: 'Proje duraklatıldı' })).toBeVisible()
  const menu = page.getByRole('navigation', { name: 'Ana menü' })
  await expect(menu.getByRole('link', { name: 'Tablolar' })).toHaveCount(0)
  await expect(menu.getByRole('link', { name: 'SQL', exact: true })).toHaveCount(0)
  await expect(menu.getByRole('link', { name: 'Ayarlar' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Tablolar' })).toHaveCount(0)
  expect(api.calls.some((c) => c.key.includes('/admin/'))).toBe(false)
  await page.getByRole('button', { name: 'Devam ettir' }).click()
  await expect.poll(() => api.count(`POST /projects/${PAUSED}/restore`)).toBe(1)
  await expect(page.getByRole('list', { name: 'Adımlar' })).toBeVisible()
})

test('a developer sees SQL; a read_only member sees neither SQL nor write or key controls', async ({ page }) => {
  const r = routes()
  r['GET /me'] = { body: withRole('developer') }
  await mockApi(page, r)
  await page.goto(`/project/${REF}/home`)
  const menu = page.getByRole('navigation', { name: 'Ana menü' })
  await expect(menu.getByRole('link', { name: 'SQL', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'göster' })).toBeVisible()

  await page.unrouteAll()
  r['GET /me'] = { body: withRole('read_only') }
  await mockApi(page, r)
  await page.goto(`/project/${REF}/home`)
  await expect(menu.getByRole('link', { name: 'Tablolar' })).toBeVisible()
  await expect(menu.getByRole('link', { name: 'SQL', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'göster' })).toHaveCount(0)
  await page.goto(`/project/${REF}/sql`)
  await expect(page.getByText('Bu ekran için yetkiniz yok.')).toBeVisible()
  await page.goto(`/project/${REF}/editor`)
  await page.getByRole('complementary', { name: 'Tablolar' }).getByRole('button', { name: 'notes' }).click()
  await expect(page.getByText('Bu tablo boş.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Satır ekle' })).toHaveCount(0)
  await page.goto(`/project/${REF}/settings`)
  await expect(page.getByRole('heading', { name: 'Alan adları' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Projeyi sil' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'şimdi yedekle' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'güncelle' })).toHaveCount(0)
})

test('an unknown role renders the project area without crashing and grants nothing', async ({ page }) => {
  const r = routes()
  r['GET /me'] = { body: withRole('billing_only') }
  await mockApi(page, r)
  await page.goto(`/project/${REF}/home`)
  await expect(page.getByRole('heading', { name: 'Ana sayfa' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'SQL', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'göster' })).toHaveCount(0)
})

test('a project-scoped developer (no org-wide role) sees the write controls of that project', async ({ page }) => {
  const r = routes()
  r['GET /me'] = { body: fx('me-project-developer') }
  await mockApi(page, r)
  await page.goto(`/project/${REF}/home`)
  const menu = page.getByRole('navigation', { name: 'Ana menü' })
  await expect(menu.getByRole('link', { name: 'SQL', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'göster' })).toBeVisible()
  await page.goto(`/project/${REF}/editor`)
  await page.getByRole('complementary', { name: 'Tablolar' }).getByRole('button', { name: 'notes' }).click()
  await expect(page.getByRole('button', { name: 'Satır ekle' })).toBeVisible()
})

test('a project in transition gets no data screens and shows its status', async ({ page }) => {
  const r = routes()
  r[`GET ${P}`] = { body: { ...fx('project-detail'), status: 'COMING_UP' } }
  const api = await mockApi(page, r)
  await page.goto(`/project/${REF}/editor`)
  await expect(page.getByRole('heading', { name: 'Proje şu an kullanılamıyor' })).toBeVisible()
  await expect(page.locator('.card.paused').getByText('Başlatılıyor')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Tablolar' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Duraklat' })).toHaveCount(0)
  expect(api.calls.some((c) => c.key.includes('/admin/'))).toBe(false)
})

test('a failed restore offers Devam ettir with a Turkish status; an unhealthy project keeps SQL', async ({ page }) => {
  const r = routes()
  r[`GET /projects/${PAUSED}`] = { body: { ...fx('project-paused'), status: 'RESTORE_FAILED' } }
  r[`GET ${P}`] = { body: { ...fx('project-detail'), status: 'ACTIVE_UNHEALTHY', urls: { api: null, legacy: [] } } }
  const api = await mockApi(page, r)
  await page.goto(`/project/${PAUSED}/home`)
  await expect(page.getByText('Devam ettirilemedi').first()).toBeVisible()
  await page.getByRole('button', { name: 'Devam ettir' }).click()
  await expect.poll(() => api.count(`POST /projects/${PAUSED}/restore`)).toBe(1)
  await page.goto(`/project/${REF}/home`)
  await expect(page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'SQL', exact: true })).toBeVisible()
  await expect(page.getByRole('term').filter({ hasText: 'API adresi' })).toBeVisible()
})

test('a failed SQL chunk shows a reload hint and keeps the app', async ({ page }) => {
  await mockApi(page, routes())
  await page.route('**/src/project/Sql.tsx*', (route) => route.abort())
  await page.goto(`/project/${REF}/sql`)
  await expect(page.getByRole('button', { name: 'Sayfayı yenileyin' })).toBeVisible()
  await nav(page, 'Ana sayfa')
  await expect(page.getByRole('heading', { name: 'Ana sayfa' })).toBeVisible()
})

test('sign-out clears the SQL memory, so the next user does not see the last query or rows', async ({ page }) => {
  let session = true
  const r = routes()
  r['GET /me'] = () => (session ? { body: fx('me') } : { status: 401, body: fx('unauthorized') })
  r['POST /refresh'] = { status: 401, body: fx('unauthorized') }
  r['POST /logout'] = () => { session = false; return { body: {} } }
  r['POST /login'] = () => { session = true; return { body: fx('login') } }
  await mockApi(page, r)
  await page.goto(`/project/${REF}/sql`)
  await page.getByRole('textbox', { name: 'SQL sorgusu' }).click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('select secret_column')
  await page.keyboard.press('Control+Enter')
  await expect(page.getByRole('columnheader', { name: 'one' })).toBeVisible()

  await page.getByRole('button', { name: 'Çıkış' }).click()
  await page.getByLabel('E-posta').fill('other@example.test')
  await page.getByLabel('Parola').fill('correct horse battery')
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  // in-app navigation only: a reload would clear module memory by itself
  await page.getByRole('link', { name: /corteqs/ }).click()
  await nav(page, 'SQL')
  await expect(page.getByRole('textbox', { name: 'SQL sorgusu' })).toHaveText('select now();')
  await expect(page.getByRole('columnheader', { name: 'one' })).toHaveCount(0)
})

test('a 401 sign-out also clears the SQL memory', async ({ page }) => {
  let session = true
  const r = routes()
  r['GET /me'] = () => (session ? { body: fx('me') } : { status: 401, body: fx('unauthorized') })
  r['POST /refresh'] = { status: 401, body: fx('unauthorized') }
  r['POST /login'] = () => { session = true; return { body: fx('login') } }
  const users = r[`GET ${A}/users`]
  r[`GET ${A}/users`] = (req) => (session ? (typeof users === 'function' ? users(req) : users) : { status: 401, body: fx('unauthorized') })
  const api = await mockApi(page, r)
  await page.goto(`/project/${REF}/sql`)
  await page.getByRole('textbox', { name: 'SQL sorgusu' }).click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('select secret_column')
  await page.keyboard.press('Control+Enter')
  await expect(page.getByRole('columnheader', { name: 'one' })).toBeVisible()

  session = false // the session expires; the next call gets a 401 and the refresh fails too
  await nav(page, 'Kullanıcılar')
  await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible()
  expect(api.count('POST /refresh')).toBeGreaterThanOrEqual(1)
  await page.getByLabel('E-posta').fill('other@example.test')
  await page.getByLabel('Parola').fill('correct horse battery')
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  // `next` brings the user back in-app (no reload, so module memory would survive if it were not cleared)
  await expect(page.getByText('ada@example.test')).toBeVisible()
  await nav(page, 'SQL')
  await expect(page.getByRole('textbox', { name: 'SQL sorgusu' })).toHaveText('select now();')
  await expect(page.getByRole('columnheader', { name: 'one' })).toHaveCount(0)
})

test('settings: a custom domain is checked and confirmed; backup status is in Turkish', async ({ page }) => {
  const r = routes()
  r[`POST ${P}/domains`] = { status: 202, body: fx('project-job') }
  const api = await mockApi(page, r)
  await page.goto(`/project/${REF}/settings`)
  await expect(page.getByRole('cell', { name: 'tamamlandı' })).toBeVisible()

  const host = page.getByLabel('Alan adı', { exact: true })
  await host.fill('not a host')
  await page.getByRole('button', { name: 'Ekle', exact: true }).click()
  await expect(page.getByText('Geçerli bir alan adı yazın')).toBeVisible()
  await host.fill('API.Example.com')
  await expect(page.getByText('Geçerli bir alan adı yazın')).toHaveCount(0) // editing clears the error
  await page.getByRole('button', { name: 'Ekle', exact: true }).click()
  const dialog = page.locator('dialog.confirm')
  await expect(dialog).toContainText('sertifika')
  await expect(dialog).toContainText('haftalık yeni sertifika hakkından')
  await dialog.getByRole('button', { name: 'Vazgeç' }).click()
  expect(api.count(`POST ${P}/domains`)).toBe(0)
  await page.getByRole('button', { name: 'Ekle', exact: true }).click()
  await dialog.getByRole('button', { name: 'Ekle' }).click()
  await expect.poll(() => api.count(`POST ${P}/domains`)).toBe(1)
  expect(api.calls.find((c) => c.key === `POST ${P}/domains`)!.body).toEqual({ hostname: 'api.example.com', kind: 'custom' })
})

test('at 375 px no project screen overflows horizontally', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await mockApi(page, routes())
  for (const sub of ['home', 'editor', 'sql', 'auth/users', 'storage', 'policies', 'logs', 'settings']) {
    await page.goto(`/project/${REF}/${sub}`)
    await expect(page.locator('main.content')).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(await overflow(page), sub).toBeLessThanOrEqual(0)
  }
  await page.goto(`/project/${PAUSED}/editor`)
  await expect(page.getByRole('button', { name: 'Devam ettir' })).toBeVisible()
  expect(await overflow(page), 'paused').toBeLessThanOrEqual(0)
})

// STUDIO_SCREENS=1 npx playwright test project -g screenshots  → docs/screens/v2/*.png
test('screenshots of home, logs and settings', async ({ page }) => {
  test.skip(!process.env.STUDIO_SCREENS, 'set STUDIO_SCREENS=1 to refresh docs/screens/v2')
  const r = routes()
  r[`GET ${P}/logs`] = { body: fx('project-logs'), headers: { 'x-selfbase-log-source': 'container' } }
  await mockApi(page, r)
  for (const [sub, file, ready, height] of [
    ['home', 'project-home', '412 / 1024 MiB', 960], ['logs', 'project-logs', 'POST /admin/sql 200 12ms', 600], ['settings', 'project-settings', 'Projeyi sil', 1480],
  ] as const) {
    await page.setViewportSize({ width: 1440, height }) // the content scrolls inside the shell, so the viewport sets what is captured
    await page.goto(`/project/${REF}/${sub}`)
    await expect(page.getByText(ready).first()).toBeVisible()
    await page.screenshot({ path: fileURLToPath(new URL(`../../docs/screens/v2/${file}.png`, import.meta.url)), fullPage: true })
  }
})
