#!/usr/bin/env node
// Prints fresh JWT_SECRET, ANON_KEY and SERVICE_ROLE_KEY as .env lines. Run on your own machine
// and paste the output into .env; never commit it. With --secrets, writes the control stack's secret files instead.
import { createHmac, randomBytes } from 'node:crypto'
import { chmodSync, chownSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

function signHS256(payload, secret) {
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

// --secrets <dir> [gid]: the control stack's secret files (v2; compose secrets, control/compose.yml), mode 0640 and,
// as root, group <gid> (SECRETS_GID, default 10001), which control and the provisioner run with. Nothing is printed
// and no file is overwritten. master_key also needs an offline copy: losing it loses every stored project secret.
const at = process.argv.indexOf('--secrets')
if (at !== -1) {
  const dir = process.argv[at + 1]
  const gid = Number(process.argv[at + 2] ?? 10001)
  if (!dir || !Number.isInteger(gid)) {
    console.error('usage: gen-keys.mjs --secrets <dir> [gid]')
    process.exit(1)
  }
  const files = {
    master_key: randomBytes(32).toString('base64'),
    control_db_password: randomBytes(32).toString('base64url'),
    control_jwt_secret: randomBytes(48).toString('base64url'),
    provisioner_token: randomBytes(32).toString('base64url'),
  }
  for (const name of Object.keys(files)) {
    if (existsSync(join(dir, name))) {
      console.error(`gen-keys: ${join(dir, name)} exists already; nothing written`)
      process.exit(1)
    }
  }
  for (const [name, value] of Object.entries(files)) {
    const path = join(dir, name)
    writeFileSync(path, `${value}\n`, { mode: 0o600, flag: 'wx' })
    if (process.getuid?.() === 0) chownSync(path, 0, gid)
    chmodSync(path, 0o640)
  }
  console.log(`gen-keys: wrote ${Object.keys(files).join(', ')} in ${dir}`)
  process.exit(0)
}

const secret = randomBytes(48).toString('base64url') // 64 chars
const iat = Math.floor(Date.now() / 1000)
const exp = iat + 10 * 365 * 24 * 3600

console.log(`JWT_SECRET=${secret}`)
console.log(`ANON_KEY=${signHS256({ role: 'anon', iss: 'selfbase', iat, exp }, secret)}`)
console.log(`SERVICE_ROLE_KEY=${signHS256({ role: 'service_role', iss: 'selfbase', iat, exp }, secret)}`)
