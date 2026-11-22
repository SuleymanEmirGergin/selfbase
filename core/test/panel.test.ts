import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// config.ts reads PANEL_DIR once at import time, so the env is set before app.ts is imported.
const dir = mkdtempSync(join(tmpdir(), 'panel-test-'))
process.env.PANEL_DIR = dir
const { app } = await import('../src/app.ts')

describe('panel static serving', () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('GET /panel/* is 404 when the panel directory has no build', async () => {
    const res = await app.request('/panel/index.html')
    expect(res.status).toBe(404)
  })

  it('serves index.html at /panel/ once the directory has one', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>panel-test</title>')
    const res = await app.request('/panel/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('panel-test')
  })
})
