#!/usr/bin/env node
// Prints fresh JWT_SECRET, ANON_KEY and SERVICE_ROLE_KEY as .env lines. Run on your own machine
// and paste the output into .env; never commit it.
import { createHmac, randomBytes } from 'node:crypto'

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

function signHS256(payload, secret) {
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

const secret = randomBytes(48).toString('base64url') // 64 chars
const iat = Math.floor(Date.now() / 1000)
const exp = iat + 10 * 365 * 24 * 3600

console.log(`JWT_SECRET=${secret}`)
console.log(`ANON_KEY=${signHS256({ role: 'anon', iss: 'selfbase', iat, exp }, secret)}`)
console.log(`SERVICE_ROLE_KEY=${signHS256({ role: 'service_role', iss: 'selfbase', iat, exp }, secret)}`)
