import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { SignJWT, jwtVerify } from 'jose'
import { config } from '../config.ts'
import { adminError, readBody } from './ident.ts'

// The panel session is NOT an API token: it carries {panel:true} and no role, so jwt.ts verify() rejects it,
// and the admin router checks only this cookie, never Authorization/apikey (a service_role key grants nothing here).
export type PanelEnv = { Variables: { panelEmail: string } }
export const PANEL_COOKIE = 'sb_panel'
const TTL = 12 * 3600
const MAX_FAILS = 5
const LOCK_MS = 15 * 60 * 1000
const key = () => new TextEncoder().encode(config.jwtSecret)
// compared against when the email is wrong or login is disabled, so timing reveals neither
const DUMMY_HASH = bcrypt.hashSync(randomUUID(), 10)

/** Client IP: the socket address, or the proxy-appended X-Forwarded-For entry when TRUST_PROXY=true. */
function clientIp(c: Context): string {
  if (process.env.TRUST_PROXY === 'true') {
    const xff = c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean)
    if (xff?.length) return xff[xff.length - 1]
  }
  return (c.env as any)?.incoming?.socket?.remoteAddress ?? 'unknown'
}

// shortcut: in-memory per-IP counter, correct only for a single core instance; move to the database when scaling out
const fails = new Map<string, { count: number; resetAt: number }>()
function failure(ip: string) {
  const now = Date.now()
  const f = fails.get(ip)
  const count = f && f.resetAt > now ? f.count + 1 : 1
  fails.set(ip, { count, resetAt: now + LOCK_MS })
}
const locked = (ip: string) => {
  const f = fails.get(ip)
  if (f && f.resetAt <= Date.now()) fails.delete(ip)
  return !!f && f.resetAt > Date.now() && f.count >= MAX_FAILS
}

const isLocalHttp = (c: Context) => {
  const u = new URL(c.req.url)
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
}

/** 403 for a POST/PATCH/DELETE whose Origin header is another site (the panel is same-origin). */
export const sameOrigin = createMiddleware(async (c, next) => {
  const origin = c.req.header('origin')
  if (origin && c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
    // behind a TLS-terminating proxy the request URL is http://, so PUBLIC_URL's origin is accepted too
    const allowed = [new URL(c.req.url).origin, new URL(config.publicUrl).origin]
    if (!allowed.includes(origin)) throw adminError(403, 'cross-origin request refused')
  }
  return next()
})

/** 401 unless the request carries a valid panel cookie. */
export const requirePanel = createMiddleware<PanelEnv>(async (c, next) => {
  const token = getCookie(c, PANEL_COOKIE)
  const payload = token
    ? await jwtVerify(token, key(), { algorithms: ['HS256'], requiredClaims: ['exp'] }).then((r) => r.payload, () => null)
    : null
  if (!payload || payload.panel !== true || payload.role !== undefined || typeof payload.email !== 'string')
    throw adminError(401, 'panel login required')
  c.set('panelEmail', payload.email)
  return next()
})

const router = new Hono()

router.post('/login', async (c) => {
  const ip = clientIp(c)
  if (locked(ip)) throw adminError(429, 'too many failed logins, try again later')
  const { email, password } = await readBody(c)
  const hash = config.panelAdminPasswordHash
  const emailOk = typeof email === 'string' && !!config.panelAdminEmail && email.toLowerCase() === config.panelAdminEmail.toLowerCase()
  // an empty hash disables login entirely; there is never a default password
  const pwOk = await bcrypt.compare(typeof password === 'string' ? password : '', emailOk && hash ? hash : DUMMY_HASH)
  if (!emailOk || !hash || !pwOk) {
    failure(ip)
    throw adminError(401, 'invalid login')
  }
  fails.delete(ip)
  const now = Math.floor(Date.now() / 1000)
  const token = await new SignJWT({ panel: true, email: config.panelAdminEmail, iat: now, exp: now + TTL })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(key())
  setCookie(c, PANEL_COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/admin', secure: !isLocalHttp(c), maxAge: TTL })
  return c.json({ email: config.panelAdminEmail })
})

export const panelRoutes = new Hono<PanelEnv>()

// shortcut: stateless cookie, so logout only clears it in this browser; a copied cookie stays valid until its 12 h expiry.
// Rotate JWT_SECRET to kill all panel sessions, or add a server-side session table if that is not enough.
panelRoutes.post('/logout', (c) => {
  deleteCookie(c, PANEL_COOKIE, { path: '/admin', secure: !isLocalHttp(c), httpOnly: true, sameSite: 'Strict' })
  return c.json({})
})

panelRoutes.get('/me', (c) => c.json({ email: c.get('panelEmail') }))

export default router
