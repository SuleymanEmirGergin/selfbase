import { execFileSync } from 'node:child_process'

// The bundle and type tests check dist/, so build it once per run.
export default function setup() {
  execFileSync(process.execPath, ['build.mjs'], { stdio: 'pipe' })
}
