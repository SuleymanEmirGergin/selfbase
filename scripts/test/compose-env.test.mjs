// Fails when core/fn read an env variable that compose.yml does not pass to that service
// (so it could never be set in a compose deployment) and that is not deliberately internal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const compose = readFileSync(join(root, 'compose.yml'), 'utf8')

// Text of one top-level service block (2-space indented key up to the next one).
function serviceBlock(name) {
  const lines = compose.split(/\r?\n/)
  const start = lines.findIndex((l) => l === `  ${name}:`)
  assert.ok(start >= 0, `service ${name} not found in compose.yml`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^\S/.test(l) || /^  \S/.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

function sources(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'test' ? [] : sources(p)
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [readFileSync(p, 'utf8')] : []
  })
}

const reads = (texts, re) => new Set(texts.flatMap((t) => [...t.matchAll(re)].map((m) => m[1])))

// Set by the compose file itself or the image, not meant for the operator.
const CORE_INTERNAL = ['DB_HOST', 'DB_PORT', 'PORT', 'PANEL_DIR']
const FN_INTERNAL = ['PORT']

function check(service, vars, internal) {
  const block = serviceBlock(service)
  const missing = [...vars].filter((v) => !internal.includes(v) && !new RegExp(`^\\s+${v}:`, 'm').test(block))
  assert.deepEqual(missing, [], `${service}: read by code but not passed in compose.yml (pass with \${X:-default} or allowlist as internal)`)
}

test('every env variable core reads is passed by compose or internal', () => {
  const vars = reads(sources(join(root, 'core', 'src')), /\b(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g)
  assert.ok(vars.size > 20, 'scan found too few variables, regex broken?')
  check('core', vars, CORE_INTERNAL)
})

test('fn gets no database credentials', () => {
  const block = serviceBlock('fn')
  assert.doesNotMatch(block, /^\s+SUPABASE_DB_URL:/m)
  assert.doesNotMatch(block, /POSTGRES_PASSWORD/)
})

test('values the services cannot run without stop compose when missing', () => {
  for (const [service, vars] of [['core', ['PUBLIC_URL', 'SITE_URL']], ['fn', ['ANON_KEY', 'SERVICE_ROLE_KEY']]]) {
    const block = serviceBlock(service)
    for (const v of vars) assert.match(block, new RegExp(`\\$\\{${v}:\\?[^}]+\\}`), `${service}: ${v} must be \${${v}:?message}`)
  }
})

test('every env variable fn reads is passed by compose or internal', () => {
  const vars = reads(sources(join(root, 'fn')), /Deno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)
  assert.ok(vars.has('FN_IMPORT_TIMEOUT_MS'), 'scan missed FN_IMPORT_TIMEOUT_MS, regex broken?')
  check('fn', vars, FN_INTERNAL)
})
