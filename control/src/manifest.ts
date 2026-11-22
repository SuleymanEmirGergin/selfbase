// project.json of an export (spec section 10): a project's config in the clear and its secrets sealed with a
// passphrase the operator chooses (scrypt N=2^15, r=8, p=1 → AES-256-GCM; the clear config is the AAD, so it cannot
// be altered either). The passphrase is never stored. Errors never carry a value.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'

export const MIN_PASSPHRASE = 12

export class ManifestError extends Error {
  code: 'bad_passphrase' | 'weak_passphrase' | 'malformed'
  constructor(code: ManifestError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export type ManifestData = { config: Record<string, unknown>; secrets: Record<string, string> }

const key = (passphrase: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) =>
  // 128 * N * r = 32 MiB, Node's default maxmem; twice that leaves room
  scrypt(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))))

/** base64 of the JSON {v:1, salt, nonce, ciphertext, config}; ciphertext has the 16-byte GCM tag appended. */
export async function sealManifest(data: ManifestData, passphrase: string): Promise<string> {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new ManifestError('weak_passphrase', `the passphrase must be at least ${MIN_PASSPHRASE} characters`)
  }
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', await key(passphrase, salt), nonce)
  cipher.setAAD(Buffer.from(JSON.stringify(data.config)))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data.secrets), 'utf8'), cipher.final(), cipher.getAuthTag()])
  const b64 = (b: Buffer) => b.toString('base64')
  return Buffer.from(JSON.stringify({ v: 1, salt: b64(salt), nonce: b64(nonce), ciphertext: b64(ciphertext), config: data.config }))
    .toString('base64')
}

/** Opens sealManifest's text, or the JSON it encodes (project.json as the backup job wrote it). */
export async function openManifest(text: string, passphrase: string): Promise<ManifestData> {
  const malformed = () => new ManifestError('malformed', 'project.json is not a selfbase export manifest')
  const t = text.trim()
  let m: any
  try {
    m = JSON.parse(t.startsWith('{') ? t : Buffer.from(t, 'base64').toString('utf8'))
  } catch {
    throw malformed()
  }
  if (m?.v !== 1 || ![m.salt, m.nonce, m.ciphertext].every((x) => typeof x === 'string') || !m.config || typeof m.config !== 'object') {
    throw malformed()
  }
  const [salt, nonce, ciphertext] = [m.salt, m.nonce, m.ciphertext].map((x: string) => Buffer.from(x, 'base64'))
  if (nonce.length !== 12 || ciphertext.length < 16) throw malformed()
  try {
    const decipher = createDecipheriv('aes-256-gcm', await key(passphrase, salt), nonce)
    decipher.setAAD(Buffer.from(JSON.stringify(m.config)))
    decipher.setAuthTag(ciphertext.subarray(-16))
    const secrets = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8'))
    return { config: m.config, secrets }
  } catch {
    throw new ManifestError('bad_passphrase', 'the passphrase does not open this project.json (or the file was altered)')
  }
}
