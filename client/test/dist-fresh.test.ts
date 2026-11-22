// dist/ is committed (the function host bind-mounts it, the app vendors it): fail when it is stale relative to src/.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const norm = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

describe('committed dist', () => {
  it('matches a fresh build of src (run `npm run build` and commit dist/ if this fails)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'selfbase-dist-'))
    try {
      execFileSync(process.execPath, ['build.mjs', tmp], { stdio: 'pipe' })
      const files = readdirSync(tmp).sort()
      expect(readdirSync('dist').sort()).toEqual(files)
      for (const f of files) expect(norm(join('dist', f)), `dist/${f} is stale`).toBe(norm(join(tmp, f)))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 120_000)
})
