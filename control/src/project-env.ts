// The environment a project's containers are created with (Task 5's template names, spec 7.2 AC-8). Config is
// stored per section in project_config under v1's env names; only the names below reach a container, so a
// config row can never set a secret, REGISTRY or anything the template does not read. REGISTRY,
// TEMPLATE_VERSION, DB_SHARED_BUFFERS, DB_MAX_CONNECTIONS and POOL_SIZE are added by the provisioner.
import { config as node } from './config.ts'
import type { Db } from './db.ts'
import { hostsOf } from './hosts.ts'
import { getSecrets, putSecret } from './secrets.ts'

export const SECRET_ENV = ['POSTGRES_PASSWORD', 'AUTHENTICATOR_PASSWORD', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'ADMIN_TOKEN'] as const
// third-party secrets, set by the operator; stored in project_secrets, empty when absent
export const THIRD_PARTY_SECRET_ENV = ['SMTP_PASS', 'GOOGLE_CLIENT_SECRET', 'AUTH_SMS_HOOK_SECRET'] as const

// non-secret config and v1's compose defaults; SITE_URL defaults to PUBLIC_URL
export const CONFIG_DEFAULTS: Record<string, string> = {
  PGRST_DB_SCHEMAS: 'public',
  PGRST_DB_MAX_ROWS: '1000',
  AUTH_REDIRECT_ALLOWLIST: '',
  AUTH_CONFIRM_EMAIL: 'true',
  AUTH_SECURE_EMAIL_CHANGE: 'true',
  AUTH_REFRESH_REUSE_INTERVAL: '10',
  AUTH_SET_PASSWORD_URL: '',
  AUTH_RATE_LIMIT_SIGN_IN: '30',
  AUTH_RATE_LIMIT_VERIFY: '30',
  AUTH_RATE_LIMIT_REFRESH: '150',
  AUTH_RATE_LIMIT_EMAIL: '30',
  AUTH_PHONE_ENABLED: 'false',
  AUTH_MIN_PASSWORD: '6',
  AUTH_OTP_EXPIRY: '3600',
  AUTH_EMAIL_INTERVAL: '60',
  AUTH_DISABLE_SIGNUP: 'false',
  SMTP_HOST: '',
  SMTP_PORT: '',
  SMTP_USER: '',
  SMTP_FROM: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
  GOOGLE_USERINFO_URL: 'https://openidconnect.googleapis.com/v1/userinfo',
  STORAGE_MAX_UPLOAD_BYTES: '52428800',
  FN_IMPORT_TIMEOUT_MS: '30000',
}

const str = (v: unknown) => (v === null || v === undefined ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** `config` is the merged project_config data (v1 env names); `hosts[0]` is the default host. */
export function buildEnv(project: { ref: string }, secrets: Record<string, string>, config: Record<string, unknown>,
  hosts: string[]): Record<string, string> {
  if (!hosts[0]) throw new Error(`project ${project.ref} has no default host`)
  // own keys only: an inherited one is no setting (see envfile.ts UNSAFE)
  const own = (k: string) => (Object.hasOwn(config, k) ? config[k] : undefined)
  const env: Record<string, string> = {}
  for (const k of SECRET_ENV) {
    if (!secrets[k]) throw new Error(`project ${project.ref} has no ${k} secret`)
    env[k] = secrets[k]
  }
  for (const k of THIRD_PARTY_SECRET_ENV) env[k] = secrets[k] ?? ''
  const publicUrl = `https://${hosts[0]}`
  for (const [k, d] of Object.entries(CONFIG_DEFAULTS)) env[k] = str(own(k)) ?? d
  env.PROJECT_REF = project.ref
  env.PUBLIC_URL = publicUrl
  env.SITE_URL = str(own('SITE_URL')) || publicUrl
  // the operator's, for every project: which private hosts core may reach is never a project's (or an import's) choice
  env.OUTBOUND_ALLOW_HOSTS = node.outboundAllowHosts.join(',')
  return env
}

/** project_config sections merged into one map (a key in two sections: the later section in name order wins). */
export async function projectConfig(db: Db, projectId: string): Promise<Record<string, unknown>> {
  const rows = (await db.query('select data from control.project_config where project_id = $1 order by section', [projectId])).rows
  // a null-prototype target: a stored "__proto__" key stays an own key here instead of becoming the prototype
  return Object.assign(Object.create(null), ...rows.map((r) => r.data))
}

/**
 * One section's change, in the caller's transaction. `patch`: keys to set (null puts one back to its default), merged
 * key by key in one upsert under the row's lock, so a concurrent change to other keys survives. `secrets`: third-party
 * secrets only, encrypted; '' removes one.
 */
export async function setConfig(db: Db, project: { id: string; ref: string }, section: string, patch: Record<string, string | null>,
  secrets: Record<string, string>, userId: string): Promise<void> {
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null))
  const unset = Object.keys(patch).filter((k) => patch[k] === null)
  await db.query(
    `insert into control.project_config (project_id, section, data, updated_by) values ($1, $2, $3, $4)
     on conflict (project_id, section) do update
       set data = (control.project_config.data - $5::text[]) || excluded.data, version = control.project_config.version + 1,
           updated_by = excluded.updated_by, updated_at = now()`,
    [project.id, section, set, userId, unset])
  for (const [name, value] of Object.entries(secrets)) {
    if (!(THIRD_PARTY_SECRET_ENV as readonly string[]).includes(name)) throw new Error(`${name} is not a third-party secret`)
    if (value) await putSecret(db, project, name, 'platform', value)
    else await db.query('delete from control.project_secrets where project_id = $1 and name = $2', [project.id, name])
  }
}

/** The env and hosts of a project as stored now. */
export async function loadProjectEnv(db: Db, project: { id: string; ref: string }) {
  const hosts = await hostsOf(db, project.id)
  return { hosts, env: buildEnv(project, await getSecrets(db, project), await projectConfig(db, project.id), hosts) }
}
