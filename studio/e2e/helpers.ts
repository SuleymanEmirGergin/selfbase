import { readFileSync } from 'node:fs'
import type { Page, Request } from '@playwright/test'

// Shared by the v3 specs (ux, screens): /platform fixtures for an owner, organization and project screens together.
export const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

type Reply = { status?: number; body?: unknown; delay?: number }
type Handler = Reply | ((req: Request) => Reply)
export type Routes = Record<string, Handler>

export const REF = 'corteqsprojectrefaaa'
export const PAUSED = 'archiveprojectrefccc'
const P = `/projects/${REF}`
const A = `${P}/admin`

export const NOTES = [
  { id: 1, note: 'merhaba studio' },
  { id: 2, note: 'ilk sürüm yayında' },
  { id: 3, note: 'yedekler her gece 03:00' },
]

export function routes(): Routes {
  const rows = NOTES.map((r) => ({ ...r }))
  return {
    'GET /me': { body: fx('me') },
    'GET /projects': { body: fx('projects') },
    'GET /capacity': { body: fx('capacity') },
    'GET /organizations/acme/members': { body: fx('members') },
    'GET /access-tokens': { body: fx('access-tokens') },
    'GET /organizations/acme/audit-log': { body: fx('audit-log') },
    [`GET ${P}`]: { body: fx('project-detail') },
    [`GET /projects/${PAUSED}`]: { body: fx('project-paused') },
    [`GET ${P}/api-keys`]: { body: fx('project-api-keys') },
    [`GET ${P}/logs`]: { body: fx('project-logs') },
    [`GET ${P}/domains`]: { body: fx('project-domains') },
    [`GET ${P}/backups`]: { body: fx('project-backups') },
    [`GET /jobs/${fx('project-job').job_id}`]: { body: fx('job-succeeded') },
    [`GET ${A}/schemas`]: { body: fx('project-schemas') },
    [`GET ${A}/tables`]: { body: fx('project-tables').map((t: object) => ({ ...t, row_estimate: rows.length })) },
    [`GET ${A}/rows/public/notes`]: () => ({ body: { rows, total: rows.length } }),
    [`DELETE ${A}/rows/public/notes`]: (req) => {
      const i = rows.findIndex((r) => r.id === req.postDataJSON().pk.id)
      return i < 0 ? { status: 404, body: { message: 'yok' } } : { body: rows.splice(i, 1)[0] }
    },
    [`POST ${A}/sql`]: { body: fx('project-sql-select1') },
    [`GET ${A}/policies`]: { body: [] },
    [`GET ${A}/users`]: { body: fx('project-users') },
    [`GET ${A}/buckets`]: { body: fx('project-buckets') },
    [`GET ${A}/files/media`]: { body: [] },
  }
}

export async function mockApi(page: Page, r: Routes) {
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
    if (reply.delay) await new Promise((res) => setTimeout(res, reply.delay))
    await route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body ?? {}) })
  })
  return { calls, count: (key: string) => calls.filter((c) => c.key === key).length }
}
