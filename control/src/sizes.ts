// Project sizes from template/sizes.json, the same file the provisioner builds containers from.
import { readFileSync } from 'node:fs'

type Sizes = Record<string, Record<string, { mem_mb: number }>>

// shortcut: path relative to the source tree; the image must put sizes.json at the same relative place (Task 17)
const FILE = new URL('../../template/sizes.json', import.meta.url)
let cached: Sizes | undefined
const load = (): Sizes => (cached ??= JSON.parse(readFileSync(FILE, 'utf8')))

/** Memory cap of one running project of this size: the sum of its services' mem_mb. */
export function projectCapMb(size: string, sizes: Sizes = load()): number {
  if (!Object.hasOwn(sizes, size)) throw new Error(`unknown size ${size}`)
  return Object.values(sizes[size]).reduce((sum, s) => sum + s.mem_mb, 0)
}
