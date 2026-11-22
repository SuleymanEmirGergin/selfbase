import { startWorker } from './worker.ts'
import type { NetQueueOptions } from './worker.ts'

let worker: ReturnType<typeof startWorker> | undefined

/** Called once from server.ts; starts the selfbase.http_queue worker. Resolves once LISTEN is up. */
export function startNetQueue(opts?: NetQueueOptions): Promise<void> {
  worker = startWorker(opts)
  return worker.ready
}

/** Stops the worker after the request in flight (tests, shutdown). */
export async function stopNetQueue(): Promise<void> {
  await worker?.stop()
  worker = undefined
}
