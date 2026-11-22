import { describe, it, expect } from 'vitest'
import { decodeHash } from '../src/config.ts'

const hash = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'

describe('decodeHash', () => {
  it('passes a plain hash and empty values through', () => {
    expect(decodeHash(hash)).toBe(hash)
    expect(decodeHash('')).toBe('')
    expect(decodeHash(undefined)).toBe('')
  })
  it('decodes the b64: form to the exact hash', () => {
    expect(decodeHash('b64:' + Buffer.from(hash).toString('base64'))).toBe(hash)
  })
})
