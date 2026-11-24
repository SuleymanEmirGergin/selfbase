import { describe, expect, test } from 'vitest'
import { config as node, loadConfig } from '../src/config.ts'
import { buildEnv } from '../src/project-env.ts'

const secrets = { POSTGRES_PASSWORD: 'pg', AUTHENTICATOR_PASSWORD: 'auth', JWT_SECRET: 'jwt', ANON_KEY: 'anon',
  SERVICE_ROLE_KEY: 'srk', ADMIN_TOKEN: 'adm', SMTP_PASS: 'smtp-pass', NOT_AN_ENV_SECRET: 'x' }
const config = { SITE_URL: 'https://app.example.com', AUTH_REDIRECT_ALLOWLIST: 'https://app.example.com/**', PGRST_DB_MAX_ROWS: 500,
  AUTH_CONFIRM_EMAIL: false, SMTP_HOST: 'smtp.example.com', SMTP_PORT: 587, STORAGE_MAX_UPLOAD_BYTES: 1048576,
  // a config row cannot set a secret or anything the template does not read
  POSTGRES_PASSWORD: 'from-config', SMTP_PASS: 'from-config', REGISTRY: 'evil.example.com', UNKNOWN: 'u' }

const FIXTURE = {
  POSTGRES_PASSWORD: 'pg', AUTHENTICATOR_PASSWORD: 'auth', JWT_SECRET: 'jwt', ANON_KEY: 'anon', SERVICE_ROLE_KEY: 'srk', ADMIN_TOKEN: 'adm',
  SMTP_PASS: 'smtp-pass', GOOGLE_CLIENT_SECRET: '', AUTH_SMS_HOOK_SECRET: '',
  PROJECT_REF: 'abcdefghijklmnopqrst', PUBLIC_URL: 'https://abcdefghijklmnopqrst.example.test', SITE_URL: 'https://app.example.com',
  PGRST_DB_SCHEMAS: 'public', PGRST_DB_MAX_ROWS: '500',
  AUTH_REDIRECT_ALLOWLIST: 'https://app.example.com/**', AUTH_CONFIRM_EMAIL: 'false', AUTH_SECURE_EMAIL_CHANGE: 'true',
  AUTH_REFRESH_REUSE_INTERVAL: '10', AUTH_SET_PASSWORD_URL: '', AUTH_RATE_LIMIT_SIGN_IN: '30', AUTH_RATE_LIMIT_VERIFY: '30',
  AUTH_RATE_LIMIT_REFRESH: '150', AUTH_RATE_LIMIT_EMAIL: '30', AUTH_PHONE_ENABLED: 'false', AUTH_MIN_PASSWORD: '6',
  AUTH_OTP_EXPIRY: '3600', AUTH_EMAIL_INTERVAL: '60', AUTH_DISABLE_SIGNUP: 'false',
  SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: '', SMTP_FROM: '',
  GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth', GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
  GOOGLE_USERINFO_URL: 'https://openidconnect.googleapis.com/v1/userinfo',
  STORAGE_MAX_UPLOAD_BYTES: '1048576', FN_IMPORT_TIMEOUT_MS: '30000', OUTBOUND_ALLOW_HOSTS: '',
}

test('the env equals the fixture for a given config, with no undefined values', () => {
  const env = buildEnv({ ref: 'abcdefghijklmnopqrst' }, secrets, config, ['abcdefghijklmnopqrst.example.test', 'api.example.com'])
  expect(env).toEqual(FIXTURE)
  for (const [k, v] of Object.entries(env)) expect(typeof v, k).toBe('string')
})

test('SITE_URL defaults to the public URL; a missing platform secret or host throws naming it, not a value', () => {
  expect(buildEnv({ ref: 'r' }, secrets, {}, ['h.example.test']).SITE_URL).toBe('https://h.example.test')
  expect(() => buildEnv({ ref: 'r' }, { ...secrets, ANON_KEY: '' }, {}, ['h'])).toThrow(/ANON_KEY/)
  expect(() => buildEnv({ ref: 'r' }, secrets, {}, [])).toThrow(/host/)
})

describe('I3: OUTBOUND_ALLOW_HOSTS comes from the operator, never from a project', () => {
  const base = { SELFBASE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), CONTROL_DB_PASSWORD: 'db', CONTROL_JWT_SECRET: 'p'.repeat(40),
    PROVISIONER_TOKEN: 't'.repeat(40), BASE_DOMAIN: 'example.test', TEMPLATE_VERSION: '2.0.0' }

  test("control's OUTBOUND_ALLOW_HOSTS is read as names or addresses, lowercased; anything else stops startup", () => {
    expect(loadConfig(base).outboundAllowHosts).toEqual([])
    expect(loadConfig({ ...base, OUTBOUND_ALLOW_HOSTS: ' Relay.Mail.example.test, mailrelay ,192.0.2.10,[2001:db8::1]' }).outboundAllowHosts)
      .toEqual(['relay.mail.example.test', 'mailrelay', '192.0.2.10', '2001:db8::1'])
    for (const bad of ['http://relay.example.test', 'relay.example.test:25', 'a b', '10.0.0.0/8', '*.example.test']) {
      expect(() => loadConfig({ ...base, OUTBOUND_ALLOW_HOSTS: bad }), bad)
        .toThrow('config: OUTBOUND_ALLOW_HOSTS must be a comma-separated list of hostnames or IP addresses')
    }
  })

  test('every project gets it; a project_config row cannot set it or any other allow-list', () => {
    const saved = node.outboundAllowHosts
    node.outboundAllowHosts = ['relay.example.test', '192.0.2.10']
    try {
      const env = buildEnv({ ref: 'r' }, secrets, { OUTBOUND_ALLOW_HOSTS: '10.0.0.0', NETQUEUE_ALLOW_HOSTS: '10.0.0.1',
        TRUSTED_PROXY_IPS: '10.0.0.2' }, ['h.example.test'])
      expect(env.OUTBOUND_ALLOW_HOSTS).toBe('relay.example.test,192.0.2.10')
      expect(env).not.toHaveProperty('NETQUEUE_ALLOW_HOSTS')
      expect(env).not.toHaveProperty('TRUSTED_PROXY_IPS')
    } finally {
      node.outboundAllowHosts = saved
    }
  })
})
