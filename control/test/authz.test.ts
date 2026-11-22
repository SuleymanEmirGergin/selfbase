import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import { pool } from '../src/db.ts'
import { resetRateLimits } from '../src/core.ts'
import { onError } from '../src/errors.ts'
import { authorize, can } from '../src/authz.ts'
import type { Action, Role } from '../src/authz.ts'
import { createConfirmedUser } from '../src/routes/platform-auth.ts'
import type { Env } from '../src/session.ts'
import { as, login, resetDashboard } from './helpers.ts'

const PASSWORD = 'correct-horse-battery'

// rows: role; columns: action. Brief Task 10.
const ACTIONS: Action[] = ['project.read', 'project.write', 'project.sql', 'project.keys', 'project.manage', 'org.members', 'org.tokens', 'org.owner']
const TABLE: Record<Role, number[]> = {
  read_only: [1, 0, 0, 0, 0, 0, 1, 0],
  developer: [1, 1, 1, 1, 0, 0, 1, 0],
  administrator: [1, 1, 1, 1, 1, 1, 1, 0],
  owner: [1, 1, 1, 1, 1, 1, 1, 1],
}

test('role x action table', () => {
  for (const [role, row] of Object.entries(TABLE) as [Role, number[]][])
    ACTIONS.forEach((action, i) => expect(can(role, action), `${role} ${action}`).toBe(row[i] === 1))
})

let orgId: string
let projA: string
let projB: string
const users: Record<string, string> = {}

async function member(email: string, role: Role, projectId: string | null = null) {
  users[email] ??= (await createConfirmedUser(email, PASSWORD)).id
  await pool.query(`insert into control.memberships (org_id, user_id, role, project_id) values ($1, $2, $3, $4)`, [orgId, users[email], role, projectId])
}

beforeAll(async () => {
  await resetDashboard()
  orgId = (await pool.query(`insert into control.organizations (slug, name) values ('acme', 'Acme') returning id`)).rows[0].id
  // fixed subnets: the tables were truncated above, so these never collide with another file's rows
  const project = async (ref: string, subnet: string) =>
    (await pool.query(`insert into control.projects (ref, org_id, name, status, size, subnet) values ($1, $2, $1, 'ACTIVE_HEALTHY', 'micro', $3) returning id`,
      [ref, orgId, subnet])).rows[0].id
  projA = await project('aaaaaaaaaaaaaaaaaaaa', '10.250.0.0/27')
  projB = await project('bbbbbbbbbbbbbbbbbbbb', '10.250.0.32/27')
  await member('owner@example.test', 'owner')
  await member('dev@example.test', 'developer', projA)
  await member('mixed@example.test', 'read_only')
  await member('mixed@example.test', 'administrator', projA)
})
beforeEach(() => resetRateLimits())

/** authorize() behind a fake signed-in user, as a route would call it */
function probe(email: string, action: Action, projectId?: string) {
  const h = new Hono<Env>().onError(onError)
  h.get('/', async (c) => {
    c.set('user', { id: users[email], email, via: 'cookie' })
    return c.json({ role: await authorize(c, action, { orgId, projectId }) })
  })
  return h.request('/')
}

describe('authorize', () => {
  test('a project-scoped developer works on its project only', async () => {
    expect(await (await probe('dev@example.test', 'project.write', projA)).json()).toEqual({ role: 'developer' })
    const other = await probe('dev@example.test', 'project.read', projB)
    expect(other.status).toBe(403)
    expect(await other.json()).toEqual({ error: 'forbidden', message: 'Forbidden' })
    // an org-level action is not granted by a project membership
    expect((await probe('dev@example.test', 'project.read')).status).toBe(403)
  })

  test('org-wide and project rows: the better one applies on that project', async () => {
    expect(await (await probe('mixed@example.test', 'project.manage', projA)).json()).toEqual({ role: 'administrator' })
    expect((await probe('mixed@example.test', 'project.write', projB)).status).toBe(403)
    expect(await (await probe('mixed@example.test', 'project.read', projB)).json()).toEqual({ role: 'read_only' })
  })

  test('a non-member is refused', async () => {
    await createConfirmedUser('stranger@example.test', PASSWORD).then((u) => (users['stranger@example.test'] = u.id))
    expect((await probe('stranger@example.test', 'project.read', projA)).status).toBe(403)
  })

  test('to a non-member an existing organization looks exactly like a missing one', async () => {
    const stranger = await login('stranger@example.test', PASSWORD)
    for (const [method, sub, body] of [['GET', '/members'], ['GET', '/audit-log'], ['POST', '/invitations', { email: 'a@example.test', role: 'developer' }],
      ['PATCH', `/members/${users['owner@example.test']}`, { role: 'developer' }]] as const) {
      const real = await as(stranger, method, `/platform/organizations/acme${sub}`, body)
      const missing = await as(stranger, method, `/platform/organizations/nosuchorg${sub}`, body)
      expect([real.status, missing.status], `${method} ${sub}`).toEqual([404, 404])
      expect(await real.json()).toEqual(await missing.json())
    }
  })
})

describe('/platform/me and members', () => {
  test('/me shows the org-wide role and per-project roles', async () => {
    const me = await (await as(await login('mixed@example.test', PASSWORD), 'GET', '/platform/me')).json()
    expect(me.organizations).toEqual([
      { id: orgId, slug: 'acme', name: 'Acme', role: 'read_only', projects: [{ ref: 'aaaaaaaaaaaaaaaaaaaa', role: 'administrator' }] },
    ])
    const dev = await (await as(await login('dev@example.test', PASSWORD), 'GET', '/platform/me')).json()
    expect(dev.organizations).toEqual([
      { id: orgId, slug: 'acme', name: 'Acme', role: null, projects: [{ ref: 'aaaaaaaaaaaaaaaaaaaa', role: 'developer' }] },
    ])
  })

  test('members list one row per membership', async () => {
    const owner = await login('owner@example.test', PASSWORD)
    const rows = await (await as(owner, 'GET', '/platform/organizations/acme/members')).json()
    expect(rows).toHaveLength(4)
    expect(rows.filter((r: any) => r.email === 'mixed@example.test').map((r: any) => [r.role, r.project_ref]).sort()).toEqual([
      ['administrator', 'aaaaaaaaaaaaaaaaaaaa'],
      ['read_only', null],
    ])
    expect(rows[0]).toEqual({ id: expect.any(String), user_id: expect.any(String), email: expect.any(String), role: expect.any(String), project_ref: null })
  })

  test('PATCH and DELETE address the membership row', async () => {
    const owner = await login('owner@example.test', PASSWORD)
    const mixed = users['mixed@example.test']
    // two rows: the user id alone is ambiguous
    const amb = await as(owner, 'PATCH', `/platform/organizations/acme/members/${mixed}`, { role: 'developer' })
    expect(amb.status).toBe(409)
    expect(await amb.json()).toMatchObject({ error: 'ambiguous_membership' })
    const rows = await (await as(owner, 'GET', '/platform/organizations/acme/members')).json()
    const scoped = rows.find((r: any) => r.user_id === mixed && r.project_ref)
    const ok = await as(owner, 'PATCH', `/platform/organizations/acme/members/${mixed}?membership_id=${scoped.id}`, { role: 'developer' })
    expect(ok.status).toBe(200)
    const after = (await pool.query(`select role, project_id from control.memberships where user_id = $1 order by project_id nulls first`, [mixed])).rows
    expect(after).toEqual([{ role: 'read_only', project_id: null }, { role: 'developer', project_id: projA }])
    expect((await as(owner, 'DELETE', `/platform/organizations/acme/members/${mixed}?membership_id=${scoped.id}`)).status).toBe(200)
    // one row left: the user id alone addresses it
    expect((await as(owner, 'PATCH', `/platform/organizations/acme/members/${mixed}`, { role: 'developer' })).status).toBe(200)
  })

  test('a developer cannot manage members', async () => {
    const dev = await login('dev@example.test', PASSWORD)
    const res = await as(dev, 'PATCH', `/platform/organizations/acme/members/${users['mixed@example.test']}`, { role: 'administrator' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden', message: 'Forbidden' })
  })

  test('the last owner cannot be removed or demoted: 409', async () => {
    const owner = await login('owner@example.test', PASSWORD)
    const id = users['owner@example.test']
    const demote = await as(owner, 'PATCH', `/platform/organizations/acme/members/${id}`, { role: 'administrator' })
    expect(demote.status).toBe(409)
    expect(await demote.json()).toEqual({ error: 'last_owner', message: expect.any(String) })
    expect((await as(owner, 'DELETE', `/platform/organizations/acme/members/${id}`)).status).toBe(409)
    // with a second owner it works
    await member('owner2@example.test', 'owner')
    expect((await as(owner, 'PATCH', `/platform/organizations/acme/members/${id}`, { role: 'administrator' })).status).toBe(200)
  })

  test('an administrator cannot make or touch owners', async () => {
    const admin = await login('owner@example.test', PASSWORD) // demoted to administrator above
    const res = await as(admin, 'PATCH', `/platform/organizations/acme/members/${users['mixed@example.test']}`, { role: 'owner' })
    expect(res.status).toBe(403)
    const inv = await as(admin, 'POST', '/platform/organizations/acme/invitations', { email: 'x@example.test', role: 'owner' })
    expect(inv.status).toBe(403)
  })

  test('a project-scoped invitation becomes a project membership', async () => {
    const owner2 = await login('owner2@example.test', PASSWORD)
    const bad = await as(owner2, 'POST', '/platform/organizations/acme/invitations', { email: 'p@example.test', role: 'developer', project_ref: 'zzzzzzzzzzzzzzzzzzzz' })
    expect(bad.status).toBe(404)
    const res = await as(owner2, 'POST', '/platform/organizations/acme/invitations', { email: 'p@example.test', role: 'developer', project_ref: 'bbbbbbbbbbbbbbbbbbbb' })
    expect(res.status).toBe(201)
    const token = (await res.json()).link.split('/invite/')[1]
    const acc = await as('', 'POST', '/platform/invitations/accept', { token, password: PASSWORD })
    expect(acc.status).toBe(200)
    const rows = (await pool.query(`select m.role, m.project_id from control.memberships m join auth.users u on u.id = m.user_id where u.email = 'p@example.test'`)).rows
    expect(rows).toEqual([{ role: 'developer', project_id: projB }])
  })
})

describe('organizations', () => {
  test('create derives a slug and makes the creator owner', async () => {
    const dev = await login('dev@example.test', PASSWORD)
    const res = await as(dev, 'POST', '/platform/organizations', { name: 'Beta Lab!' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: expect.any(String), slug: 'beta-lab', name: 'Beta Lab!' })
    const again = await (await as(dev, 'POST', '/platform/organizations', { name: 'Beta Lab' })).json()
    expect(again.slug).toMatch(/^beta-lab-[a-z0-9]{4}$/)
    const list = await (await as(dev, 'GET', '/platform/organizations')).json()
    expect(list.map((o: any) => [o.slug, o.role]).sort()).toEqual([['acme', null], ['beta-lab', 'owner'], [again.slug, 'owner']])
  })
})
