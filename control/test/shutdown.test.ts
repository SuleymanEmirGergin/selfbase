import { readFileSync } from 'node:fs'
import type pg from 'pg'
import { expect, test, vi } from 'vitest'
import type { Provisioner } from '../src/provisioner.ts'
import { startReconcile } from '../src/reconcile.ts'
import { msUntilNext, startSchedule } from '../src/schedule.ts'
import { shutdownHandler } from '../src/shutdown.ts'

// a database whose first query waits until `release` is called; every later one answers no rows
const heldDb = () => {
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let first = true
  const query = async () => {
    if (first) { first = false; await held }
    return { rows: [], rowCount: 0 }
  }
  return { db: { query } as unknown as pg.Pool, release, started: () => !first }
}
const settled = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

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

test("the scheduler's stop waits for the nightly run in flight", async () => {
  const { db, release, started } = heldDb()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let schedule: ReturnType<typeof startSchedule>
  try {
    schedule = startSchedule(db)
    vi.advanceTimersByTime(msUntilNext(new Date()) + 1) // just past the next 03:15, once
  } finally {
    vi.useRealTimers()
  }
  expect(started()).toBe(true)
  const stopped = Promise.resolve(schedule.stop())
  expect(await settled(stopped, 100)).toBe(false) // the backups query still runs
  release()
  expect(await settled(stopped, 2_000)).toBe(true)
})

test('a reconcile stopped during a pass ends after that pass, not after another sleep', async () => {
  const { db, release, started } = heldDb()
  const provisioner = { list: async () => [] } as unknown as Provisioner
  const reconcile = startReconcile({ db, provisioner })
  await vi.waitFor(() => expect(started()).toBe(true))
  const stopped = reconcile.stop()
  release()
  expect(await settled(stopped, 2_000)).toBe(true) // the interval is 30 s
})

test('server.ts hands the workers, reconcile and the scheduler to the shutdown handler', () => {
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  expect(src).toMatch(/const workers = startWorkers\(/)
  expect(src).toMatch(/const reconcile = startReconcile\(/)
  expect(src).toMatch(/const schedule = startSchedule\(/)
  expect(src).toMatch(/shutdownHandler\(server as Server, \[workers, reconcile, schedule\], closeDb\)/)
  expect(src).toMatch(/process\.on\('SIGTERM', \(\) => void shutdown\('SIGTERM'\)\)/)
})
