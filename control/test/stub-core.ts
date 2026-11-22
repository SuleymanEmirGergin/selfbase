// Stands in for a project's core admin listener (:8081): records what reaches it and answers /admin/sql like core.
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Seen = { method: string; url: string; headers: IncomingHttpHeaders; bytes: number }

export async function stubCore() {
  const seen: Seen[] = []
  /** resolves when the first body chunk of a request arrives (the upload test waits on it) */
  let firstChunk: () => void = () => {}
  const server = createServer((req, res) => {
    let bytes = 0
    const chunks: Buffer[] = []
    req.on('data', (b: Buffer) => {
      if (bytes === 0) firstChunk()
      bytes += b.length
      if (bytes < 1 << 20) chunks.push(b)
    })
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, bytes })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/admin/sql') {
        const { query } = JSON.parse(Buffer.concat(chunks).toString() || '{}')
        if (query === 'select 1 as a') return res.end(JSON.stringify({ columns: ['a'], rows: [[1]], rowCount: 1, durationMs: 1 }))
        return res.end(JSON.stringify({ error: { message: 'syntax error at or near "selec"', position: 1, hint: null } }))
      }
      if (req.url?.startsWith('/admin/files/')) res.setHeader('content-disposition', 'attachment; filename="x.bin"')
      if (req.url === '/admin/moved') res.writeHead(302, { location: 'http://sb-internal-core:8081/admin/elsewhere' })
      res.end(JSON.stringify({ ok: true, bytes }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    onFirstChunk: () => new Promise<void>((r) => { firstChunk = r }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
