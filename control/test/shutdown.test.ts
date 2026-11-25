import { expect, test } from 'vitest'
import { shutdownHandler } from '../src/shutdown.ts'

const order: string[] = []
const fakeServer = () => ({ close: (cb: () => void) => { order.push('server'); setTimeout(cb, 10) }, closeIdleConnections: () => {} })

test('shutdown stops the workers, reconcile and schedule before the pool closes, then exits 0', async () => {
  order.length = 0
  const stop = (name: string, ms: number) => ({ stop: () => new Promise<void>((r) => setTimeout(() => { order.push(name); r() }, ms)) })
  let code: number | undefined
  const shutdown = shutdownHandler(fakeServer(), [stop('workers', 30), stop('reconcile', 5), stop('schedule', 0)],
    async () => { order.push('pool') }, (c) => { code = c })
  await shutdown('SIGTERM')
  expect(order.slice(-1)).toEqual(['pool'])
  expect(order.slice(0, -1).sort()).toEqual(['reconcile', 'schedule', 'server', 'workers'])
  expect(code).toBe(0)
  // a second signal does nothing
  await shutdown('SIGINT')
  expect(order.filter((o) => o === 'pool')).toHaveLength(1)
})

test('a stop that never ends leaves the 8 s budget to exit 1', async () => {
  let code: number | undefined
  const shutdown = shutdownHandler(fakeServer(), [{ stop: () => new Promise<void>(() => {}) }], async () => {}, (c) => { code = c }, 50)
  void shutdown('SIGTERM')
  await new Promise((r) => setTimeout(r, 120))
  expect(code).toBe(1)
})
