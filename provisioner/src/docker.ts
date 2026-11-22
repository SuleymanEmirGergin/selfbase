// Docker Engine API over plain fetch to the socket proxy (spec 7.5), API version pinned. Callers address
// every object by name, which is what makes the proxy's sb-* name patterns effective.
import { ProvisionError } from './names.ts'

// 1.45 = Docker 26; Docker 29 still accepts it (its minimum is 1.44)
const API = '/v1.45'
const PULL_TIMEOUT_MS = 120_000
const HOST =(process.env.DOCKER_HOST || 'http://selfbase-socket-proxy:2375').replace(/\/$/, '')

export async function dockerFetch(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(HOST + API + path, {
      method,
      signal,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ProvisionError(502, 'docker_unreachable', `${method} ${path.split('?')[0]}: socket proxy unreachable`)
  }
}

// JSON call; any status outside 2xx and `ok` is a 502 naming the call (the proxy answers 403 for what it refuses).
export async function docker(method: string, path: string, body?: unknown, ok: number[] = []): Promise<{ status: number; data: any }> {
  const r = await dockerFetch(method, path, body)
  const text = await r.text()
  let data: any = text
  try { data = text ? JSON.parse(text) : null } catch { /* plain text answer */ }
  if (r.ok || ok.includes(r.status)) return { status: r.status, data }
  // a create refusal can echo an Env entry, so its text never leaves the process
  const why = path.startsWith('/containers/create') ? 'container create refused' : String(data?.message ?? text).slice(0, 200)
  throw new ProvisionError(502, 'docker_refused', `${method} ${path.split('?')[0]} -> ${r.status}: ${why}`)
}

// Local image first; otherwise one anonymous pull, then the image must be local (D-1).
export async function ensureImage(image: string): Promise<void> {
  const present = async () => (await docker('GET', `/images/${image}/json`, undefined, [404])).status === 200
  if (await present()) return
  const at = image.lastIndexOf(':')
  const [repo, tag] = at > image.lastIndexOf('/') ? [image.slice(0, at), image.slice(at + 1)] : [image, 'latest']
  // the pull answers with a progress stream; an error can arrive inside a 200, so only the re-check counts.
  // Its own timeout: a hung pull must not hold the per-ref lock.
  await dockerFetch('POST', `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
    undefined, AbortSignal.timeout(PULL_TIMEOUT_MS)).then((r) => r.arrayBuffer()).catch(() => null)
  if (!(await present())) throw new ProvisionError(502, 'image_unavailable', `image ${image} is neither local nor pullable`)
}

// Container logs as text. Containers are never created with a TTY, so the stream is always multiplexed.
export async function containerLogs(name: string, tail: number): Promise<string> {
  const r = await dockerFetch('GET', `/containers/${name}/logs?stdout=true&stderr=true&tail=${tail}`)
  if (r.status === 404) throw new ProvisionError(404, 'service_not_found', `${name} does not exist`)
  if (!r.ok) throw new ProvisionError(502, 'docker_refused', `GET /containers/${name}/logs -> ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  const out: Buffer[] = []
  for (let i = 0; i + 8 <= buf.length; i += 8 + buf.readUInt32BE(i + 4)) out.push(buf.subarray(i + 8, i + 8 + buf.readUInt32BE(i + 4)))
  return Buffer.concat(out).toString('utf8')
}
