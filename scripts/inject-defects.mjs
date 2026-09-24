/**
 * Defect injection: negate one claim at a time, rebuild, run the suite, and
 * require that the suite notices.
 *
 * An arm whose mutation leaves the suite green is **SILENT** — it proves nothing
 * about the test suite, and this file says so out loud rather than letting a green
 * run stand in for a proof. An arm whose mutation does not compile is
 * **UNBUILDABLE** and is reported separately for the same reason.
 *
 * The suite loads `lib/*.js` — `lib/guard.js` through the tests, `lib/client.js`
 * through a fake `window.__ModuleLoader__` — so every arm runs the package's real
 * build first. That doubles as the answer to a stale `lib/`: a stale build makes
 * every arm look SILENT, and a reader who trusts a stale SILENT line draws the
 * opposite conclusion about the suite.
 *
 * The mutations are this plugin's own claims, negated one at a time:
 *
 * - the deadline is enforced;
 * - a hang is reported as a failure, not as an answer;
 * - a rejection does not escape its caller (on both paths: the promise and the throw);
 * - the replacement getter *returns* the callable instead of being it;
 * - an arm that could not be made is named, never claimed;
 * - the guard marker survives, so a second arm does not stack a second deadline;
 * - a late answer (and a late rejection) is reported, not dropped;
 * - only promise-shaped answers get a deadline;
 * - the wrapper re-reads the namespace's method record per call;
 * - the bound does not depend on something else keeping the loop alive;
 * - `configure` refuses a nonsense deadline, and does not clear a reporter it was
 *   not asked about;
 * - `unwrapAll` really takes the guard off.
 *
 * Run from the plugin root: `npm run test:inject`.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SPECS = ['test/guard.spec.mjs', 'test/plugin.spec.mjs', 'test/packaging.spec.mjs']

const MUTATIONS = [
  {
    name: 'the deadline is no longer enforced',
    file: 'src/client/guard.ts',
    edits: [['      if (settled) return\n      settled = true\n      settings.onEvent?.({ kind: \'deadline\'', '      if (true) return\n      settled = true\n      settings.onEvent?.({ kind: \'deadline\'']],
  },
  {
    name: 'a read that never answers is reported as an answered read',
    file: 'src/client/guard.ts',
    edits: [['      resolve(guardFailure(deadlineMessage(read, timeoutMs)))', '      resolve({ ok: true, value: undefined })']],
  },
  {
    name: 'a rejected read escapes its caller instead of being answered',
    file: 'src/client/guard.ts',
    edits: [['        resolve(guardFailure(threwMessage(read, messageOf(error))))', '        throw error']],
  },
  {
    name: 'a read that throws synchronously is reported as an answered read',
    file: 'src/client/guard.ts',
    edits: [[
      '      return Promise.resolve(guardFailure(threwMessage(read, messageOf(error))))',
      '      return Promise.resolve({ ok: true, value: undefined })',
    ]],
  },
  {
    name: 'the replacement getter runs the read at property-read time instead of returning the callable',
    file: 'src/client/guard.ts',
    edits: [[
      '    get: guardedGetter,\n  })',
      '    get: (() => guardedGetter.call(holder)()) as unknown as () => unknown,\n  })',
    ]],
  },
  {
    name: 'a method that is not there is claimed as guarded',
    file: 'src/client/guard.ts',
    edits: [
      ["  if (descriptor === undefined) return { kind: 'skipped', reason: 'missing' }",
        "  if (descriptor === undefined) return { kind: 'armed', original: {} }"],
    ],
  },
  {
    name: 'a method that cannot be replaced is claimed as guarded',
    file: 'src/client/guard.ts',
    edits: [
      ["  if (descriptor.configurable !== true) return { kind: 'skipped', reason: 'not-configurable' }",
        "  if (descriptor.configurable !== true) return { kind: 'armed', original: descriptor }"],
    ],
  },
  {
    name: 'the guard marker is lost, so a second arm stacks a second deadline',
    file: 'src/client/guard.ts',
    edits: [['  Object.defineProperty(guardedGetter, GUARDED_MARK, { value: true })', '  Object.defineProperty(guardedGetter, GUARDED_MARK, { value: false })']],
  },
  {
    name: 'an answer that arrives after the deadline is dropped silently',
    file: 'src/client/guard.ts',
    edits: [["        if (settled) { answerLate('resolved'); return }", '        if (settled) { return }']],
  },
  {
    name: 'a rejection that arrives after the deadline is dropped silently',
    file: 'src/client/guard.ts',
    edits: [['        if (settled) { answerLate(messageOf(error)); return }', '        if (settled) { return }']],
  },
  {
    name: 'a stream-shaped answer is claimed as a bounded read',
    file: 'src/client/guard.ts',
    edits: [['      if (isPromiseLike(answer)) return bounded(answer, read, settings)', '      if (true) return bounded(answer as PromiseLike<unknown>, read, settings)']],
  },
  {
    name: 'the wrapper stops reading the namespace method record per call',
    file: 'src/client/guard.ts',
    edits: [
      ['  const guardedGetter = function guardedGetter(this: object): (...args: unknown[]) => unknown {',
        '  const frozen = get.call(holder) as (...rest: unknown[]) => unknown\n  const guardedGetter = function guardedGetter(this: object): (...args: unknown[]) => unknown {'],
      ['        answer = (get.call(owner) as (...rest: unknown[]) => unknown)(...args)', '        answer = frozen(...args)'],
    ],
  },
  {
    name: 'the deadline only fires while something else keeps the loop alive',
    file: 'src/client/guard.ts',
    edits: [[
      '    const answerLate = (detail: string): void => {',
      '    if (typeof timer.unref === \'function\') timer.unref()\n    const answerLate = (detail: string): void => {',
    ]],
  },
  {
    name: 'configure stops refusing a deadline that is not a positive finite number',
    file: 'src/client/index.ts',
    edits: [['    if (!Number.isFinite(next.timeoutMs) || next.timeoutMs <= 0) {', '    if (false) {']],
  },
  {
    name: 'configure clears a reporter it was not asked about',
    file: 'src/client/index.ts',
    edits: [["  if ('onEvent' in next) settings.onEvent = next.onEvent", '  settings.onEvent = next.onEvent']],
  },
  {
    name: 'unwrapAll leaves the wrapper in place',
    file: 'src/client/index.ts',
    edits: [['    if (restoreAccessor(entry.holder, entry.method, entry.descriptor)) restored += 1', '    if (restoreAccessor(entry.holder, entry.method, entry.descriptor) && false) restored += 1']],
  },
]

/** Run the package's own build; returns whether it succeeded. */
function build() {
  try {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Run the suite. A nonzero exit is the signal — a crash counts as caught, and so
 * does a timeout, but the two are labelled differently so a hang is never read as
 * a clean assertion failure.
 */
function suite() {
  try {
    execFileSync('node', ['--test', ...SPECS], { cwd: ROOT, stdio: 'pipe', timeout: 120_000 })
    return { caught: false, hung: false, tail: '' }
  } catch (error) {
    const hung = error.killed === true || error.signal === 'SIGKILL' || error.signal === 'SIGTERM'
    const output = `${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}`
    const lines = output.split('\n').filter(line => /^\s*(✖|ℹ fail|not ok)/u.test(line))
    return { caught: true, hung, tail: lines.slice(0, 3).join(' / ') }
  }
}

let silent = 0
let unbuildable = 0
let hung = 0
let caught = 0
for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let anchored = true
  for (const [find, replace] of mutation.edits) {
    if (!original.includes(find)) {
      anchored = false
      console.log(`SKIP (anchor missing): ${mutation.name}`)
    }
    mutated = mutated.replace(find, replace)
  }
  if (!anchored) continue

  writeFileSync(path, mutated)
  let built = false
  let result = { caught: false, hung: false, tail: '' }
  try {
    built = build()
    if (built) result = suite()
  } finally {
    // Restored and rebuilt whatever happened: an injector that can leave a
    // mutation in the tree is worse than no injector.
    writeFileSync(path, original)
    build()
  }

  if (!built) {
    unbuildable += 1
    console.log(`UNBUILDABLE (proves nothing): ${mutation.name}`)
    continue
  }
  if (!result.caught) {
    silent += 1
    console.log(`SILENT: ${mutation.name} (${mutation.file})`)
    continue
  }
  if (result.hung) {
    hung += 1
    console.log(`HUNG (the suite did not finish): ${mutation.name}${result.tail === '' ? '' : ` — ${result.tail}`}`)
    continue
  }
  caught += 1
  console.log(`CAUGHT: ${mutation.name} (${mutation.file})${result.tail === '' ? '' : ` — ${result.tail}`}`)
}

console.log(`CAUGHT: ${String(caught)}; HUNG: ${String(hung)}; SILENT: ${silent === 0 ? 'none' : String(silent)}; UNBUILDABLE: ${String(unbuildable)}`)
process.exitCode = silent === 0 && unbuildable === 0 && hung === 0 ? 0 : 1
