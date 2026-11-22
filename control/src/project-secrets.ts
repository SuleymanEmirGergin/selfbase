// The secrets a new project is created with (spec 7.4). reuse carries values over (e.g. CorteQS's existing keys).
import { createHmac, randomBytes } from 'node:crypto'

export type ProjectSecrets = {
  POSTGRES_PASSWORD: string
  AUTHENTICATOR_PASSWORD: string
  JWT_SECRET: string
  ANON_KEY: string
  SERVICE_ROLE_KEY: string
  ADMIN_TOKEN: string
}

const password = () => randomBytes(32).toString('base64url')
const b64url = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')

function signHS256(payload: object, secret: string): string {
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

export function generateProjectSecrets(ref: string, reuse: Partial<ProjectSecrets> = {}): ProjectSecrets {
  // keys are only valid with the secret that signed them: carry over all three or none
  const carried = [reuse.JWT_SECRET, reuse.ANON_KEY, reuse.SERVICE_ROLE_KEY].filter(Boolean).length
  if (carried !== 0 && carried !== 3) throw new Error('reusing JWT_SECRET requires reusing ANON_KEY and SERVICE_ROLE_KEY, and the reverse')
  const jwtSecret = reuse.JWT_SECRET || randomBytes(48).toString('base64url')
  const iat = Math.floor(Date.now() / 1000)
  const key = (role: string) => signHS256({ role, iss: 'selfbase', ref, iat, exp: iat + 10 * 365 * 24 * 3600 }, jwtSecret)
  return {
    POSTGRES_PASSWORD: reuse.POSTGRES_PASSWORD || password(),
    AUTHENTICATOR_PASSWORD: reuse.AUTHENTICATOR_PASSWORD || password(),
    JWT_SECRET: jwtSecret,
    ANON_KEY: reuse.ANON_KEY || key('anon'),
    SERVICE_ROLE_KEY: reuse.SERVICE_ROLE_KEY || key('service_role'),
    ADMIN_TOKEN: reuse.ADMIN_TOKEN || password(),
  }
}
