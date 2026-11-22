// Helpers for stack.test.mjs: docker and compose calls, HTTPS through the stack's Traefik, waiting, snapshots.
import { spawnSync } from 'node:child_process'
import { request } from 'node:https'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { statSync } from 'node:fs'

export const root = join(import.meta.dirname, '..', '..')
export const PROJECT = process.env.E2E_COMPOSE_PROJECT || 'selfbase-t17'
export const HTTPS_PORT = 18443
export const HTTP_PORT = 18080
export const BASE = 'localhost'
export const CONTROL_HOST = `selfbase.${BASE}`
export const ORIGIN = `https://${CONTROL_HOST}:${HTTPS_PORT}`
// sorts before every sb-<ref> network, as `coolify` does on the server: Docker's DNS then prefers this network's
// address for a container on both, which is what control must never use to reach a core (carry 4)
export const PROXY_NETWORK = 'sb-0-e2e-proxy'
export const BACKUP_HOST_DIR = '/opt/selfbase/sb-e2e-backups'

// Git Bash on Windows would rewrite container paths such as /backups; docker must see them as given
const ENV = { ...process.env, MSYS_NO_PATHCONV: '1' }

/** Runs a command; throws with its stderr unless `ok` allows the exit code. */
export function run(cmd, args, { input, ok = [0], timeout = 600_000 } = {}) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', env: ENV, timeout, maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  if (!ok.includes(r.status)) throw new Error(`${cmd} ${args.join(' ')} -> ${r.status}: ${(r.stderr || r.stdout).slice(-2000)}`)
  return r.stdout.trim()
}
export const docker = (...args) => run('docker', args)
export const dockerOk = (...args) => run('docker', args, { ok: [0, 1] })

export function envFile() {
  const b = (n) => randomBytes(n).toString('base64url')
  return {
    SELFBASE_MASTER_KEY: randomBytes(32).toString('base64'),
    CONTROL_DB_PASSWORD: b(32),
    CONTROL_JWT_SECRET: b(48),
    PROVISIONER_TOKEN: b(32),
    BASE_DOMAIN: BASE,
    PUBLIC_URL: ORIGIN,
    REGISTRY: 'selfbase.local',
    TEMPLATE_VERSION: 'e2e',
    PROXY_MODE: 'own',
    COMPOSE_PROFILES: 'proxy',
    PROXY_NETWORK,
    PROXY_CERTRESOLVER: '',
    PROXY_HTTP_PORT: String(HTTP_PORT),
    PROXY_HTTPS_PORT: String(HTTPS_PORT),
    CERT_PROBE: 'off',
    MAX_NEW_HOSTS_PER_WEEK: '3',
    BACKUP_HOST_DIR,
    LOG_SYSLOG_ADDR: 'udp://127.0.0.1:5514',
    // explicit /27s from here; nothing else on a developer machine uses it
    PROJECT_SUBNET_POOL: '10.218.0.0/16',
    // root:docker on a Linux host (CI); Docker Desktop's socket is root:root
    DOCKER_SOCKET_GID: process.platform === 'linux' ? String(statSync('/var/run/docker.sock').gid) : '0',
  }
}

export const compose = (envPath, ...args) =>
  run('docker', ['compose', '-p', PROJECT, '-f', 'control/compose.yml', '-f', 'control/compose.build.yml', '--env-file', envPath, ...args])

/**
 * HTTPS to <host>:18443 on 127.0.0.1 with SNI and Host set, so no name resolution is needed. Traefik's default
 * certificate is accepted, and only for *.localhost.
 */
export function https(host, path, { method = 'GET', headers = {}, body, timeout = 30_000 } = {}) {
  if (host !== BASE && !host.endsWith(`.${BASE}`)) throw new Error(`refusing an unverified certificate for ${host}`)
  const data = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  // content-length always: Node sends a DELETE body neither chunked nor with a length otherwise, i.e. not at all
  const h = { host: `${host}:${HTTPS_PORT}`, ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}),
    ...(data !== undefined ? { 'content-length': String(Buffer.byteLength(data)) } : {}), ...headers }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: HTTPS_PORT, servername: host, path, method, headers: h, rejectUnauthorized: false, timeout }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${host}${path}`)))
    req.on('error', reject)
    if (data !== undefined) req.write(data)
    req.end()
  })
}

/** Polls fn until it returns a truthy value; the last error or value is in the timeout message. */
export async function waitFor(what, fn, { timeout = 60_000, every = 1000 } = {}) {
  const until = Date.now() + timeout
  let last
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
      last = v
    } catch (e) {
      last = e.message
    }
    if (Date.now() > until) throw new Error(`timed out after ${timeout} ms waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 500)})`)
    await new Promise((r) => setTimeout(r, every))
  }
}

export const inspect = (name) => JSON.parse(docker('inspect', name))[0]

/** Every container, network and volume on this Docker host, as sorted name lists. */
export function snapshot() {
  const list = (...args) => docker(...args).split('\n').filter(Boolean).sort()
  return {
    containers: list('ps', '-a', '--format', '{{.Names}}'),
    networks: list('network', 'ls', '--format', '{{.Name}}'),
    volumes: list('volume', 'ls', '--format', '{{.Name}}'),
  }
}

/** A TCP connect from inside a container: 'open', 'refused' or 'timeout' (node is in every image that runs it). */
export function connectFrom(container, ip, port) {
  return run('docker', ['exec', container, 'node', '-e', `const s=require('net').connect({host:'${ip}',port:${port},timeout:3000});`
    + `s.on('connect',()=>{console.log('open');process.exit(0)});s.on('timeout',()=>{console.log('timeout');process.exit(0)});`
    + `s.on('error',(e)=>{console.log(e.code==='ECONNREFUSED'?'refused':e.code);process.exit(0)})`])
}

export function resolveFrom(container, name) {
  return run('docker', ['exec', container, 'node', '-e',
    `require('dns').lookup('${name}',(e,a)=>{console.log(e?e.code:a);process.exit(0)})`])
}
