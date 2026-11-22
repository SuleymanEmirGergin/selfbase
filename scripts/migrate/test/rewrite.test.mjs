// node --test scripts/migrate/test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isSupabaseHost, parseEnv, rewrite } from '../05-rewrite-urls.mjs'

const from = 'abcdefghijklmnopqrst.supabase.co'
const to = 'https://api.example.com'

test('plain text', () => {
  assert.equal(
    rewrite('see https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/a/b.png', from, to),
    'see https://api.example.com/storage/v1/object/public/a/b.png',
  )
})

test('inside jsonb text stays valid json', () => {
  const json = JSON.stringify({ avatar: 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/av/1.jpg', n: 1 })
  const out = rewrite(json, from, to)
  assert.deepEqual(JSON.parse(out), { avatar: 'https://api.example.com/storage/v1/object/public/av/1.jpg', n: 1 })
})

test('two addresses on one line', () => {
  assert.equal(
    rewrite('a https://abcdefghijklmnopqrst.supabase.co/x b HTTPS://ABCDEFGHIJKLMNOPQRST.supabase.co/y', from, to),
    'a https://api.example.com/x b https://api.example.com/y',
  )
})

test('another project and look-alike hosts are untouched', () => {
  const text = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co/x https://abcdefghijklmnopqrst.supabase.co.evil.com/y ' +
    'https://xabcdefghijklmnopqrst.supabase.co/z'
  assert.equal(rewrite(text, from, to), text)
})

test('already rewritten text does not change', () => {
  const once = rewrite('https://abcdefghijklmnopqrst.supabase.co/functions/v1/f', from, to)
  assert.equal(rewrite(once, from, to), once)
  assert.equal(once, 'https://api.example.com/functions/v1/f')
})

test('text[] literal keeps its shape', () => {
  assert.equal(
    rewrite('{https://abcdefghijklmnopqrst.supabase.co/a,"b c"}', from, to),
    '{https://api.example.com/a,"b c"}',
  )
})

test('parseEnv matches lib.sh load_env: literal values, CRLF stripped', () => {
  const env = parseEnv('# c\r\nA=plain\r\nB=p@ss$wo"rd#x y\r\n C = spaced\r\nexport D=no\r\n\r\n')
  assert.deepEqual(env, { A: 'plain', B: 'p@ss$wo"rd#x y', C: ' spaced' })
})

test('Supabase hosts are refused as target', () => {
  assert.equal(isSupabaseHost('postgres://postgres.abc:p@aws-1-eu-west-2.pooler.supabase.com:5432/postgres'), true)
  assert.equal(isSupabaseHost('postgres://postgres:p@abcdefghijklmnopqrst.supabase.co:5432/postgres'), true)
  assert.equal(isSupabaseHost('postgres://postgres:p@localhost:54451/postgres'), false)
  assert.equal(isSupabaseHost('postgres://u:p@abc.supabase.co./postgres'), true)
  assert.equal(isSupabaseHost('postgres://u:p@abc.supabase.co.:5432/postgres'), true)
  assert.equal(isSupabaseHost('postgres://u:p@abc.supabase.com..:6543/postgres'), true)
})

test('an unparsable URL is reported by name, never echoed', () => {
  const secret = 'pa/ss#word'
  const ok = { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', PUBLIC_URL: 'https://a.example',
    TARGET_DB_URL: 'postgres://u:p@localhost:1/db', SUPABASE_SERVICE_KEY: 'k', SERVICE_ROLE_KEY: 'k', STORAGE_DIR: '.' }
  for (const [script, arg, name] of [
    ['03-auth-storage.sql.mjs', 'rows', 'TARGET_DB_URL'],
    ['04-files.mjs', '', 'SUPABASE_URL'],
    ['05-rewrite-urls.mjs', '--dry-run', 'SUPABASE_URL'],
    ['05-rewrite-urls.mjs', '--dry-run', 'PUBLIC_URL'],
    ['05-rewrite-urls.mjs', '--dry-run', 'TARGET_DB_URL'],
    ['06-realtime-cron.mjs', '', 'TARGET_DB_URL'],
  ]) {
    const bad = name === 'TARGET_DB_URL' ? `postgres://u:${secret}@localhost:1/db` : `https://u:${secret}@x`
    const r = spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}`, import.meta.url)), arg].filter(Boolean),
      { env: { ...process.env, ...ok, [name]: bad, DUMP_DIR: 'nonexistent' }, encoding: 'utf8', timeout: 20000 })
    assert.equal(r.status, 2, `${script}: ${r.stderr}`)
    assert.match(r.stderr, new RegExp(`${name} is not a valid URL \\(percent-encode the password\\)`))
    assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret), `${script} printed the input`)
  }
})
