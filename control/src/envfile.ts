// A v1 install's env file (v1's .env.example keys, or a container's env dump) read for an import (spec section 10).
// Errors and results carry key names and line numbers only, never a value.
import { CONFIG_DEFAULTS } from './project-env.ts'
import type { ProjectSecrets } from './project-secrets.ts'

export class EnvFileError extends Error {}

type ConfigSection = 'auth' | 'postgrest' | 'storage' | 'functions'

export type V1Env = { secrets: Partial<ProjectSecrets> & Record<string, string>; config: Record<string, unknown>
  ignored: string[]; unknown: string[] }

const SECRETS = new Set(['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'SMTP_PASS', 'GOOGLE_CLIENT_SECRET', 'AUTH_SMS_HOOK_SECRET'])
const CONFIG = new Set([...Object.keys(CONFIG_DEFAULTS), 'SITE_URL'])
// v1 settings that a project under the control plane gets from control (POSTGRES_PASSWORD is generated afresh), the
// migration scripts' keys, and what a container adds by itself
const IGNORED = new Set(['POSTGRES_PASSWORD', 'PUBLIC_URL', 'SUPABASE_DIR', 'PGRST_URL', 'FN_URL', 'TRUST_PROXY',
  'DOCKER_NETWORK', 'TARGET_DB_URL', 'TARGET_DB_URL_HOST', 'SUPABASE_DB_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'NOTIFY_DISPATCH_SECRET',
  'PATH', 'HOME', 'HOSTNAME', 'YARN_VERSION', 'SOURCE_COMMIT', 'DB_HOST', 'STORAGE_DIR', 'PORT', 'NODE_ENV'])
const IGNORED_PREFIX = /^(PANEL_|CORE_|BACKUP_|NODE_|COOLIFY_)/
// An import must not choose where core connects (runtime I1): every *_URL, *_HOST or *_PORT config key is stripped and
// listed as ignored, so a new outbound setting is stripped by default. Stripped today: SMTP_HOST and SMTP_PORT (core's
// mail connection), GOOGLE_TOKEN_URL and GOOGLE_USERINFO_URL (core fetches them with the client secret), and
// GOOGLE_AUTH_URL (a browser redirect, but it decides where users sign in with this project's client id). The
// operator sets these through the platform (CONFIG_DEFAULTS keeps them). Kept, because core never fetches them and
// they are the imported app's own browser redirects: SITE_URL, AUTH_SET_PASSWORD_URL and AUTH_REDIRECT_ALLOWLIST.
// Allow-lists of hosts or addresses (*_HOSTS, *_IPS: OUTBOUND_ALLOW_HOSTS, NETQUEUE_ALLOW_HOSTS, TRUSTED_PROXY_IPS)
// go the same way: which private hosts core may reach, or whose forwarded addresses it trusts, is the operator's.
const ENDPOINT = /_(URL|HOSTS?|PORT|IPS)$/
const KEPT = new Set(['SITE_URL', 'AUTH_SET_PASSWORD_URL'])
const isEndpoint = (key: string) => ENDPOINT.test(key) && !KEPT.has(key)

// JSON.parse makes these own keys; a later Object.assign or spread would turn __proto__ into the merged object's
// prototype and so into inherited config (an import setting SMTP_HOST through config.auth.__proto__)
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

/** Drops prototype and endpoint keys at every depth (arrays too), naming each dropped key in `ignored`. */
function clean(v: unknown, ignored: string[]): unknown {
  if (Array.isArray(v)) return v.map((x) => clean(x, ignored))
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.entries(v).flatMap(([k, x]) =>
    UNSAFE.has(k) || isEndpoint(k) ? (ignored.push(k), []) : [[k, clean(x, ignored)]]))
}

/** Manifest config sections without the keys an import may not set, and the names it dropped. */
export function stripImported(sections: Record<string, Record<string, unknown>>) {
  const ignored: string[] = []
  return { sections: clean(sections, ignored) as Record<string, Record<string, unknown>>, ignored }
}
const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/** The project_config section a config key belongs to. */
export const sectionOf = (key: string): ConfigSection =>
  key.startsWith('PGRST_') ? 'postgrest' : key.startsWith('STORAGE_') ? 'storage' : key.startsWith('FN_') ? 'functions' : 'auth'

/** Config keys grouped by section, as project_config rows hold them. */
export function configSections(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [k, v] of Object.entries(config)) (out[sectionOf(k)] ??= {})[k] = v
  return out
}

export function parseV1Env(text: string): V1Env {
  const out: V1Env = { secrets: {}, config: {}, ignored: [], unknown: [] }
  const seen = new Set<string>()
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '').trim()
    if (!line || line.startsWith('#')) return
    const m = LINE.exec(line)
    if (!m) throw new EnvFileError(`env file line ${i + 1} is not KEY=value, a comment or blank`)
    const [, key, rawValue] = m
    if (seen.has(key)) throw new EnvFileError(`env file line ${i + 1}: ${key} is set twice`)
    seen.add(key)
    // as compose reads env files: one pair of quotes keeps everything inside (a # too); unquoted, ` #` starts a comment
    const quoted = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(rawValue)
    const value = quoted ? quoted[2] : rawValue.replace(/\s+#.*$/, '')
    if (SECRETS.has(key)) { if (value) out.secrets[key] = value }
    else if (isEndpoint(key)) out.ignored.push(key)
    else if (CONFIG.has(key)) { if (value) out.config[key] = value }
    else if (IGNORED.has(key) || IGNORED_PREFIX.test(key)) out.ignored.push(key)
    else out.unknown.push(key)
  })
  return out
}
