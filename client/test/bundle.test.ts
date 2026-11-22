import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const files = ['dist/selfbase.mjs', 'dist/selfbase.deno.mjs', 'dist/selfbase.d.ts']
const read = (f: string) => readFileSync(f, 'utf8')

describe('built bundles', () => {
  it.each(files)('%s imports nothing from @supabase/* and never names supabase.co', (f) => {
    const src = read(f)
    expect(src).not.toMatch(/from\s*["']@supabase\//)
    expect(src).not.toMatch(/import\(\s*["']@supabase\//)
    expect(src).not.toMatch(/require\(\s*["']@supabase\//)
    expect(src).not.toContain('supabase.co')
  })

  it.each(['dist/selfbase.mjs', 'dist/selfbase.deno.mjs'])('%s is self-contained (no imports at all, no Node globals)', (f) => {
    const src = read(f)
    expect(src).not.toMatch(/(^|[;\s}])import\s*[{*\w"']/m)
    expect(src).not.toMatch(/\brequire\(/)
    expect(src).not.toMatch(/\bprocess\.|\bBuffer\./)
  })

  it.each(['../dist/selfbase.mjs', '../dist/selfbase.deno.mjs'])('%s loads without window/localStorage and exposes the supabase-js surface', async (f) => {
    const mod = await import(f)
    expect(mod.SELFBASE).toBe(true)
    const sb = mod.createClient('http://127.0.0.1:1', 'k', { auth: { persistSession: false, autoRefreshToken: false } })
    expect(typeof sb.from).toBe('function')
    expect(typeof sb.auth.getSession).toBe('function')
    expect((await sb.auth.getSession()).data.session).toBeNull()
    for (const name of ['SupabaseClient', 'AuthError', 'FunctionsHttpError', 'PostgrestError', 'RealtimeChannel']) expect(mod[name]).toBeTypeOf('function')
  })
})
