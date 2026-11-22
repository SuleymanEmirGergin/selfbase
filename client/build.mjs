// Builds <out>/selfbase.mjs (browser + Node), <out>/selfbase.deno.mjs (Deno) and <out>/selfbase.d.ts.
// Usage: node build.mjs [outDir]   (default: dist; dist is committed, test/dist-fresh.test.ts checks it is current)
import { build } from 'esbuild'
import { generateDtsBundle } from 'dts-bundle-generator'
import ts from 'typescript'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'dist'
const banner = '/*! selfbase-js. Bundles postgrest-js and supabase-js type code, MIT License, Copyright (c) 2020 Supabase. */'
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const common = { entryPoints: ['src/index.ts'], bundle: true, format: 'esm', target: 'es2020', banner: { js: banner }, legalComments: 'none',
  // whitespace minify drops upstream doc comments (their examples name supabase hosts and packages); identifiers stay readable
  minifyWhitespace: true, minifySyntax: true }
await build({ ...common, platform: 'browser', outfile: join(out, 'selfbase.mjs') })
// Same code: every browser global it touches (window, localStorage, navigator.locks) is feature-detected.
await build({ ...common, platform: 'neutral', outfile: join(out, 'selfbase.deno.mjs') })

const [dts] = generateDtsBundle([{ filePath: 'src/index.ts', output: { noBanner: true, exportReferencedTypes: false } }], {
  preferredConfigPath: 'tsconfig.build.json',
})
// Strip doc comments: they carry upstream examples (hosts, package names) that must not ship.
const printed = ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('selfbase.d.ts', dts, ts.ScriptTarget.Latest))
writeFileSync(join(out, 'selfbase.d.ts'), `${banner}\n${printed}`)

copyFileSync('vendor/postgrest-js/LICENSE', join(out, 'LICENSE-postgrest-js'))
copyFileSync('vendor/supabase-js/LICENSE', join(out, 'LICENSE-supabase-js'))
console.log(`built ${out}/selfbase.mjs, ${out}/selfbase.deno.mjs, ${out}/selfbase.d.ts`)
