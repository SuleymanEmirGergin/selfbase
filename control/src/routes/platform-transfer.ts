// Backups, export and import for Studio and scripts/import-project.mjs (spec 8.8 and section 10), mounted at /platform.
// An upload's values are encrypted into project_secrets in the request and never stored, logged or answered; the
// answers name keys only.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { config } from '../config.ts'
import { pool } from '../db.ts'
import { configSections, EnvFileError, parseV1Env, stripImported } from '../envfile.ts'
import { ApiError } from '../errors.ts'
import { checkBackupSpace, checkProjectBackup } from '../disk.ts'
import { allows, createProject, type Statuses } from '../jobs/index.ts'
import { backupDirOf } from '../jobs/transfer.ts'
import { ManifestError, MIN_PASSPHRASE, openManifest, sealManifest } from '../manifest.ts'
import { getSecrets } from '../secrets.ts'
import type { Env } from '../session.ts'
import { bad, body, lifecycle, orgFor, platformProject, projectFor, projectName, projectSize, type ProjectRow } from './platform-projects.ts'

export const platformTransfer = new Hono<Env>()

const ENV_FILE_MAX = 64 * 1024
// what an export carries and an import takes over; POSTGRES_PASSWORD and the rest are generated for the new project
const CARRIED = ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'SMTP_PASS', 'GOOGLE_CLIENT_SECRET', 'AUTH_SMS_HOOK_SECRET']
const ROTATED = ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY']
const SECTIONS = ['auth', 'postgrest', 'storage', 'realtime', 'database', 'pooler', 'functions']
const CAN_BACKUP: Statuses = { in: ['ACTIVE_HEALTHY', 'ACTIVE_UNHEALTHY'] }

// Manual backups and exports of one project: 3 an hour, each a full dump on the backup volume (runtime I2). One at a
// time is already lifecycle's rule (409 project_busy); scheduled backups (created_by null) do not count.
const MANUAL_PER_HOUR = 3
async function checkBackupRate(projectId: string): Promise<void> {
  const { n } = (await pool.query(`select count(*)::int as n from control.jobs where project_id = $1
    and type in ('project.backup', 'project.export') and created_by is not null and created_at > now() - interval '1 hour'`, [projectId])).rows[0]
  if (n >= MANUAL_PER_HOUR) {
    throw new ApiError(429, 'too_many_backups', `This project had ${MANUAL_PER_HOUR} manual backups or exports in the last hour. Try again later.`)
  }
}

const manifestError = (e: unknown) => {
  if (e instanceof ManifestError) return new ApiError(400, e.code, e.message)
  return e
}

platformTransfer.get('/projects/:ref/backups', async (c) => {
  const p = await projectFor(c, 'project.read')
  return c.json((await pool.query(
    `select id, kind, status, started_at, finished_at, size_bytes::float8 as size_bytes, location
       from control.backups where project_id = $1 order by started_at desc nulls last, id`, [p.id])).rows)
})

platformTransfer.post('/projects/:ref/backups', async (c) => {
  const p = await projectFor(c, 'project.manage')
  await checkBackupRate(p.id)
  await checkProjectBackup(pool, p)
  return c.json({ job_id: await lifecycle(c, p, 'project.backup', CAN_BACKUP) }, 202)
})

// the keys leave sealed with the caller's passphrase; only the sealed text enters the job payload
platformTransfer.post('/projects/:ref/export', async (c) => {
  const p = await projectFor(c, 'project.manage')
  const { passphrase } = await body(c)
  // the cheap refusals before scrypt (lifecycle checks the same again when it enqueues)
  if (!allows(CAN_BACKUP, p.status)) throw new ApiError(409, 'invalid_status', `this cannot be done while the project is ${p.status}`)
  if ((await pool.query(`select 1 from control.jobs where project_id = $1 and status in ('pending', 'running')`, [p.id])).rowCount) {
    throw new ApiError(409, 'project_busy', 'another operation is running on this project; try again when it ends')
  }
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new ApiError(400, 'weak_passphrase', `the passphrase must be at least ${MIN_PASSPHRASE} characters`)
  }
  await checkBackupRate(p.id)
  await checkProjectBackup(pool, p)
  const secrets = await getSecrets(pool, p)
  const rows = (await pool.query('select section, data from control.project_config where project_id = $1 order by section', [p.id])).rows
  const sealed = await sealManifest({ config: Object.fromEntries(rows.map((r) => [r.section, r.data])),
    secrets: Object.fromEntries(CARRIED.filter((k) => secrets[k]).map((k) => [k, secrets[k]])) }, passphrase).catch((e) => {
    throw manifestError(e)
  })
  const manifest = sealed.match(/.{1,2000}/g) ?? []
  return c.json({ job_id: await lifecycle(c, p, 'project.export', CAN_BACKUP, { manifest }) }, 202)
})

platformTransfer.post('/projects/import', async (c) => {
  // bodyCap (256 KiB) has already read the whole body, with or without content-length
  const form = await c.req.formData().catch(() => { throw bad('the body must be multipart/form-data') })
  const field = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string) : undefined)
  const org = await orgFor(c, field('organization_slug'), 'project.manage')
  const name = projectName(field('name'))
  const size = projectSize(field('size'))
  const dir = field('backup_dir') ?? ''
  const allowed = await backupDirOf(pool, org, dir)
  if (allowed === 'invalid') {
    throw new ApiError(400, 'invalid_backup_dir', 'backup_dir must be <ref>/<YYYYMMDD-HHMMSS> or export-<ref>/<YYYYMMDD-HHMMSS> of one of '
      + "this organization's projects, or import/<organization slug>/<name>")
  }
  // another organization's backup and one that does not exist look the same
  if (allowed === 'foreign') throw new ApiError(404, 'not_found', 'backup not found')
  const envFile = form.get('env_file')
  const passphrase = field('passphrase')
  if ((envFile !== null) === (passphrase !== undefined)) throw bad('give exactly one of env_file and passphrase')
  const rotate = field('rotate_keys') ?? 'false'
  if (rotate !== 'true' && rotate !== 'false') throw bad('rotate_keys must be true or false')

  let secrets: Record<string, string>
  let sections: Record<string, Record<string, unknown>>
  let ignored: string[] = []
  let unknown: string[] = []
  if (envFile !== null) {
    if (!(envFile instanceof File)) throw bad('env_file must be a file')
    if (envFile.size > ENV_FILE_MAX) throw new ApiError(413, 'payload_too_large', 'env_file is larger than 64 KiB')
    let env
    try {
      env = parseV1Env(await envFile.text())
    } catch (e) {
      if (e instanceof EnvFileError) throw new ApiError(400, 'invalid_env_file', e.message)
      throw e
    }
    ;({ secrets, ignored, unknown } = env)
    sections = configSections(env.config)
  } else {
    let text: string
    try {
      text = await readFile(join(config.backupDir, dir, 'project.json'), 'utf8')
    } catch {
      throw bad(`there is no project.json in ${dir}: only an export has one; give its env_file instead`)
    }
    const m = await openManifest(text, passphrase!).catch((e) => { throw manifestError(e) })
    secrets = Object.fromEntries(CARRIED.filter((k) => typeof m.secrets[k] === 'string').map((k) => [k, m.secrets[k]]))
    ;({ sections, ignored } = stripImported(Object.fromEntries(Object.entries(m.config).filter(([s, d]) => SECTIONS.includes(s)
      && d && typeof d === 'object')) as Record<string, Record<string, unknown>>))
  }
  // rotate_keys: the job generates a new JWT secret and keys, and deletes the sessions the backup brought
  if (rotate === 'true') for (const k of ROTATED) delete secrets[k]
  // a JWT secret generated here (none carried) is a rotation whatever the caller sent: the restored sessions go too
  const rotating = !secrets.JWT_SECRET
  await checkBackupSpace()
  const { project, jobId } = await createProject(pool, { orgId: org.id, name, size, pool: 'project', createdBy: c.get('user').id,
    reuseSecrets: secrets, config: sections,
    job: { type: 'project.import', status: 'RESTORING', payload: { backup_dir: dir, ...(rotating ? { rotate_keys: true } : {}) } } })
  c.set('audit', { ...c.get('audit'), projectId: project.id, target: project.ref })
  return c.json({ project: platformProject({ ...project, org_slug: org.slug, certificate: 'pending' } as ProjectRow), job_id: jobId,
    ignored, unknown }, 202)
})
