import { SignJWT, jwtVerify } from 'jose'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { config } from './config.ts'

export type JwtClaims = {
  sub?: string
  role: 'anon' | 'authenticated' | 'service_role'
  email?: string
  aud?: string
  session_id?: string
  amr?: { method: string; timestamp: number }[]
  exp: number
  app_metadata?: object
  user_metadata?: object
}

/** Hono env for routers that use auth(): c.get('claims') */
export type AppEnv = { Variables: { claims: JwtClaims | null } }

const key = new TextEncoder().encode(config.jwtSecret)
export const ROLES: readonly string[] = ['anon', 'authenticated', 'service_role']

/** Signs claims with HS256; exp is set from expiresInSec (any exp in claims is overridden). */
export function sign(claims: Omit<JwtClaims, 'exp'> & { exp?: number }, expiresInSec: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ ...claims, iat: now, exp: now + expiresInSec }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(key)
}

/** Verifies signature, required exp and role; throws on any invalid token. */
export async function verify(token: string): Promise<JwtClaims> {
  const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], requiredClaims: ['exp'] })
  if (!ROLES.includes(payload.role as string)) throw new Error('invalid role claim')
  return payload as unknown as JwtClaims
}

/** Sets c.get('claims') from `Authorization: Bearer` or `apikey`; null when neither is sent, 401 when invalid. */
export const auth = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    const token = bearer ?? c.req.header('apikey')
    if (!token) {
      c.set('claims', null)
      return next()
    }
    try {
      c.set('claims', await verify(token))
    } catch {
      throw new HTTPException(401, {
        res: Response.json({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }, { status: 401 }),
      })
    }
    return next()
  })
