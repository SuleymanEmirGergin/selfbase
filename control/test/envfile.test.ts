import { describe, expect, test } from 'vitest'
import { EnvFileError, parseV1Env, stripImported } from '../src/envfile.ts'
import { v1Env } from './helpers.ts'

describe('parseV1Env', () => {
  test("v1's .env.example with values filled has no unknown keys", () => {
    const { text, vals } = v1Env()
    const r = parseV1Env(text)
    expect(r.unknown).toEqual([])
    expect(r.secrets).toEqual({ JWT_SECRET: vals.JWT_SECRET, ANON_KEY: vals.ANON_KEY, SERVICE_ROLE_KEY: vals.SERVICE_ROLE_KEY,
      SMTP_PASS: vals.SMTP_PASS, GOOGLE_CLIENT_SECRET: vals.GOOGLE_CLIENT_SECRET, AUTH_SMS_HOOK_SECRET: vals.AUTH_SMS_HOOK_SECRET })
    expect(r.config).toMatchObject({ SITE_URL: vals.SITE_URL, AUTH_CONFIRM_EMAIL: vals.AUTH_CONFIRM_EMAIL,
      GOOGLE_CLIENT_ID: vals.GOOGLE_CLIENT_ID, STORAGE_MAX_UPLOAD_BYTES: vals.STORAGE_MAX_UPLOAD_BYTES })
    expect(r.ignored).toEqual(expect.arrayContaining(['POSTGRES_PASSWORD', 'PANEL_ADMIN_PASSWORD_HASH', 'PUBLIC_URL', 'BACKUP_DIR', 'TARGET_DB_URL']))
    // no secret and no ignored key is config
    for (const k of [...Object.keys(r.secrets), ...r.ignored]) expect(r.config).not.toHaveProperty(k)
  })

  test('a container env file: the keys a container adds are ignored, anything else is unknown', () => {
    const r = parseV1Env('PATH=/usr/bin\nHOME=/root\nNODE_VERSION=24\nCOOLIFY_FQDN=x\nPORT=8080\nFOO=bar\n')
    expect(r.ignored).toEqual(['PATH', 'HOME', 'NODE_VERSION', 'COOLIFY_FQDN', 'PORT'])
    expect(r.unknown).toEqual(['FOO'])
  })

  test('quotes, CRLF and empty values', () => {
    const r = parseV1Env('SITE_URL="https://app.example"\r\nSMTP_HOST=\r\n# c\r\nAUTH_MIN_PASSWORD=\'8\'\r\n')
    expect(r.config).toEqual({ SITE_URL: 'https://app.example', AUTH_MIN_PASSWORD: '8' })
  })

  test('an inline comment after an unquoted value is dropped; inside quotes it stays', () => {
    const r = parseV1Env('SITE_URL=https://a.example # the app\nGOOGLE_CLIENT_ID="id#1.example" # quoted\nSMTP_USER=a#b\nSMTP_FROM=\'x # y\'\n')
    expect(r.config).toEqual({ SITE_URL: 'https://a.example', GOOGLE_CLIENT_ID: 'id#1.example', SMTP_USER: 'a#b', SMTP_FROM: 'x # y' })
  })

  test('S7: keys that point core at a server are stripped and listed as ignored; browser redirects stay', () => {
    const r = parseV1Env(['GOOGLE_TOKEN_URL=http://192.0.2.1/', 'GOOGLE_USERINFO_URL=http://192.0.2.1:8080/me',
      'GOOGLE_AUTH_URL=https://login.example.test/auth', 'SMTP_HOST=192.0.2.2', 'SMTP_PORT=25', 'SMTP_USER=mailer',
      'SITE_URL=https://app.example.test', 'AUTH_SET_PASSWORD_URL=https://app.example.test/reset',
      'AUTH_REDIRECT_ALLOWLIST=https://app.example.test/**', 'GOOGLE_CLIENT_ID=client-id'].join('\n'))
    expect(r.ignored).toEqual(['GOOGLE_TOKEN_URL', 'GOOGLE_USERINFO_URL', 'GOOGLE_AUTH_URL', 'SMTP_HOST', 'SMTP_PORT'])
    expect(r.config).toEqual({ SMTP_USER: 'mailer', SITE_URL: 'https://app.example.test', AUTH_SET_PASSWORD_URL: 'https://app.example.test/reset',
      AUTH_REDIRECT_ALLOWLIST: 'https://app.example.test/**', GOOGLE_CLIENT_ID: 'client-id' })
    expect(JSON.stringify(r)).not.toMatch(/192\.0\.2/)
  })

  test('S7: stripImported drops the same keys from manifest sections', () => {
    const out = stripImported({ auth: { SITE_URL: 'https://e.example.test', SMTP_HOST: 'h', GOOGLE_TOKEN_URL: 'http://192.0.2.1/' },
      storage: { STORAGE_MAX_UPLOAD_BYTES: 1 } })
    expect(out).toEqual({ sections: { auth: { SITE_URL: 'https://e.example.test' }, storage: { STORAGE_MAX_UPLOAD_BYTES: 1 } },
      ignored: ['SMTP_HOST', 'GOOGLE_TOKEN_URL'] })
  })

  test('a duplicate key names the line, never the value', () => {
    const err = (() => { try { parseV1Env('JWT_SECRET=first-secret-value\n\nJWT_SECRET=second-secret-value\n') } catch (e) { return e } })()
    expect(err).toBeInstanceOf(EnvFileError)
    expect((err as Error).message).toMatch(/line 3/)
    expect((err as Error).message).not.toMatch(/secret-value/)
  })

  test('a line that is not KEY=value names the line, never its content', () => {
    const err = (() => { try { parseV1Env('# ok\nnot a line with hunter2\n') } catch (e) { return e } })() as Error
    expect(err).toBeInstanceOf(EnvFileError)
    expect(err.message).toMatch(/line 2/)
    expect(err.message).not.toMatch(/hunter2/)
  })
})
