import { describe, expect, test } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { hashToken, newAccessToken, newRef, REF_RE } from '../src/ids.ts'
import { generateProjectSecrets } from '../src/project-secrets.ts'
import { projectCapMb } from '../src/sizes.ts'

describe('ids', () => {
  test('1000 refs match ^[a-z]{20}$ and are distinct', () => {
    const refs = Array.from({ length: 1000 }, newRef)
    for (const r of refs) expect(r).toMatch(/^[a-z]{20}$/)
    expect(new Set(refs).size).toBe(1000)
    expect(REF_RE.source).toBe('^[a-z]{20}$')
  })

  test('an access token is sbp_ + 40 hex; its hash is the sha256 hex', () => {
    const { token, hash } = newAccessToken()
    expect(token).toMatch(/^sbp_[0-9a-f]{40}$/)
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(hashToken(token)).toBe(hash)
    expect(newAccessToken().token).not.toBe(token)
  })
})

describe('generateProjectSecrets', () => {
  const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
  const verifies = (jwt: string, secret: string) => {
    const [h, p, s] = jwt.split('.')
    return createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url') === s
  }

  test('fresh secrets: random passwords and keys signed with the JWT secret', () => {
    const ref = newRef()
    const s = generateProjectSecrets(ref)
    expect(Object.keys(s).sort()).toEqual(['ADMIN_TOKEN', 'ANON_KEY', 'AUTHENTICATOR_PASSWORD', 'JWT_SECRET', 'POSTGRES_PASSWORD', 'SERVICE_ROLE_KEY'])
    for (const k of ['POSTGRES_PASSWORD', 'AUTHENTICATOR_PASSWORD', 'ADMIN_TOKEN'] as const) {
      expect(Buffer.from(s[k], 'base64url').length).toBe(32)
    }
    expect(s.JWT_SECRET.length).toBeGreaterThanOrEqual(32)
    for (const [k, role] of [['ANON_KEY', 'anon'], ['SERVICE_ROLE_KEY', 'service_role']] as const) {
      expect(verifies(s[k], s.JWT_SECRET)).toBe(true)
      const c = claims(s[k])
      expect(c).toMatchObject({ role, iss: 'selfbase', ref })
      expect(c.exp - c.iat).toBeGreaterThanOrEqual(10 * 365 * 24 * 3600)
    }
    expect(generateProjectSecrets(ref).POSTGRES_PASSWORD).not.toBe(s.POSTGRES_PASSWORD)
  })

  test('reused values are kept', () => {
    const old = generateProjectSecrets(newRef())
    const s = generateProjectSecrets(newRef(), { JWT_SECRET: old.JWT_SECRET, ANON_KEY: old.ANON_KEY, SERVICE_ROLE_KEY: old.SERVICE_ROLE_KEY, POSTGRES_PASSWORD: 'kept' })
    expect(s).toMatchObject({ JWT_SECRET: old.JWT_SECRET, ANON_KEY: old.ANON_KEY, SERVICE_ROLE_KEY: old.SERVICE_ROLE_KEY, POSTGRES_PASSWORD: 'kept' })
    expect(s.ADMIN_TOKEN).not.toBe(old.ADMIN_TOKEN)
  })

  test('a reused JWT secret without its keys (or keys without it) throws', () => {
    const old = generateProjectSecrets(newRef())
    expect(() => generateProjectSecrets(newRef(), { JWT_SECRET: old.JWT_SECRET })).toThrow()
    expect(() => generateProjectSecrets(newRef(), { JWT_SECRET: old.JWT_SECRET, ANON_KEY: old.ANON_KEY })).toThrow()
    expect(() => generateProjectSecrets(newRef(), { ANON_KEY: old.ANON_KEY, SERVICE_ROLE_KEY: old.SERVICE_ROLE_KEY })).toThrow()
  })
})

describe('projectCapMb', () => {
  const sizes = {
    micro: { db: { mem_mb: 512 }, rest: { mem_mb: 128 }, core: { mem_mb: 256 }, fn: { mem_mb: 256 }, pooler: { mem_mb: 32 } },
  }
  test('sums the services of a size', () => expect(projectCapMb('micro', sizes)).toBe(1184))
  test('an unknown size throws', () => expect(() => projectCapMb('huge', sizes)).toThrow(/huge/))
})
