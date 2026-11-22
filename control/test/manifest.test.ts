import { describe, expect, test } from 'vitest'
import { ManifestError, openManifest, sealManifest } from '../src/manifest.ts'

const data = { config: { auth: { SITE_URL: 'https://app.example' } },
  secrets: { JWT_SECRET: 'manifest-jwt-secret-value-0123456789', ANON_KEY: 'manifest-anon-key-value', SMTP_PASS: 'manifest-smtp-pass' } }
const PASS = 'correct horse battery'

describe('manifest', () => {
  test('round trip, also from the decoded project.json', async () => {
    const sealed = await sealManifest(data, PASS)
    expect(await openManifest(sealed, PASS)).toEqual(data)
    expect(await openManifest(Buffer.from(sealed, 'base64').toString('utf8'), PASS)).toEqual(data)
  })

  test('config is in the clear, the secrets are not', async () => {
    const sealed = await sealManifest(data, PASS)
    const json = Buffer.from(sealed, 'base64').toString('utf8')
    expect(JSON.parse(json)).toMatchObject({ v: 1, config: data.config })
    for (const v of [...Object.values(data.secrets), PASS]) {
      expect(sealed).not.toContain(v)
      expect(json).not.toContain(v)
    }
  })

  test('a wrong passphrase throws bad_passphrase', async () => {
    const sealed = await sealManifest(data, PASS)
    await expect(openManifest(sealed, 'wrong horse battery')).rejects.toMatchObject({ code: 'bad_passphrase' })
    await expect(openManifest(sealed, 'wrong horse battery')).rejects.toBeInstanceOf(ManifestError)
  })

  test('altered clear config is refused like a wrong passphrase', async () => {
    const o = JSON.parse(Buffer.from(await sealManifest(data, PASS), 'base64').toString('utf8'))
    o.config.auth.SITE_URL = 'https://evil.example'
    await expect(openManifest(JSON.stringify(o), PASS)).rejects.toMatchObject({ code: 'bad_passphrase' })
  })

  test('a passphrase under 12 characters is refused', async () => {
    await expect(sealManifest(data, 'short')).rejects.toMatchObject({ code: 'weak_passphrase' })
  })

  test('garbage is malformed', async () => {
    await expect(openManifest('not json', PASS)).rejects.toMatchObject({ code: 'malformed' })
  })
})
