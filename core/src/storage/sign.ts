import { SignJWT, jwtVerify } from 'jose'
import { config } from '../config.ts'
import { StorageError } from './paths.ts'

const key = new TextEncoder().encode(config.jwtSecret)

// No role claim, so verify() in jwt.ts rejects these as API tokens.
/** Token for GET /object/sign/<bucket>/<name>, valid for expiresIn seconds. */
export function signObjectUrl(bucket: string, name: string, expiresIn: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ url: `${bucket}/${name}` }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuedAt(now)
    .setExpirationTime(now + expiresIn).sign(key)
}

/** Throws 400 InvalidJWT unless token is an unexpired signed URL token for exactly this object. */
export async function verifyObjectUrl(token: string, bucket: string, name: string): Promise<void> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], requiredClaims: ['exp'] })
    if (payload.url === `${bucket}/${name}`) return
  } catch {
    // fall through
  }
  throw new StorageError(400, 'InvalidJWT', 'invalid or expired signature')
}
