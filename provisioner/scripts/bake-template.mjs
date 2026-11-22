// Image build step (D-3): template/compose.yml -> JSON, so the runtime needs no YAML parser.
// Usage: node provisioner/scripts/bake-template.mjs <compose.yml> <out.json>
// Validation happens at provisioner start (validateTemplate); aliases are refused here already.
import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'yaml'

const [src, out] = process.argv.slice(2)
if (!src || !out) {
  console.error('usage: bake-template.mjs <compose.yml> <out.json>')
  process.exit(2)
}
writeFileSync(out, JSON.stringify(parse(readFileSync(src, 'utf8'), { maxAliasCount: 0 }), null, 2) + '\n')
