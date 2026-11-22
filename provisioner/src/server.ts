// Stub: GET /health only, enough for the image to build and start. Task 7 brings the real server.
import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? 8090)

createServer((req, res) => {
  const health = req.method === 'GET' && req.url === '/health'
  res.writeHead(health ? 200 : 404, { 'content-type': 'application/json' })
  res.end(JSON.stringify(health ? { ok: true } : { error: 'not found' }))
}).listen(port, () => console.log(`selfbase-provisioner listening on :${port}`))
