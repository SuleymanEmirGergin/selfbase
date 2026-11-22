// Builds dist/selfbase.mjs (browser + Node), dist/selfbase.deno.mjs (Deno) and dist/selfbase.d.ts.
import { build } from 'esbuild'
import { generateDtsBundle } from 'dts-bundle-generator'
import ts from 'typescript'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const banner = '/*! selfbase-js. Bundles postgrest-js and supabase-js type code, MIT License, Copyright (c) 2020 Supabase. */'
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist')

const common = { entryPoints: ['src/index.ts'], bundle: true, format: 'esm', target: 'es2020', banner: { js: banner }, legalComments: 'none',
  // whitespace minify drops upstream doc comments (their examples name supabase hosts and packages); identifiers stay readable
  minifyWhitespace: true, minifySyntax: true }
await build({ ...common, platform: 'browser', outfile: 'dist/selfbase.mjs' })
// Same code: every browser global it touches (window, localStorage, navigator.locks) is feature-detected.
await build({ ...common, platform: 'neutral', outfile: 'dist/selfbase.deno.mjs' })

const [dts] = generateDtsBundle([{ filePath: 'src/index.ts', output: { noBanner: true, exportReferencedTypes: false } }], {
  preferredConfigPath: 'tsconfig.build.json',
})
// Strip doc comments: they carry upstream examples (hosts, package names) that must not ship.
const printed = ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('selfbase.d.ts', dts, ts.ScriptTarget.Latest))
writeFileSync('dist/selfbase.d.ts', `${banner}\n${printed}`)

copyFileSync('vendor/postgrest-js/LICENSE', 'dist/LICENSE-postgrest-js')
copyFileSync('vendor/supabase-js/LICENSE', 'dist/LICENSE-supabase-js')
console.log('built dist/selfbase.mjs, dist/selfbase.deno.mjs, dist/selfbase.d.ts')
