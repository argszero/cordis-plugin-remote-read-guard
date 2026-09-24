/**
 * What the package actually ships.
 *
 * Three claims, and one of them is the one that usually rots:
 *
 * 1. **The manifest names files the tarball contains.** A pack yields the file
 *    list from npm's own matcher (`npm pack --dry-run --json`) rather than from a
 *    hand-written glob — a hand-rolled listing re-implements the very thing being
 *    measured, so it would agree with a mistake.
 * 2. **No shipped module reaches outside the package.** Every relative specifier
 *    in the emitted JavaScript has to resolve to another shipped file; a shipped
 *    entry whose import is missing from `files` is a module that works in this
 *    working copy and nowhere else.
 * 3. **The declared peer range admits the companion it is pinned to.** Both the
 *    node half and the browser half are built against `@deepseek-ai/cordis`; a
 *    range that excludes the version this package was built and tested on would
 *    install a plugin whose caller cannot satisfy it.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'))

/** The file list npm itself would pack, from npm's own matcher. */
function packed() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const [entry] = JSON.parse(raw)
  return { files: entry.files.map(file => file.path).sort(), size: entry.size, unpackedSize: entry.unpackedSize }
}

const pack = packed()

/** Every path the manifest points at, as tarball-relative paths. */
function declaredPaths() {
  const paths = new Set()
  const add = (value) => {
    if (typeof value !== 'string') return
    paths.add(value.replace(/^\.\//u, ''))
  }
  add(MANIFEST.main)
  add(MANIFEST.types)
  for (const target of Object.values(MANIFEST.exports)) {
    // An export target is either a condition object or a plain string
    // (`"./package.json": "./package.json"`); iterating the string would walk its
    // characters and report them as declared paths.
    for (const value of typeof target === 'string' ? [target] : Object.values(target)) add(value)
  }
  add(MANIFEST.dsh?.bundle?.patch)
  return [...paths].sort()
}

test('the tarball carries every path the manifest declares', () => {
  const shipped = new Set(pack.files)
  const missing = declaredPaths().filter(path => !shipped.has(path))
  assert.deepEqual(missing, [], `declared but not packed: ${missing.join(', ')}`)
})

test('the declared bundle patch is a packed file, and it is the one on disk', () => {
  assert.equal(MANIFEST.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pack.files.includes('cordis.patch.yml'))
  assert.ok(existsSync(`${ROOT}cordis.patch.yml`))
})

test('the pack is the whitelist: sources, tests and scripts stay out', () => {
  const leaked = pack.files.filter(path => /^(src|test|scripts|node_modules)\//u.test(path))
  assert.deepEqual(leaked, [], `shipped by mistake: ${leaked.join(', ')}`)
  assert.ok(pack.size > 0 && pack.unpackedSize > 0)
  assert.ok(pack.size < 64 * 1024, `the tarball is ${String(pack.size)} bytes; this plugin should stay small`)
})

test('every relative import in the shipped JavaScript resolves to another shipped file', () => {
  const shipped = new Set(pack.files)
  const offenders = []
  for (const path of pack.files.filter(file => file.endsWith('.js'))) {
    const source = readFileSync(`${ROOT}${path}`, 'utf8')
    const specifiers = [...source.matchAll(/(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/gu, )].map(match => match[1])
    for (const match of source.matchAll(/require\((["'])([^"']+)\1\)/gu)) specifiers.push(match[2])
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue
      const target = new URL(specifier, `file://${ROOT}${path}`).pathname.slice(ROOT.length)
      if (!shipped.has(target) && !shipped.has(`${target}.js`)) offenders.push(`${path} -> ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], `shipped modules reaching outside the pack: ${offenders.join(', ')}`)
})

test('the shipped bundle asks the shell module table for nothing it did not declare', () => {
  const build = JSON.parse(readFileSync(`${ROOT}lib/client.js.build.json`, 'utf8'))
  assert.deepEqual(build.required, [])
  // The two inputs are the whole plugin: nothing shared was inlined alongside them.
  assert.deepEqual(build.inputs, ['src/client/guard.ts', 'src/client/index.ts'])
  assert.equal(build.bytes, readFileSync(`${ROOT}lib/client.js`, 'utf8').length)
})

test('the peer range admits the cordis version this package is built against', async () => {
  const semver = await import('semver')
  const installed = JSON.parse(
    readFileSync(`${ROOT}node_modules/@deepseek-ai/cordis/package.json`, 'utf8'),
  ).version
  const range = MANIFEST.peerDependencies['@deepseek-ai/cordis']
  assert.ok(
    semver.satisfies(installed, range, { includePrerelease: true }),
    `${range} does not admit the installed ${installed}`,
  )
})

test('no runtime dependency of this package is declared but unused, and none is undeclared', () => {
  assert.deepEqual(Object.keys(MANIFEST.dependencies ?? {}), [])
  // The browser half imports no value (its externals are empty) and the node half
  // imports nothing at all, so the only runtime edge this package has is the peer.
  assert.deepEqual(Object.keys(MANIFEST.peerDependencies), ['@deepseek-ai/cordis'])
  assert.equal(MANIFEST.publishConfig.access, 'public')
  assert.equal(MANIFEST.type, 'module')
  assert.equal(MANIFEST.dsh.client.platform, 'web')
  assert.deepEqual(MANIFEST.dsh.client.inject, [])
})

test('the package does not carry a workspace protocol into its published ranges', () => {
  const ranges = [...Object.values(MANIFEST.dependencies ?? {}), ...Object.values(MANIFEST.peerDependencies)]
  const offenders = ranges.filter(range => range.startsWith('workspace:'))
  assert.deepEqual(offenders, [])
})
