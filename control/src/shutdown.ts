// Deploys send SIGTERM: stop taking requests and let the ones in flight finish, stop the job workers, reconcile and
// the scheduler (a worker lets its current step finish, so a one-time job result is committed, not lost), then close
// the pool. Everything runs inside `budgetMs`: a stuck request or step must not outlive docker's 10 s grace period.
type Closable = { close(cb: () => void): unknown; closeIdleConnections?(): void }

export function shutdownHandler(server: Closable, parts: { stop(): unknown }[], closeDb: () => Promise<void>,
  exit: (code: number) => void = process.exit, budgetMs = 8000) {
  let stopping = false
  return async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`${signal}: shutting down`)
    setTimeout(() => exit(1), budgetMs).unref()
    const closed = new Promise<void>((r) => server.close(r))
    server.closeIdleConnections?.()
    await Promise.all([closed, ...parts.map((p) => p.stop())])
    await closeDb()
    exit(0)
  }
}
