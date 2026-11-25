// A deleted project keeps its row (REMOVED), so nothing cascades: its project-scoped memberships and invitations must
// not outlive it, and none may be added while or after it is deleted.
import { readFileSync } from 'node:fs'
import { beforeAll, beforeEach, expect, test } from 'vitest'
import { app } from '../src/app.ts'
import { resetRateLimits } from '../src/core.ts'
import { pool } from '../src/db.ts'
import { ORIGIN, join, org, PASSWORD, project, resetDashboard, user, withToken } from './helpers.ts'

let acme: { id: string; slug: string }
let owner: Awaited<ReturnType<typeof user>>
let n = 0

beforeAll(async () => {
  await resetDashboard()
  acme = await org('acme')
  owner = await user('pm-owner@example.test')
  await join(acme.id, owner.id, 'owner')
})
beforeEach(() => resetRateLimits())

const invite = (ref: string) => withToken(owner.token, 'POST', '/platform/organizations/acme/invitations',
  { email: `pm-${n++}@example.test`, role: 'developer', project_ref: ref })
const accept = (token: string) => app.request('/platform/invitations/accept', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ token, password: PASSWORD }) })
const members = async (projectId: string) =>
  (await pool.query('select count(*)::int as n from control.memberships where project_id = $1', [projectId])).rows[0].n

test('an invitation to a REMOVED project is refused (404)', async () => {
  const p = await project(acme.id, { status: 'REMOVED' })
  const res = await invite(p.ref)
  expect(res.status).toBe(404)
  expect((await pool.query('select count(*)::int as n from control.invitations where project_id = $1', [p.id])).rows[0].n).toBe(0)
})

test('accepting an invitation whose project is REMOVED is refused and adds no membership', async () => {
  const p = await project(acme.id)
  const inv = await (await invite(p.ref)).json()
  await pool.query(`update control.projects set status = 'REMOVED' where id = $1`, [p.id])
  expect((await accept(inv.link.split('/invite/')[1])).status).toBe(400)
  expect(await members(p.id)).toBe(0)
})

test("an accept racing the delete's cleanup waits for it and then adds no membership", async () => {
  const p = await project(acme.id)
  const inv = await (await invite(p.ref)).json()
  // the delete's last step: it holds the project row while it removes members and invitations and sets REMOVED
  const del = await pool.connect()
  try {
    await del.query('begin')
    await del.query('select 1 from control.projects where id = $1 for update', [p.id])
    let done = false
    const racing = accept(inv.link.split('/invite/')[1]).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 300))
    expect(done).toBe(false) // the accept waits on the project row
    await del.query('delete from control.memberships where project_id = $1', [p.id])
    await del.query('delete from control.invitations where project_id = $1', [p.id])
    await del.query(`update control.projects set status = 'REMOVED' where id = $1`, [p.id])
    await del.query('commit')
    expect((await racing).status).toBe(400)
  } finally {
    del.release()
  }
  expect(await members(p.id)).toBe(0)
})

test('migration 0007 removes the members and invitations an earlier delete left behind; it runs twice', async () => {
  const p = await project(acme.id)
  const kept = await project(acme.id)
  const u = await user(`pm-left-${n++}@example.test`)
  await join(acme.id, u.id, 'developer', p.id)
  await join(acme.id, u.id, 'developer', kept.id)
  await invite(p.ref)
  await pool.query(`update control.projects set status = 'REMOVED' where id = $1`, [p.id])
  const sql = readFileSync(new URL('../migrations/0007-removed-project-members.sql', import.meta.url), 'utf8')
  await pool.query(sql)
  await pool.query(sql)
  expect(await members(p.id)).toBe(0)
  expect((await pool.query('select count(*)::int as n from control.invitations where project_id = $1', [p.id])).rows[0].n).toBe(0)
  expect(await members(kept.id)).toBe(1)
})
