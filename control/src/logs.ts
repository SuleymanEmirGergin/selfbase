// A project service's recent log lines (spec 8.7): VictoriaLogs first; when it cannot answer, the container's own
// tail from the provisioner. The query is built from the validated ref and the service enum only.
import { config } from './config.ts'
import { provisioner } from './provisioner.ts'

export const LOG_SERVICES = ['db', 'rest', 'core', 'fn', 'pooler']
export type LogLine = { ts: string; msg: string }

/** Newest first. `start` is an ISO timestamp the caller validated. */
export async function projectLogs(ref: string, service: string, limit: number, start?: string): Promise<{ lines: LogLine[]; source: 'store' | 'container' }> {
  try {
    // the syslog tag is the container name (provisioner spec.ts), which VictoriaLogs stores as app_name
    const form = new URLSearchParams({ query: `app_name:="sb-${ref}-${service}" | sort by (_time desc) | limit ${limit}` })
    if (start) form.set('start', start)
    const res = await fetch(`${config.logsUrl.replace(/\/+$/, '')}/select/logsql/query`, { method: 'POST', body: form, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`log store answered ${res.status}`)
    const lines = (await res.text()).split('\n').filter(Boolean).map((l) => {
      const o = JSON.parse(l)
      return { ts: String(o._time ?? ''), msg: String(o._msg ?? '') }
    })
    return { lines, source: 'store' }
  } catch {
    // shortcut: the tail has no timestamps (ts '') and ignores `start`; fine as a fallback, the store is the real source
    const tail = await provisioner().logs(ref, service, limit)
    return { lines: tail.split('\n').map((l) => l.trimEnd()).filter(Boolean).reverse().map((msg) => ({ ts: '', msg })), source: 'container' }
  }
}
