// tsc --noEmit against dist/selfbase.d.ts and corteqsemir's generated Database type (read in place, never modified).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The app repository (corteqsemir) checkout; unset, this file is skipped with a message saying so.
const appDir = process.env.CORTEQS_DIR ?? ''
const appTypes = appDir && join(appDir, 'src/integrations/supabase/types.ts')
if (!appDir) console.warn('types.test.ts skipped: set CORTEQS_DIR to the app repository checkout to run it')
else if (!existsSync(appTypes)) throw new Error(`CORTEQS_DIR is set but ${appTypes} does not exist`)

const check = `
import { createClient, type Session, type User, type SupabaseClient, type AuthError, type RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import type { Database } from 'app-types'

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false
const expectType = <T extends true>() => {}

// same options as corteqsemir src/integrations/supabase/client.ts
const supabase = createClient<Database>('http://localhost:8080', 'anon', {
  auth: { storage: localStorage, persistSession: true, autoRefreshToken: true },
})

async function main() {
  const r = await supabase.from('profile_pages').select('id')
  expectType<Equal<NonNullable<typeof r.data>, { id: string }[]>>()

  // an unknown table must be a type error, proving the result above is not 'any'
  // @ts-expect-error
  supabase.from('no_such_table')

  const { data: { session } } = await supabase.auth.getSession()
  const s: Session | null = session
  const u: User | undefined = s?.user
  const err: AuthError | null = (await supabase.auth.signInWithPassword({ email: 'a', password: 'b' })).error
  const { data } = supabase.auth.onAuthStateChange((event, next) => {
    if (event === 'PASSWORD_RECOVERY' && next) void next.user.id
  })
  data.subscription.unsubscribe()

  const ch = supabase
    .channel('c')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: 'user_id=eq.1' }, (p) => {
      const row = p.new as { id?: string }
      void row
    })
    .subscribe()
  await supabase.removeChannel(ch)

  const fn = await supabase.functions.invoke('x', { body: { a: 1 } })
  void (fn.error as { context?: { status?: number } } | null)?.context?.status
  const up = await supabase.storage.from('b').upload('p', new Blob(['x']), { contentType: 'text/plain', upsert: false })
  void up.data?.path
  void supabase.storage.from('b').getPublicUrl('p').data.publicUrl

  const edge: SupabaseClient = createClient('http://core:8080', 'service', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: 'Bearer x' } },
  })
  await edge.auth.admin.deleteUser('id')
  void u, err
}
void main
void (null as unknown as RealtimePostgresChangesPayload<{ id: string }>)
`

describe.skipIf(!appDir)('types (needs CORTEQS_DIR)', () => {
  it("createClient<Database>().from('profile_pages').select('id') infers { id: string }[] (tsc --noEmit)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfbase-types-'))
    try {
      writeFileSync(join(dir, 'check.ts'), check)
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'es2022',
            module: 'esnext',
            moduleResolution: 'bundler',
            lib: ['es2022', 'dom'],
            types: [],
            paths: { '@supabase/supabase-js': [resolve('dist/selfbase.d.ts')], 'app-types': [appTypes] },
          },
          files: ['check.ts'],
        }),
      )
      let out = ''
      try {
        execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', dir], { encoding: 'utf8' })
      } catch (e: any) {
        out = String(e.stdout)
      }
      expect(out).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
