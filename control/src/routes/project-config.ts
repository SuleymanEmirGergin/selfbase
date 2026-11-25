// A project's auth settings on /v1 and /platform (wave 2 Task 13's field table, D-7). Stored in project_config under
// v1's env names and in project_secrets; a PATCH commits with one coalesced project.apply that recreates core, and
// answers once both are stored (the job runs after). Secrets are write-only: never answered, logged or audited (the
// audit row names body keys only).
import { isIP } from 'node:net'
import { HOSTNAME_RE } from '../config.ts'
import { pool } from '../db.ts'
import { ApiError } from '../errors.ts'
import { hostsOf } from '../hosts.ts'
import { CONFIG_DEFAULTS, projectConfig, setConfig } from '../project-env.ts'
import { applyCore, bad, body, projectFor, type ProjectRow } from './platform-projects.ts'
import { both } from './shared.ts'

type Field = { env: string; type: 'bool' | 'int' | 'string'; invert?: boolean; min?: number; max?: number; check?: (v: string) => boolean
  what?: string }
const int = (env: string, min: number, max: number): Field => ({ env, type: 'int', min, max })
// the response schema's pattern for smtp_admin_email
const EMAIL_RE = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/
const httpUrl = (v: string) => {
  try {
    return !v.includes(',') && ['http:', 'https:'].includes(new URL(v).protocol)
  } catch {
    return false
  }
}
// the ranges are the schema's narrowed to what core's config.ts accepts: a value core refuses would stop it starting
const FIELDS: Record<string, Field> = {
  site_url: { env: 'SITE_URL', type: 'string', check: httpUrl, what: 'an http or https URL' },
  uri_allow_list: { env: 'AUTH_REDIRECT_ALLOWLIST', type: 'string' },
  disable_signup: { env: 'AUTH_DISABLE_SIGNUP', type: 'bool' },
  mailer_autoconfirm: { env: 'AUTH_CONFIRM_EMAIL', type: 'bool', invert: true },
  mailer_secure_email_change_enabled: { env: 'AUTH_SECURE_EMAIL_CHANGE', type: 'bool' },
  password_min_length: int('AUTH_MIN_PASSWORD', 6, 32767),
  mailer_otp_exp: int('AUTH_OTP_EXPIRY', 1, 2147483647),
  smtp_max_frequency: int('AUTH_EMAIL_INTERVAL', 1, 32767),
  security_refresh_token_reuse_interval: int('AUTH_REFRESH_REUSE_INTERVAL', 0, 2147483647),
  smtp_host: { env: 'SMTP_HOST', type: 'string', check: (v) => HOSTNAME_RE.test(v) || isIP(v) !== 0, what: 'a lowercase hostname or an IP address' },
  smtp_port: { env: 'SMTP_PORT', type: 'string', check: (v) => /^\d{1,5}$/.test(v) && +v >= 1 && +v <= 65535, what: 'a port from 1 to 65535, as a string' },
  smtp_user: { env: 'SMTP_USER', type: 'string' },
  smtp_admin_email: { env: 'SMTP_FROM', type: 'string', check: (v) => EMAIL_RE.test(v), what: 'an email address' },
  external_google_client_id: { env: 'GOOGLE_CLIENT_ID', type: 'string' },
  external_phone_enabled: { env: 'AUTH_PHONE_ENABLED', type: 'bool' },
}
const SECRETS: Record<string, string> = { smtp_pass: 'SMTP_PASS', external_google_secret: 'GOOGLE_CLIENT_SECRET' }
// derived on GET; a PATCH may name them (below)
const DERIVED = ['refresh_token_rotation_enabled', 'external_google_enabled']
const MAX_LENGTH = 4096
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/

// The rest of v1-get-auth-service-config's response schema: null, or a neutral value where the schema has no null
const NEUTRAL = { passkey_enabled: false, mfa_phone_otp_length: 0, sms_otp_length: 0, oauth_server_enabled: false,
  oauth_server_allow_dynamic_registration: false, custom_oauth_enabled: false, custom_oauth_max_providers: 0 }
const NULLS = Object.fromEntries((
  'api_max_request_duration db_max_pool_size db_max_pool_size_unit external_anonymous_users_enabled ' +
  'external_apple_additional_client_ids external_apple_client_id external_apple_email_optional ' +
  'external_apple_enabled external_apple_secret external_azure_client_id external_azure_email_optional ' +
  'external_azure_enabled external_azure_secret external_azure_url external_bitbucket_client_id ' +
  'external_bitbucket_email_optional external_bitbucket_enabled external_bitbucket_secret ' +
  'external_discord_client_id external_discord_email_optional external_discord_enabled external_discord_secret ' +
  'external_email_enabled external_facebook_client_id external_facebook_email_optional external_facebook_enabled ' +
  'external_facebook_secret external_figma_client_id external_figma_email_optional external_figma_enabled ' +
  'external_figma_secret external_github_client_id external_github_email_optional external_github_enabled ' +
  'external_github_secret external_gitlab_client_id external_gitlab_email_optional external_gitlab_enabled ' +
  'external_gitlab_secret external_gitlab_url external_google_additional_client_ids ' +
  'external_google_email_optional external_google_skip_nonce_check external_kakao_client_id ' +
  'external_kakao_email_optional external_kakao_enabled external_kakao_secret external_keycloak_client_id ' +
  'external_keycloak_email_optional external_keycloak_enabled external_keycloak_secret external_keycloak_url ' +
  'external_linkedin_oidc_client_id external_linkedin_oidc_email_optional external_linkedin_oidc_enabled ' +
  'external_linkedin_oidc_secret external_slack_oidc_client_id external_slack_oidc_email_optional ' +
  'external_slack_oidc_enabled external_slack_oidc_secret external_notion_client_id ' +
  'external_notion_email_optional external_notion_enabled external_notion_secret external_slack_client_id ' +
  'external_slack_email_optional external_slack_enabled external_slack_secret external_spotify_client_id ' +
  'external_spotify_email_optional external_spotify_enabled external_spotify_secret external_twitch_client_id ' +
  'external_twitch_email_optional external_twitch_enabled external_twitch_secret external_twitter_client_id ' +
  'external_twitter_email_optional external_twitter_enabled external_twitter_secret external_x_client_id ' +
  'external_x_email_optional external_x_enabled external_x_secret external_workos_client_id ' +
  'external_workos_enabled external_workos_secret external_workos_url external_web3_solana_enabled ' +
  'external_web3_ethereum_enabled external_zoom_client_id external_zoom_email_optional external_zoom_enabled ' +
  'external_zoom_secret hook_custom_access_token_enabled hook_custom_access_token_uri ' +
  'hook_custom_access_token_secrets hook_mfa_verification_attempt_enabled hook_mfa_verification_attempt_uri ' +
  'hook_mfa_verification_attempt_secrets hook_password_verification_attempt_enabled ' +
  'hook_password_verification_attempt_uri hook_password_verification_attempt_secrets hook_send_sms_enabled ' +
  'hook_send_sms_uri hook_send_sms_secrets hook_send_email_enabled hook_send_email_uri hook_send_email_secrets ' +
  'hook_before_user_created_enabled hook_before_user_created_uri hook_before_user_created_secrets ' +
  'hook_after_user_created_enabled hook_after_user_created_uri hook_after_user_created_secrets jwt_exp ' +
  'mailer_allow_unverified_email_sign_ins mailer_otp_length mailer_subjects_confirmation ' +
  'mailer_subjects_email_change mailer_subjects_invite mailer_subjects_magic_link ' +
  'mailer_subjects_reauthentication mailer_subjects_recovery mailer_subjects_password_changed_notification ' +
  'mailer_subjects_email_changed_notification mailer_subjects_phone_changed_notification ' +
  'mailer_subjects_mfa_factor_enrolled_notification mailer_subjects_mfa_factor_unenrolled_notification ' +
  'mailer_subjects_identity_linked_notification mailer_subjects_identity_unlinked_notification ' +
  'mailer_templates_confirmation_content mailer_templates_email_change_content mailer_templates_invite_content ' +
  'mailer_templates_magic_link_content mailer_templates_reauthentication_content ' +
  'mailer_templates_recovery_content mailer_templates_password_changed_notification_content ' +
  'mailer_templates_email_changed_notification_content mailer_templates_phone_changed_notification_content ' +
  'mailer_templates_mfa_factor_enrolled_notification_content ' +
  'mailer_templates_mfa_factor_unenrolled_notification_content ' +
  'mailer_templates_identity_linked_notification_content mailer_templates_identity_unlinked_notification_content ' +
  'mailer_notifications_password_changed_enabled mailer_notifications_email_changed_enabled ' +
  'mailer_notifications_phone_changed_enabled mailer_notifications_mfa_factor_enrolled_enabled ' +
  'mailer_notifications_mfa_factor_unenrolled_enabled mailer_notifications_identity_linked_enabled ' +
  'mailer_notifications_identity_unlinked_enabled mfa_max_enrolled_factors mfa_totp_enroll_enabled ' +
  'mfa_totp_verify_enabled mfa_phone_enroll_enabled mfa_phone_verify_enabled mfa_web_authn_enroll_enabled ' +
  'mfa_web_authn_verify_enabled webauthn_rp_display_name webauthn_rp_id webauthn_rp_origins mfa_phone_template ' +
  'mfa_phone_max_frequency nimbus_oauth_client_id nimbus_oauth_email_optional nimbus_oauth_client_secret ' +
  'password_hibp_enabled password_required_characters rate_limit_anonymous_users rate_limit_email_sent ' +
  'rate_limit_sms_sent rate_limit_token_refresh rate_limit_verify rate_limit_otp rate_limit_web3 saml_enabled ' +
  'saml_external_url saml_allow_encrypted_assertions security_sb_forwarded_for_enabled ' +
  'external_email_magic_link_disabled security_captcha_enabled security_captcha_provider security_captcha_secret ' +
  'security_manual_linking_enabled security_update_password_require_current_password ' +
  'security_update_password_require_reauthentication sessions_inactivity_timeout sessions_single_per_user ' +
  'sessions_tags sessions_timebox sms_autoconfirm sms_max_frequency sms_messagebird_access_key ' +
  'sms_messagebird_originator sms_otp_exp sms_provider sms_template sms_test_otp sms_test_otp_valid_until ' +
  'sms_textlocal_api_key sms_textlocal_sender sms_twilio_account_sid sms_twilio_auth_token sms_twilio_content_sid ' +
  'sms_twilio_message_service_sid sms_twilio_verify_account_sid sms_twilio_verify_auth_token ' +
  'sms_twilio_verify_message_service_sid sms_vonage_api_key sms_vonage_api_secret sms_vonage_from ' +
  'smtp_sender_name oauth_server_authorization_path').split(' ').map((k) => [k, null]))

/** The stored settings in the response schema's shape; secrets are null. */
async function authConfig(p: ProjectRow) {
  const [cfg, hosts] = await Promise.all([projectConfig(pool, p.id), hostsOf(pool, p.id)])
  // as buildEnv: a stored value, else the default ('' counts as unset for booleans and numbers, as core reads them)
  const raw = (env: string) => (cfg[env] === undefined || cfg[env] === null ? CONFIG_DEFAULTS[env] ?? '' : String(cfg[env]))
  const out: Record<string, unknown> = { ...NULLS, ...NEUTRAL }
  for (const [name, f] of Object.entries(FIELDS)) {
    const v = raw(f.env) || (f.type === 'string' ? '' : CONFIG_DEFAULTS[f.env])
    out[name] = f.type === 'bool' ? (v === 'true') !== !!f.invert : f.type === 'int' ? (/^\d+$/.test(v) ? Number(v) : null) : v
  }
  out.site_url = raw('SITE_URL') || `https://${hosts[0]}`
  return { ...out, smtp_pass: null, external_google_secret: null, refresh_token_rotation_enabled: true,
    external_google_enabled: !!raw('GOOGLE_CLIENT_ID') }
}

/** The env form of one PATCH value; the error names the field, never the value. */
function envValue(name: string, f: Field, v: unknown): string {
  if (f.type === 'bool') {
    if (typeof v !== 'boolean') throw bad(`${name} must be true or false`)
    return String(v !== !!f.invert)
  }
  if (f.type === 'int') {
    if (!Number.isInteger(v) || (v as number) < f.min! || (v as number) > f.max!) throw bad(`${name} must be a whole number from ${f.min} to ${f.max}`)
    return String(v)
  }
  const s = text(name, v)
  if (s && f.check && !f.check(s)) throw bad(`${name} must be ${f.what}`)
  return s
}
function text(name: string, v: unknown): string {
  if (typeof v !== 'string' || v.length > MAX_LENGTH || CONTROL_CHAR.test(v))
    throw bad(`${name} must be a string of at most ${MAX_LENGTH} characters without control characters`)
  return v
}
const noGoogleId = () => bad('external_google_enabled needs external_google_client_id')

const PATH = '/projects/:ref/config/auth'

both('get', PATH, 'v1-get-auth-service-config', async (c) => c.json(await authConfig(await projectFor(c, 'project.read'))))

both('patch', PATH, 'v1-update-auth-service-config', async (c) => {
  const p = await projectFor(c, 'project.manage')
  const b = await body(c)
  // own keys only: FIELDS['constructor'] and the like are inherited, never a field
  const unknown = Object.keys(b).find((k) => !Object.hasOwn(FIELDS, k) && !Object.hasOwn(SECRETS, k) && !DERIVED.includes(k))
  if (unknown) throw new ApiError(400, 'not_supported', `${unknown} is not supported here`)
  if (b.refresh_token_rotation_enabled !== undefined && b.refresh_token_rotation_enabled !== true)
    throw new ApiError(400, 'not_supported', 'refresh_token_rotation_enabled: refresh tokens always rotate here')
  const patch: Record<string, string | null> = {}
  const secrets: Record<string, string> = {}
  for (const [name, v] of Object.entries(b)) {
    if (Object.hasOwn(SECRETS, name)) secrets[SECRETS[name]] = v === null ? '' : text(name, v)
    else if (Object.hasOwn(FIELDS, name)) patch[FIELDS[name].env] = v === null ? null : envValue(name, FIELDS[name], v)
  }
  // enabled means a client id is stored: false forgets it, true needs one
  const google = b.external_google_enabled
  if (google !== undefined && typeof google !== 'boolean') throw bad('external_google_enabled must be true or false')
  const givenId = 'GOOGLE_CLIENT_ID' in patch
  if (google === false) {
    if (patch.GOOGLE_CLIENT_ID) throw bad('external_google_enabled is false while external_google_client_id is set')
    patch.GOOGLE_CLIENT_ID = null
  }
  if (google === true && givenId && !patch.GOOGLE_CLIENT_ID) throw noGoogleId()
  if (Object.keys(b).length) {
    await applyCore(c, p, async (tx) => {
      // a delete purges secrets and config step by step: nothing may be written back behind it. Under the enqueue lock,
      // so no delete is enqueued between this check and the commit
      const busy = (await tx.query(`select status = 'REMOVED' or exists (select 1 from control.jobs where project_id = p.id
          and type = 'project.delete' and status in ('pending', 'running')) as busy
        from control.projects p where id = $1 for update`, [p.id])).rows[0]?.busy ?? true
      if (busy) throw new ApiError(409, 'project_busy', 'this project is being deleted')
      const stored: Record<string, unknown> = (await tx.query(`select data from control.project_config
        where project_id = $1 and section = 'auth' for update`, [p.id])).rows[0]?.data ?? {}
      if (google === true && !givenId && !stored.GOOGLE_CLIENT_ID) throw noGoogleId()
      // core sends SMTP_PASS to SMTP_HOST as SMTP_USER: a new host or user must not inherit the stored password
      // (the body sets a new one or clears it)
      const moved = ['SMTP_HOST', 'SMTP_USER'].some((k) => k in patch && patch[k] && patch[k] !== (stored[k] ?? ''))
      if (moved && !('SMTP_PASS' in secrets)
        && (await tx.query(`select 1 from control.project_secrets where project_id = $1 and name = 'SMTP_PASS'`, [p.id])).rowCount)
        throw new ApiError(400, 'smtp_pass_required', 'smtp_pass is required when smtp_host or smtp_user changes')
      await setConfig(tx, p, 'auth', patch, secrets, c.get('user').id)
    })
  }
  return c.json(await authConfig(p))
})
