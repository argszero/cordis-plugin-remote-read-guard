/**
 * Browser half of @argszero/cordis-plugin-remote-read-guard.
 *
 * Arms {@link guardAccessor} on the Client Remote reads the plugin-manager page
 * depends on, and re-arms them across namespace remounts.
 *
 * ## Where the arms come from
 *
 * Each Client Remote namespace is its own cordis Service on a dotted name
 * (`packages/api/gateway/src/client/index.ts`: `RemoteNamespaceService` is
 * constructed with `remote.${name}`), and the client assembly mounts them
 * asynchronously after this plugin's own `apply`. So the arming is a
 * `ctx.inject(['remote.<namespace>'], …)`: cordis parks that fiber until the
 * service exists, and re-runs it when a namespace is disposed and rebuilt —
 * measured on `@deepseek-ai/cordis` 4.0.4, which is the behaviour the remount arm
 * of `test/plugin.spec.mjs` pins.
 *
 * `ctx.get(name)` is used to read the service rather than a property access, and
 * that is deliberate: `ctx.get` is an optional lookup, while a property read
 * requires the name to be declared up front — `inject: ['remote']` alone throws
 * `cannot get property "remote.pluginInventory" without inject`.
 *
 * ## What this half does not do
 *
 * It never cancels a read, never retries one, and never substitutes a value. A
 * read it reports as failed may still answer later, and when it does the guard
 * says so through `onEvent` — "the Host was slow" and "the Host never answered"
 * call for different fixes.
 *
 * @module @argszero/cordis-plugin-remote-read-guard/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  DEFAULT_TIMEOUT_MS,
  GUARDED_READS,
  guardAccessor,
  restoreAccessor,
  type GuardOutcome,
  type ReadGuardEvent,
  type ReadGuardSettings,
} from './guard.ts'

export type {
  EmptyDetails,
  GuardedFailure,
  GuardedOk,
  GuardedResult,
  GuardOutcome,
  ReadGuardEvent,
  ReadGuardSettings,
} from './guard.ts'
export { DEFAULT_TIMEOUT_MS, GUARD_FAILURE_CODE, GUARDED_READS, guardFailure } from './guard.ts'

/**
 * Services this browser half declares. None: it reads the Remote namespaces
 * through `ctx.inject` waits inside {@link apply}, because they are mounted by the
 * client assembly *after* this plugin's own fiber — declaring them here would park
 * this plugin instead, and a parked plugin never arms anything.
 */
export const inject: readonly string[] = []

/** What was armed, and what could not be. */
export interface GuardRecord {
  /** The guarded read, as `<namespace>.<method>`. */
  readonly read: string
  /** `armed` once the wrapper is in place; `pending` while its namespace is not mounted yet. */
  readonly status: 'armed' | 'pending' | 'skipped'
  /** Why a read was skipped, or the namespace currently missing. */
  readonly detail?: string
}

/** Settings the browser half reads at call time; {@link configure} mutates them in place. */
const settings: ReadGuardSettings = { timeoutMs: DEFAULT_TIMEOUT_MS }

/** Every read this half has tried to arm, with what happened. */
const records = new Map<string, GuardRecord>()

/** The originals, so {@link unwrapAll} can put the namespaces back as they were. */
const originals = new Map<string, { holder: object; method: string; descriptor: PropertyDescriptor }>()

/**
 * Change the guard's settings. Call it before the namespaces mount for the next
 * read to use the new deadline; every read reads `timeoutMs` when it is called,
 * so a later change applies to later reads rather than to the ones in flight.
 *
 * Today nothing in a shipped dsh profile can reach this: a browser-half plugin
 * receives no config — `packages/client/modules/src/client/entries.ts` builds each
 * loader entry from the row's `id` alone, and the boot row carries no config field
 * — so a deployment that needs a different deadline has to reach this door from a
 * client module it also ships, or patch {@link DEFAULT_TIMEOUT_MS}. That is a
 * boundary of the plugin, not a choice of it.
 * @param next - the settings to apply; omitted fields are left as they are.
 */
export function configure(next: { timeoutMs?: number; onEvent?: ((event: ReadGuardEvent) => void) | undefined }): void {
  if (next.timeoutMs !== undefined) {
    if (!Number.isFinite(next.timeoutMs) || next.timeoutMs <= 0) {
      throw new Error(`remote-read-guard: timeoutMs must be a positive finite number, got ${String(next.timeoutMs)}`)
    }
    settings.timeoutMs = next.timeoutMs
  }
  if ('onEvent' in next) settings.onEvent = next.onEvent
}

/**
 * What the guard has armed, in the order it tried. A test — or an operator
 * reading a crash report — can tell "the guard ran and skipped this read" apart
 * from "the guard never ran", which a passing read alone cannot show.
 * @returns one record per guarded read this half has tried.
 */
export function guardReport(): GuardRecord[] {
  return [...records.values()].map(record => ({ ...record }))
}

/**
 * Take the guard off every read it armed, and put the namespaces back as they
 * were. The plugin needs this only for its own tests and for an operator
 * unwinding it by hand; cordis disposal is enough on a real page, where the
 * namespace instance dies with its fiber.
 * @returns how many reads were restored.
 */
export function unwrapAll(): number {
  let restored = 0
  for (const [read, entry] of originals) {
    if (restoreAccessor(entry.holder, entry.method, entry.descriptor)) restored += 1
    records.set(read, { read, status: 'skipped', detail: 'unwrapped' })
  }
  originals.clear()
  return restored
}

/** Group `namespace.method` reads by namespace, keeping each namespace's method order. */
function byNamespace(reads: readonly string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const read of reads) {
    const at = read.lastIndexOf('.')
    const namespace = at === -1 ? read : read.slice(0, at)
    const method = at === -1 ? '' : read.slice(at + 1)
    const methods = grouped.get(namespace)
    if (methods === undefined) grouped.set(namespace, [method])
    else methods.push(method)
  }
  return grouped
}

/**
 * Client plugin body: arm the guard on every guarded read.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  for (const [namespace, methods] of byNamespace(GUARDED_READS)) {
    ctx.inject([`remote.${namespace}`], (scoped) => {
      const holder = scoped.get(`remote.${namespace}`) as object | undefined
      if (holder === undefined) {
        for (const method of methods) records.set(`${namespace}.${method}`, { read: `${namespace}.${method}`, status: 'pending', detail: namespace })
        return
      }
      for (const method of methods) {
        const read = `${namespace}.${method}`
        const outcome: GuardOutcome = guardAccessor(holder, method, read, settings)
        if (outcome.kind === 'armed') {
          records.set(read, { read, status: 'armed' })
          originals.set(read, { holder, method, descriptor: outcome.original })
        } else {
          records.set(read, { read, status: 'skipped', detail: outcome.reason })
        }
      }
    })
  }
}
