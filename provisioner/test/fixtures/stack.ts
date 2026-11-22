// Brings the compose.test.yml stack up and down for the real-Docker tests. Everything it creates is named
// selfbase-test* or sb-*, and down() removes all of it.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dir = fileURLToPath(new URL('..', import.meta.url))
export const PORT = Number(process.env.TEST_PROVISIONER_PORT ?? 58090)
export const TOKEN = 'test-provisioner-token-0123456789abcdef'
export const REGISTRY = 'selfbase-test.invalid/sb'
export const IMAGE = `${REGISTRY}/selfbase-core:test`
export const PROXY_NET = 'selfbase-test-proxy'
const IMAGES = ['db', 'core', 'job'].map((s) => `${REGISTRY}/selfbase-${s}:test`)
export const BACKUP_DIR = '/opt/selfbase/sb-test-backups'
// compose fills these into socket-proxy.env, as on the server
const env = { ...process.env, PROXY_NETWORK: PROXY_NET, REGISTRY, BACKUP_HOST_DIR: BACKUP_DIR }

export const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export const tryDocker = (...args: string[]) => {
  try { return docker(...args) } catch { return null }
}
const compose = (...args: string[]) => docker('compose', '-p', 'selfbase-test', '-f', join(dir, 'compose.test.yml'), ...args)
export const execIn = (service: string, js: string) => compose('exec', '-T', service, 'node', '-e', js)

export async function up() {
  docker('build', '-q', ...IMAGES.flatMap((t) => ['-t', t]), join(dir, 'fixture-image'))
  if (tryDocker('network', 'inspect', PROXY_NET) === null) docker('network', 'create', PROXY_NET)
  // the fixed backup directory must exist in the daemon's filesystem; a -v bind creates it
  docker('run', '--rm', '-v', `${BACKUP_DIR}:/b`, IMAGE, 'true')
  compose('up', '-d')
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`provisioner did not start:\n${compose('logs', 'provisioner')}`)
}

export function down() {
  tryDocker('run', '--rm', '-v', '/opt/selfbase:/t', IMAGE, 'rm', '-rf', '/t/sb-test-backups')
  compose('down', '-v', '--remove-orphans')
  tryDocker('network', 'rm', PROXY_NET)
  tryDocker('rmi', ...IMAGES)
}

export async function api(method: string, path: string, body?: unknown, token = TOKEN) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  return { status: r.status, body: r.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text }
}
