// Organizations, members, invitations and the audit log (/platform), and the organization routes of /v1.
import { Hono } from 'hono'
import type { Context } from 'hono'
import type pg from 'pg'
import { randomBytes } from 'node:crypto'
import { config } from '../config.ts'
import { pool } from '../db.ts'
import { MIN_PASSWORD } from '../core-env.ts'
import { background, findByEmail, smtpOptions } from '../core.ts'
import { ApiError } from '../errors.ts'
import { hashToken } from '../ids.ts'
import { ROLES, authorize, can } from '../authz.ts'
import type { Role } from '../authz.ts'
import { sessionUser } from '../session.ts'
import type { Env } from '../session.ts'
import { createConfirmedUser, tx } from './platform-auth.ts'
import { op } from './v1.ts'

export const platformOrgs = new Hono<Env>()
export const v1Orgs = new Hono<Env>()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVITATION_DAYS = 7

const bad = (message: string) => new ApiError(400, 'validation_failed', message)
const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`)
const body = async (c: Context): Promise<Record<string, any>> => {
  const b = await c.req.json().catch(() => null)
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {}
}
const role = (r: unknown): Role => {
  if (!ROLES.includes(r as Role)) throw bad(`role must be one of ${ROLES.join(', ')}`)
  return r as Role
}

/**
 * The organization of `:slug` when the caller has any membership in it. Unknown and foreign organizations are the
 * same 404, so a slug never reveals that an organization exists; the role check (authorize, 403) comes after.
 */
async function memberOrg(c: Context<Env>): Promise<{ id: string; slug: string; name: string }> {
  const org = (await pool.query(
    `select o.id, o.slug, o.name from control.organizations o
      where o.slug = $1 and exists (select 1 from control.memberships m where m.org_id = o.id and m.user_id = $2)`,
    [c.req.param('slug'), c.get('user').id],
  )).rows[0]
  if (!org) throw notFound('organization')
  return org
}

/**
 * Every organization the user has a membership in: `role` is the org-wide role (null when the user only has
 * project memberships), `projects` the project-scoped ones (Studio derives a project's role from both).
 */
async function orgsOf(userId: string) {
  const { rows } = await pool.query(
    `select o.id, o.slug, o.name,
       (select m.role from control.memberships m where m.org_id = o.id and m.user_id = $1 and m.project_id is null) as role,
       coalesce((select json_agg(json_build_object('ref', p.ref, 'role', m.role) order by p.ref)
                   from control.memberships m join control.projects p on p.id = m.project_id
                  where m.org_id = o.id and m.user_id = $1), '[]') as projects
     from control.organizations o
     where exists (select 1 from control.memberships m where m.org_id = o.id and m.user_id = $1)
     order by o.created_at, o.slug`,
    [userId],
  )
  return rows
}

platformOrgs.get('/me', async (c) => {
  const user = c.get('user')
  return c.json({ id: user.id, email: user.email, organizations: await orgsOf(user.id) })
})

platformOrgs.get('/organizations', async (c) => c.json(await orgsOf(c.get('user').id)))

const slugOf = (name: string) =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org'

// Only an owner of some organization (the first account, create-owner, is one) may create another: an invited
// read_only user could otherwise open an org of their own and spend the server's memory budget and host slots.
platformOrgs.post('/organizations', async (c) => {
  const owner = await pool.query(`select 1 from control.memberships where user_id = $1 and role = 'owner' and project_id is null limit 1`,
    [c.get('user').id])
  if (!owner.rowCount) throw new ApiError(403, 'forbidden', 'Only an organization owner can create an organization')
  const { name } = await body(c)
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw bad('name must be 1 to 100 characters')
  const base = slugOf(name)
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt ? `${base}-${randomBytes(4).toString('hex').slice(0, 4)}` : base
    try {
      const org = await tx(async (client) => {
        const o = (await client.query(`insert into control.organizations (slug, name) values ($1, $2) returning id, slug, name`, [slug, name.trim()])).rows[0]
        await client.query(`insert into control.memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, c.get('user').id])
        return o
      })
      c.set('audit', { orgId: org.id, target: org.slug })
      return c.json(org, 201)
    } catch (err: any) {
      if (err.code !== '23505') throw err // slug taken: try with a suffix
    }
  }
  throw new ApiError(409, 'conflict', 'could not find a free slug')
})

// ---- members ----

platformOrgs.get('/organizations/:slug/members', async (c) => {
  const org = await memberOrg(c) // any member may list
  const { rows } = await pool.query(
    `select m.id, m.user_id, u.email, m.role, p.ref as project_ref
       from control.memberships m join auth.users u on u.id = m.user_id left join control.projects p on p.id = m.project_id
      where m.org_id = $1 order by m.created_at, m.id`,
    [org.id],
  )
  return c.json(rows)
})

/**
 * The membership row a PATCH/DELETE addresses: `?membership_id=` picks it; without it the user id must name exactly
 * one row (a user can have an org-wide and project memberships), else 409. Locks the organization so two owners
 * cannot demote each other at once.
 */
async function memberRow(client: pg.PoolClient, c: Context<Env>) {
  const org = await memberOrg(c)
  const userId = c.req.param('userId')!
  const membershipId = c.req.query('membership_id')
  const callerRole = await authorize(c, 'org.members', { orgId: org.id })
  c.set('audit', { ...c.get('audit'), target: userId })
  if (!UUID_RE.test(userId) || (membershipId !== undefined && !UUID_RE.test(membershipId))) throw notFound('member')
  await client.query(`select 1 from control.organizations where id = $1 for update`, [org.id])
  const { rows } = await client.query(
    `select id, role, project_id from control.memberships where org_id = $1 and user_id = $2 and ($3::uuid is null or id = $3)`,
    [org.id, userId, membershipId ?? null],
  )
  if (!rows.length) throw notFound('member')
  if (rows.length > 1) throw new ApiError(409, 'ambiguous_membership', 'the user has several memberships: pass membership_id')
  return { org, callerRole, row: rows[0] as { id: string; role: Role; project_id: string | null } }
}

async function keepAnOwner(client: pg.PoolClient, orgId: string, row: { id: string; role: Role; project_id: string | null }) {
  if (row.role !== 'owner' || row.project_id) return
  const { rowCount } = await client.query(
    `select 1 from control.memberships where org_id = $1 and role = 'owner' and project_id is null and id <> $2`, [orgId, row.id])
  if (!rowCount) throw new ApiError(409, 'last_owner', 'the organization must keep at least one owner')
}

platformOrgs.patch('/organizations/:slug/members/:userId', async (c) => {
  const next = role((await body(c)).role)
  await tx(async (client) => {
    const { org, callerRole, row } = await memberRow(client, c)
    if ((row.role === 'owner' || next === 'owner') && !can(callerRole, 'org.owner')) throw new ApiError(403, 'forbidden', 'Forbidden')
    if (next === 'owner' && row.project_id) throw bad('owner is an organization-wide role')
    if (next !== 'owner') await keepAnOwner(client, org.id, row)
    await client.query(`update control.memberships set role = $2 where id = $1`, [row.id, next])
  })
  return c.json({})
})

platformOrgs.delete('/organizations/:slug/members/:userId', async (c) => {
  await tx(async (client) => {
    const { org, callerRole, row } = await memberRow(client, c)
    if (row.role === 'owner' && !can(callerRole, 'org.owner')) throw new ApiError(403, 'forbidden', 'Forbidden')
    await keepAnOwner(client, org.id, row)
    await client.query(`delete from control.memberships where id = $1`, [row.id])
  })
  return c.json({})
})

// ---- invitations ----

async function mailInvitation(to: string, orgName: string, link: string) {
  const nodemailer = (await import('nodemailer')).default
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`)
  await nodemailer.createTransport(smtpOptions(config.smtp)).sendMail({
    from: config.smtp.from,
    to,
    subject: `${orgName} organizasyonuna davet`,
    html: `<p><strong>${esc(orgName)}</strong> organizasyonuna davet edildiniz.</p><p><a href="${esc(link)}">Daveti kabul et</a></p>`,
  })
}

platformOrgs.post('/organizations/:slug/invitations', async (c) => {
  const org = await memberOrg(c)
  const callerRole = await authorize(c, 'org.members', { orgId: org.id })
  const b = await body(c)
  if (typeof b.email !== 'string' || !EMAIL_RE.test(b.email)) throw bad('email is not a valid address')
  const email = b.email.toLowerCase()
  c.set('audit', { ...c.get('audit'), target: email })
  const r = role(b.role)
  if (r === 'owner' && !can(callerRole, 'org.owner')) throw new ApiError(403, 'forbidden', 'Forbidden')
  let projectId: string | null = null
  if (b.project_ref !== undefined && b.project_ref !== null) {
    if (r === 'owner') throw bad('owner is an organization-wide role')
    projectId = (await pool.query(`select id from control.projects where ref = $1 and org_id = $2`, [String(b.project_ref), org.id])).rows[0]?.id
    if (!projectId) throw notFound('project')
  }
  const token = randomBytes(32).toString('base64url')
  const inv = (await pool.query(
    `insert into control.invitations (org_id, email, role, project_id, token_hash, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning id, expires_at`,
    [org.id, email, r, projectId, hashToken(token), INVITATION_DAYS],
  )).rows[0]
  const link = `${config.publicUrl}/invite/${token}`
  if (config.smtp.host) {
    background(mailInvitation(email, org.name, link))
    return c.json({ id: inv.id, expires_at: inv.expires_at }, 201)
  }
  // no SMTP: the inviter passes the link on (shown once, like an access token)
  return c.json({ id: inv.id, expires_at: inv.expires_at, link }, 201)
})

// Public (session.ts). For a new address the token is enough: it becomes a confirmed account with this password.
// For an address that already has an account the token alone is not: the caller must be signed in as that account
// (Studio session) and send no password, so a forwarded or leaked link cannot attach anyone else to it.
// Accepting does not sign in.
platformOrgs.post('/invitations/accept', async (c) => {
  const { token, password } = await body(c)
  const invalid = () => new ApiError(400, 'invalid_invitation', 'Invitation is invalid or has expired')
  if (typeof token !== 'string' || !token) throw invalid()
  const inv = (await pool.query(`select * from control.invitations where token_hash = $1 and expires_at > now()`, [hashToken(token)])).rows[0]
  if (!inv) throw invalid()
  c.set('audit', { orgId: inv.org_id, projectId: inv.project_id ?? undefined, target: inv.email })
  const existing = await findByEmail(inv.email)
  if (existing) {
    if (password !== undefined)
      throw new ApiError(400, 'account_exists', 'This address already has an account: sign in as it and accept without a password')
    const me = await sessionUser(c)
    if (!me) throw new ApiError(401, 'unauthorized', 'Sign in as the invited account to accept')
    c.set('user', me)
    if (me.email.toLowerCase() !== inv.email) throw new ApiError(403, 'forbidden', 'Signed in as another account than the one invited')
  } else if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new ApiError(422, 'weak_password', `Password should be at least ${MIN_PASSWORD} characters.`)
  }
  await tx(async (client) => {
    // single use: whoever deletes the row owns the acceptance
    if (!(await client.query(`delete from control.invitations where id = $1`, [inv.id])).rowCount) throw invalid()
    const userId = existing?.id ?? (await createConfirmedUser(inv.email, password, client)).id
    await client.query(
      `insert into control.memberships (org_id, user_id, role, project_id) values ($1, $2, $3, $4) on conflict do nothing`,
      [inv.org_id, userId, inv.role, inv.project_id],
    )
  }).catch((err) => {
    // the address got an account meanwhile: nothing was written, the invitation stays; the next try takes the other branch
    if (err.code === '23505') throw new ApiError(409, 'conflict', 'This address just got an account: try again')
    throw err
  })
  return c.json({ email: inv.email })
})

// ---- audit log ----

platformOrgs.get('/organizations/:slug/audit-log', async (c) => {
  const org = await memberOrg(c)
  await authorize(c, 'org.members', { orgId: org.id })
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
  const before = c.req.query('before')
  // the id is the cursor: unique and increasing, unlike `at`
  if (before !== undefined && !/^\d{1,18}$/.test(before)) throw bad('before must be an audit row id')
  const { rows } = await pool.query(
    `select id, at, actor, org_id, project_id, action, target, ip, details from control.audit_log
      where org_id = $1 and ($2::bigint is null or id < $2) order by id desc limit $3`,
    [org.id, before ?? null, limit],
  )
  return c.json(rows.map((r) => ({ ...r, id: Number(r.id) })))
})

// ---- /v1 (Management API) ----

const ROLE_NAMES: Record<Role, string> = { owner: 'Owner', administrator: 'Administrator', developer: 'Developer', read_only: 'Read only' }

// Supabase's organization id is its slug
op(v1Orgs, 'get', '/organizations', 'v1-list-all-organizations', async (c) =>
  c.json((await orgsOf(c.get('user').id)).map((o) => ({ id: o.slug, slug: o.slug, name: o.name }))))

// plan and release channels have no meaning here: neutral values
op(v1Orgs, 'get', '/organizations/:slug', 'v1-get-an-organization', async (c) => {
  const org = await memberOrg(c)
  return c.json({ id: org.slug, name: org.name, plan: 'free', opt_in_tags: [], allowed_release_channels: ['ga'] })
})

// one entry per user, their org-wide role first
op(v1Orgs, 'get', '/organizations/:slug/members', 'v1-list-organization-members', async (c) => {
  const org = await memberOrg(c)
  const { rows } = await pool.query(
    `select distinct on (m.user_id) m.user_id, u.email, m.role from control.memberships m join auth.users u on u.id = m.user_id
      where m.org_id = $1 order by m.user_id, m.project_id nulls first`,
    [org.id],
  )
  return c.json(rows.map((r) => ({ user_id: r.user_id, user_name: r.email, email: r.email, role_name: ROLE_NAMES[r.role as Role], mfa_enabled: false, avatar_url: null })))
})
