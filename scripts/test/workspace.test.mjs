// Repository layout of the v2 monorepo: npm workspaces, one root lockfile, one Dockerfile per image.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = join(import.meta.dirname, '..', '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const WORKSPACES = { core: 'selfbase-core', control: 'selfbase-control', provisioner: 'selfbase-provisioner', studio: 'selfbase-studio', client: 'selfbase-js', acceptance: 'selfbase-acceptance' }
const IMAGES = ['db', 'core', 'fn', 'rest', 'pooler', 'job', 'control', 'provisioner']

test('the root lists exactly the six workspaces, with their package names', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.private, true)
  assert.equal(pkg.version, '2.1.1')
  assert.deepEqual(pkg.workspaces, Object.keys(WORKSPACES))
  for (const [dir, name] of Object.entries(WORKSPACES)) assert.equal(JSON.parse(read(`${dir}/package.json`)).name, name, dir)
})

test('no package-lock.json exists below the root', () => {
  // tracked and untracked-but-not-ignored files; node_modules and worktrees are ignored
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n')
  const locks = files.filter((f) => f.endsWith('package-lock.json') && f !== 'package-lock.json' && existsSync(join(root, f)))
  assert.deepEqual(locks, [])
  assert.ok(existsSync(join(root, 'package-lock.json')), 'root package-lock.json')
})

test('every image has its Dockerfile', () => {
  for (const name of IMAGES) assert.ok(existsSync(join(root, name, 'Dockerfile')), `${name}/Dockerfile`)
})

for (const wf of ['images.yml', 'ci.yml']) {
  test(`${wf} builds all eight images`, () => {
    const m = read(`.github/workflows/${wf}`).match(/^\s+image: \[(.+)\]\s*$/m)
    assert.ok(m, 'matrix line "image: [..]" not found')
    assert.deepEqual(m[1].split(',').map((s) => s.trim()).sort(), [...IMAGES].sort())
  })
}
