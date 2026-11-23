// scripts/import-project.mjs against a local stub of control: the multipart fields it sends, what it prints.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = join(import.meta.dirname, '..', 'import-project.mjs')
const TOKEN = `sbp_${'a'.repeat(40)}`
const ENV = 'JWT_SECRET=stub-jwt-secret-value-123\nANON_KEY=stub-anon-key-value\nSERVICE_ROLE_KEY=stub-service-role-value\nFOO=stub-foo-value\n'

const run = (args, env = {}, input = '') => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, SELFBASE_ACCESS_TOKEN: TOKEN, ...env } })
  child.stdin.end(input)
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  child.on('close', (code) => resolve({ code, out }))
})

// a stub of control: records the import's fields, answers the job as succeeded
async function stub() {
  const seen = {}
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (req.method === 'POST' && req.url === '/platform/projects/import') {
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData()
      Object.assign(seen, { auth: req.headers.authorization, fields: Object.fromEntries([...form].map(([k, v]) => [k, typeof v === 'string' ? v : 'file'])),
        env: await form.get('env_file')?.text() })
      return json(202, { project: { ref: 'abcdefghijklmnopqrst', name: 'p' }, job_id: 'job-1', ignored: ['POSTGRES_PASSWORD'], unknown: ['FOO'] })
    }
    if (req.method === 'GET' && req.url === '/platform/jobs/job-1') {
      return json(200, { id: 'job-1', status: 'succeeded', steps: ['allocate', 'restore'], events: [{ event: 'allocate' }, { event: 'restore' }] })
    }
    json(404, { error: 'not_found', message: 'not found' })
  })
  await new Promise((r) => server.listen(0, r))
  return { seen, server, url: `http://localhost:${server.address().port}` }
}

test('sends the multipart fields with the token, polls the job, prints names only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-import-'))
  const envPath = join(dir, '.env')
  writeFileSync(envPath, ENV)
  const { seen: got, server, url } = await stub()
  try {
    const { code, out } = await run(['--url', url, '--org', 'acme', '--name', 'p', '--size', 'small',
      '--backup-dir', 'corteqs/20261121-031500', '--env-file', envPath])
    assert.equal(code, 0, out)
    assert.equal(got.auth, `Bearer ${TOKEN}`)
    assert.deepEqual(got.fields, { organization_slug: 'acme', name: 'p', size: 'small', backup_dir: 'corteqs/20261121-031500', env_file: 'file' })
    assert.equal(got.env, ENV)
    assert.match(out, /abcdefghijklmnopqrst/)
    assert.match(out, /restore/)
    assert.match(out, /POSTGRES_PASSWORD/)
    assert.match(out, /FOO/)
    for (const v of ['stub-jwt-secret-value-123', 'stub-anon-key-value', 'stub-service-role-value', 'stub-foo-value', TOKEN]) {
      assert.ok(!out.includes(v), 'the output contains a value')
    }
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an export: --passphrase - reads it from stdin and sends it instead of an env file; it is never printed', async () => {
  const { seen, server, url } = await stub()
  const pass = 'stub export passphrase value'
  try {
    const { code, out } = await run(['--url', url, '--org', 'acme', '--name', 'p', '--size', 'small',
      '--backup-dir', 'export-abcdefghijklmnopqrst/20261121-031500', '--passphrase', '-'], {}, `${pass}\n`)
    assert.equal(code, 0, out)
    assert.deepEqual(seen.fields, { organization_slug: 'acme', name: 'p', size: 'small', backup_dir: 'export-abcdefghijklmnopqrst/20261121-031500',
      passphrase: pass })
    assert.ok(!out.includes(pass), 'the output contains the passphrase')
  } finally {
    server.close()
  }
})

test('a passphrase given in argv is read as a file name and never echoed; both or neither of the two is refused', async () => {
  const common = ['--url', 'https://selfbase.example', '--org', 'a', '--name', 'p', '--size', 'small', '--backup-dir', 'x']
  const inline = await run([...common, '--passphrase', 'my secret passphrase'])
  assert.notEqual(inline.code, 0)
  assert.ok(!inline.out.includes('my secret passphrase'), inline.out)
  const both = await run([...common, '--passphrase', '-', '--env-file', script], {}, 'p\n')
  assert.notEqual(both.code, 0)
  assert.match(both.out, /exactly one/)
  const neither = await run(common)
  assert.notEqual(neither.code, 0)
  assert.match(neither.out, /exactly one/)
})

test('an http URL to another host is refused before anything is sent', async () => {
  const { code, out } = await run(['--url', 'http://example.com', '--org', 'a', '--name', 'p', '--size', 'small', '--backup-dir', 'x', '--env-file', script])
  assert.notEqual(code, 0)
  assert.match(out, /https/)
})

test('without SELFBASE_ACCESS_TOKEN it stops', async () => {
  const { code, out } = await run(['--url', 'https://selfbase.example', '--org', 'a', '--name', 'p', '--size', 'small', '--backup-dir', 'x',
    '--env-file', script], { SELFBASE_ACCESS_TOKEN: '' })
  assert.notEqual(code, 0)
  assert.match(out, /SELFBASE_ACCESS_TOKEN/)
})
