// Provisioner HTTP API (spec 7.5). JSON in and out, `Authorization: Bearer <PROVISIONER_TOKEN>` on every
// route except GET /health, bodies up to 256 KiB. Errors: {error, message}. One log line per request:
// method, path (ref and service only, never a body), status and error code.
// Start: settings, the baked template (TEMPLATE_PATH) and the size table (SIZES_PATH) are read and every
// size is rendered once; any failure exits with code 1.
import { createServer, type IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { ProvisionError } from './names.ts'
import { loadSettings } from './settings.ts'
import { TemplateError, validateTemplate } from './template.ts'
import { buildProject, dryRunEnv, type Sizes } from './spec.ts'
import * as ops from './ops.ts'

const MAX_BODY = 256 * 1024

function boot(): { ctx: ops.Ctx; token: Buffer } {
  const node = loadSettings()
  const tpl = validateTemplate(JSON.parse(readFileSync(process.env.TEMPLATE_PATH || '/app/template.json', 'utf8')))
  const sizes: Sizes = JSON.parse(readFileSync(process.env.SIZES_PATH || '/app/sizes.json', 'utf8'))
  // same dry run as `template.ts --check`: every size must render every service
  const env = dryRunEnv(tpl)
  for (const size of ['micro', 'small', 'medium'] as const) {
    buildProject({ ref: 'checkcheckcheckcheck', templateVersion: node.templateVersion, size, hosts: ['check.invalid'], env,
      subnet: `${node.subnetPool.split('/')[0]}/27` }, tpl, sizes, node)
  }
  // a compose secret file (not in Config.Env, which a socket proxy's inspect shows); plain env for development
  const file = process.env.PROVISIONER_TOKEN_FILE
  const token = (file ? readFileSync(file, 'utf8').trim() : process.env.PROVISIONER_TOKEN) ?? ''
  if (token.length < 32) throw new Error('settings: PROVISIONER_TOKEN must be at least 32 characters')
  return { ctx: { tpl, sizes, node }, token: createHash('sha256').update(token).digest() }
}

let ctx: ops.Ctx, token: Buffer
try {
  ;({ ctx, token } = boot())
} catch (e) {
  console.error(`provisioner: start refused: ${(e as Error).message}`)
  process.exit(1)
}

const authorized = (h: string | undefined) =>
  !!h?.startsWith('Bearer ') && timingSafeEqual(createHash('sha256').update(h.slice(7)).digest(), token)

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw new ProvisionError(413, 'body_too_large', 'body exceeds 256 KiB')
    chunks.push(c)
  }
  if (!size) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ProvisionError(400, 'invalid_json', 'body is not JSON')
  }
}

type Route = [method: string, path: RegExp, run: (p: string[], q: URLSearchParams, body: unknown) => Promise<unknown>]
const P = '([^/]+)'
const routes: Route[] = [
  ['GET', /^\/health$/, async () => ({ ok: true, templateVersion: ctx.node.templateVersion })],
  ['GET', /^\/projects$/, () => ops.listProjects(ctx)],
  ['GET', new RegExp(`^/projects/${P}$`), ([ref]) => ops.projectState(ctx, ref)],
  ['POST', new RegExp(`^/projects/${P}/ensure$`), ([ref], _, b) => ops.serial(ref, () => ops.ensure(ctx, ref, b))],
  ['POST', new RegExp(`^/projects/${P}/(start|stop)$`), ([ref, a], _, b) => ops.serial(ref, () => ops.startStop(ctx, ref, a as 'start' | 'stop', b))],
  ['DELETE', new RegExp(`^/projects/${P}$`), ([ref], q) => {
    const v = q.get('volumes') ?? 'false'
    if (v !== 'true' && v !== 'false') throw new ProvisionError(400, 'invalid_volumes', 'volumes must be true or false')
    return ops.serial(ref, () => ops.remove(ctx, ref, v === 'true'))
  }],
  ['POST', new RegExp(`^/projects/${P}/attach-proxy$`), ([ref]) => ops.serial(ref, () => ops.attachProxy(ctx, ref))],
  // a job create also holds its ref's lock, so it cannot interleave with that project's delete (always ref, then jobs)
  ['POST', new RegExp(`^/projects/${P}/jobs$`), ([ref], _, b) => ops.serial(ref, () => ops.serial('jobs', () => ops.runJob(ctx, ref, b)))],
  ['GET', new RegExp(`^/projects/${P}/jobs/${P}$`), ([ref, type]) => ops.serial('jobs', () => ops.jobStatus(ref, type))],
  ['GET', new RegExp(`^/projects/${P}/services/${P}/logs$`), ([ref, s], q) => ops.serviceLogs(ctx, ref, s, q.get('tail'))],
  ['GET', new RegExp(`^/projects/${P}/services/${P}/stats$`), ([ref, s]) => ops.serviceStats(ctx, ref, s)],
]

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://provisioner')
  let status = 200, code = '', out: unknown
  try {
    if (url.pathname !== '/health' && !authorized(req.headers.authorization)) throw new ProvisionError(401, 'unauthorized', 'bad bearer token')
    const hit = routes.find(([m, re]) => m === req.method && re.test(url.pathname))
    if (!hit) throw new ProvisionError(404, 'not_found', 'no such route')
    const params = hit[1].exec(url.pathname)!.slice(1).map((p) => {
      try { return decodeURIComponent(p) } catch { throw new ProvisionError(400, 'invalid_path', 'path is not valid percent-encoding') }
    })
    out = await hit[2](params, url.searchParams, await readBody(req))
  } catch (e) {
    if (e instanceof ProvisionError) [status, code, out] = [e.status, e.code, { error: e.code, message: e.message }]
    else if (e instanceof TemplateError) [status, code, out] = [500, 'template_invalid', { error: 'template_invalid', message: e.message }]
    else {
      ;[status, code, out] = [500, 'internal', { error: 'internal', message: 'internal error' }]
      console.error(`provisioner: ${req.method} ${url.pathname.slice(0, 200)}: ${(e as Error).stack}`)
    }
  }
  console.log(`${req.method} ${url.pathname.slice(0, 200)} -> ${status}${code ? ` ${code}` : ''}`)
  const text = typeof out === 'string'
  res.writeHead(status, { 'content-type': text ? 'text/plain; charset=utf-8' : 'application/json' })
  res.end(text ? out : JSON.stringify(out))
}).listen(Number(process.env.PORT || 8090), () => console.log(`selfbase-provisioner listening on :${process.env.PORT || 8090}`))
