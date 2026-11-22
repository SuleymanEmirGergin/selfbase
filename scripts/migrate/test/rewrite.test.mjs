// node --test scripts/migrate/test
import { test } from 'node:test'
import assert from 'node:assert/strict'
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
})
