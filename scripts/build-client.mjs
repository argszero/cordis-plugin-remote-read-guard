/**
 * Build the two browser-facing artifacts.
 *
 * 1. **`lib/client.js`** — the closure-factory artifact the dsh Web shell loads.
 *    In-tree client packages get this shape from the shared preset
 *    `clientBundle()` in `packages/client/tsdown.client.ts`. An out-of-tree
 *    package cannot import that preset — it lives in the harness workspace and
 *    resolves the harness's own module table — so the two things the preset
 *    actually guarantees are reproduced here explicitly:
 *
 *    a. **The handoff.** `window.__ModuleLoader__.load({ id, factory })` with the
 *       bundle body inside the factory, `module`/`exports` introduced by the
 *       wrapper and `return module.exports` closing it. The loader stores a
 *       factory and materializes it later, so a bundle may not touch the DOM at
 *       script-execution time — everything the plugin does happens when the
 *       factory runs.
 *    b. **The externals.** Every specifier the shell shares (the platform module
 *       table plus this package's `dsh.client.inject` edges) stays a `require()`
 *       the loader answers; everything else is inlined. A `require()` the module
 *       table cannot answer is a guaranteed runtime throw, while inlining a
 *       specifier that SHOULD be shared silently creates a second instance of it.
 *
 * 2. **`lib/guard.js`** — the same guard module as plain ESM, so the test suite
 *    can exercise it directly and `./guard` is available to anything that wants
 *    the wrap without the plugin. It is what the browser bundle inlines, so a bug
 *    that only appears under bundling still shows up here.
 *
 * The build fails loudly rather than emitting an artifact that only breaks in a
 * browser.
 */

import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = JSON.parse(await readFile(`${ROOT}package.json`, 'utf8'))

/** The shell's shared module table (packages/client/web/src/platform.ts). */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Package rows this bundle's factories must wait for (dsh.client.inject). */
const INJECTED_PACKAGES = MANIFEST.dsh.client.inject

const EXTERNALS = new Set([...PLATFORM_MODULES, ...INJECTED_PACKAGES])

const entry = `${ROOT}src/client/index.ts`
const outfile = `${ROOT}lib/client.js`

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  minify: false,
  // Requested rows stay imports; everything else is inlined.
  external: [...EXTERNALS],
  logLevel: 'warning',
  metafile: true,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(MANIFEST.name)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})

const text = await readFile(outfile, 'utf8')

// Contract 1: the handoff names this package and opens/closes exactly once.
const handoff = text.split('window.__ModuleLoader__.load(').length - 1
if (handoff !== 1) {
  throw new Error(`client bundle: expected exactly one __ModuleLoader__.load handoff, found ${handoff}`)
}
if (!text.includes(`id: ${JSON.stringify(MANIFEST.name)},`)) {
  throw new Error(`client bundle: handoff does not carry the package id ${MANIFEST.name}`)
}
if (!text.trimEnd().endsWith('return module.exports; } });')) {
  throw new Error('client bundle: artifact does not end with the factory return + close')
}
if (!text.includes('var module = { exports: {} }; var exports = module.exports;')) {
  throw new Error('client bundle: artifact is missing the module/exports intro')
}

// Contract 2: the module table is a fixed set, so a require must never address a
// row this package did not ask for — the loader would have nothing to answer
// with and the factory would throw. Requiring nothing is a legitimate outcome
// here (this plugin imports no shared value: it wraps objects cordis hands it at
// call time), so an empty set is reported rather than rejected — the plugin face
// contract is what proves the artifact works, and test/bundle.spec.mjs runs it.
const requires = new Set()
for (const match of text.matchAll(/require\((["'])([^"']+)\1\)/gu)) requires.add(match[2])
for (const specifier of requires) {
  if (!EXTERNALS.has(specifier)) {
    throw new Error(
      `client bundle: artifact requires "${specifier}", which is not in the shell module table or dsh.client.inject — `
      + 'the module table cannot answer it, so this is a guaranteed runtime throw',
    )
  }
}

// Contract 3: nothing shared was inlined. Every `@deepseek-ai/*` value import is
// either a requested row (external, above) or a duplicate runtime instance.
const inlined = Object.keys(result.metafile.inputs).filter(path => path.includes('node_modules/@deepseek-ai/'))
if (inlined.length > 0) {
  throw new Error(`client bundle: shared packages were inlined instead of requested: ${inlined.join(', ')}`)
}

// Contract 4: no bare ESM import survives — the loader answers requires only.
if (/^\s*import[\s{*]/mu.test(text)) {
  throw new Error('client bundle: artifact still contains an ESM import statement')
}

// Contract 5: the module the factory returns carries the plugin face. A bundle
// that dropped `apply` or `inject` would register a row that cannot compose.
for (const face of ['apply', 'inject']) {
  if (!new RegExp(`(^|[^\\w.])${face}\\s*:`, 'mu').test(text)) {
    throw new Error(`client bundle: artifact does not export the plugin face member "${face}"`)
  }
}

const size = Buffer.byteLength(text, 'utf8')
await writeFile(`${outfile}.build.json`, `${JSON.stringify({
  id: MANIFEST.name,
  externals: [...EXTERNALS],
  required: [...requires].sort(),
  inputs: Object.keys(result.metafile.inputs).sort(),
  bytes: size,
}, null, 2)}\n`)

// The guard module as plain ESM, for `./guard` and for the test suite. Same
// source the bundle inlines, so the two cannot drift.
await build({
  entryPoints: [`${ROOT}src/client/guard.ts`],
  outfile: `${ROOT}lib/guard.js`,
  bundle: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'warning',
})

process.stdout.write(`client bundle: ${MANIFEST.name} -> lib/client.js (${size} bytes)\n`)
process.stdout.write(`client bundle: requires ${[...requires].sort().join(', ') || '(none)'}\n`)
process.stdout.write('guard module: src/client/guard.ts -> lib/guard.js (esm)\n')
