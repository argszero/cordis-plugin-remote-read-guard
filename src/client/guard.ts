/**
 * The read guard's substance.
 *
 * Kept free of imports on purpose: this module is inlined into the browser
 * bundle unchanged, and it is the whole of what the plugin does — wrap a Client
 * Remote namespace method so that a read which never answers, or which throws
 * instead of resolving, arrives as the `{ ok: false }` branch its consumer
 * already handles. Nothing here touches the DOM, the network, or cordis.
 *
 * ## Why a wrapper is the honest shape
 *
 * The consumer this serves (`PluginManagerController.read()` in
 * `packages/client/ui-plugin-manager/src/client/manager-store.ts`) already has a
 * complete failure path: on `!result.ok` it sets `status: 'error'`, and the page
 * renders its error sentence and a Retry button for that status
 * (`PluginManagerPage.tsx`, the `status === 'error'` branch). The path is
 * unreachable only because the method call itself never returns — the reads have
 * no deadline, and the single `try/finally` has no `catch`. So the guard does not
 * invent a failure surface; it makes an unanswered read reach the one that exists.
 *
 * @module @argszero/cordis-plugin-remote-read-guard/client/guard
 */

/**
 * One Client Remote failure code, as it travels: the universal carrier code the
 * protocol declares for "carrier, dispatch, or unclassified Host failure"
 * (`packages/typert/protocol/src/types.ts`). A deadline expiry and a thrown call
 * are both that class — the read never got an answer from the Host — and the code
 * is deliberately the declared one rather than a new one, because
 * `RemoteErrorDetailsMap` is a closed vocabulary that only in-tree owners extend.
 */
export const GUARD_FAILURE_CODE = 'gateway/internal'

/** Milliseconds a guarded read may stay unanswered before it is reported as failed. */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Marks a function this plugin installed, so a second copy of the guard — or a
 * re-arm after a namespace remount — recognizes the wrapper instead of stacking a
 * second deadline on the same read. `Symbol.for` is deliberate: the marker has to
 * survive two copies of this module in the same page.
 */
const GUARDED_MARK = Symbol.for('@argszero/cordis-plugin-remote-read-guard/guarded')

/**
 * The reads this plugin guards by default: exactly the three whose hang or
 * rejection is what leaves the plugin-manager page loading (`read()` awaits
 * `pluginInventory.list()` first, then `pluginManager.listBundles()` and
 * `pluginManager.listPlugins()` together).
 *
 * The install dialog's `pluginManager.registries()` and the registry probe's
 * `pluginRegistryProbe.fastest()` are *not* here: they run only while the dialog
 * is open, their consumer drops a failed answer on the floor (`readRegistries`
 * returns early on `!answer.ok`), and a hang there is a dialog that never
 * finishes checking rather than a page that never loads. Add them per deployment
 * through {@link configure} if that trade is worth it there.
 */
export const GUARDED_READS: readonly string[] = [
  'pluginInventory.list',
  'pluginManager.listBundles',
  'pluginManager.listPlugins',
]

/** A read that answered, unchanged. */
export interface GuardedOk {
  readonly ok: true
  readonly value: unknown
}

/**
 * A read that did not answer, in the shape every Client Remote consumer already
 * handles. Structural rather than a class: the browser half bundles no runtime
 * copy of the protocol, and the marker plus a string code is exactly what
 * `remoteErrorOf` accepts across realms.
 */
export interface GuardedFailure {
  readonly ok: false
  readonly error: {
    readonly isDSHRemoteError: true
    readonly code: string
    readonly message: string
    readonly details: EmptyDetails
  }
}

/** The declared details payload of the carrier code — empty, and kept empty. */
export interface EmptyDetails {}

/** What a guarded read resolves to. */
export type GuardedResult = GuardedOk | GuardedFailure

/** Something the guard saw. */
export interface ReadGuardEvent {
  /**
   * `deadline` and `threw` are the two ways a read fails; `late` is a read that
   * answered after it had already been reported failed.
   */
  readonly kind: 'deadline' | 'threw' | 'late'
  /** The guarded read, as `<namespace>.<method>`. */
  readonly read: string
  /** The deadline that expired, or the thrown value's message. */
  readonly detail: string
}

/** Live settings, read at call time so a later {@link configure} takes effect on the next read. */
export interface ReadGuardSettings {
  /** Milliseconds a read may stay unanswered. */
  timeoutMs: number
  /** Where the guard reports what it saw; omitted means silent. */
  onEvent?: ((event: ReadGuardEvent) => void) | undefined
}

/**
 * What arming a read produced. `skipped` is reported rather than thrown: a guard
 * that could not arm must say so, and a caller that reads only "no error" would
 * otherwise believe it is protected when it is not.
 */
export type GuardOutcome =
  | { readonly kind: 'armed'; readonly original: PropertyDescriptor }
  | { readonly kind: 'skipped'; readonly reason: 'missing' | 'not-an-accessor' | 'not-configurable' | 'already-guarded' }

/** The message on the failure a read's own throw becomes. */
export function threwMessage(read: string, message: string): string {
  return `${read} threw instead of resolving. This is an assembly fault — the Remote face folds carrier failures into the `
    + `{ ok: false } branch itself, so a rejection here means the call could not be made. Cause: ${message}`
}

/** The message on the failure a deadline expiry becomes. */
export function deadlineMessage(read: string, timeoutMs: number): string {
  return `${read} did not answer within ${String(timeoutMs)}ms. The read is reported as failed so its consumer can leave `
    + 'its loading state; the call itself was not cancelled and may still answer.'
}

/** Wrap a message as a failure in the shape a Remote consumer's error branch reads. */
export function guardFailure(message: string, code: string = GUARD_FAILURE_CODE): GuardedFailure {
  return { ok: false, error: { isDSHRemoteError: true, code, message, details: {} } }
}

/** Whether a value is something a deadline can be put on. */
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function'
}

/** Whether a method already carries this guard. */
export function isGuarded(method: unknown): boolean {
  return typeof method === 'function' && (method as unknown as Record<symbol, unknown>)[GUARDED_MARK] === true
}

/** The message of a caught value, whatever it is. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

/**
 * Put a deadline on one read, and turn its rejection into the failure branch.
 *
 * Both handlers are attached immediately, so a read that rejects long after the
 * deadline cannot become an unhandled rejection — which is the very shape this
 * plugin exists to stop reaching a consumer.
 * @param answer - what the underlying method returned.
 * @param read - the guarded read, as `<namespace>.<method>`.
 * @param settings - live settings; `timeoutMs` is read now.
 * @returns the read's own result, or a failure describing why it did not arrive.
 */
export function bounded(answer: PromiseLike<unknown>, read: string, settings: ReadGuardSettings): Promise<GuardedResult> {
  const timeoutMs = settings.timeoutMs
  return new Promise<GuardedResult>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      settings.onEvent?.({ kind: 'deadline', read, detail: `${String(timeoutMs)}ms` })
      resolve(guardFailure(deadlineMessage(read, timeoutMs)))
    }, timeoutMs)
    // Node keeps a pending timer alive; a page does not. Unref where the host
    // supports it so the bound itself cannot hold a process open.
    if (typeof timer.unref === 'function') timer.unref()
    const answerLate = (detail: string): void => {
      settings.onEvent?.({ kind: 'late', read, detail })
    }
    answer.then(
      (value) => {
        if (settled) { answerLate('resolved'); return }
        settled = true
        clearTimeout(timer)
        resolve(value as GuardedResult)
      },
      (error: unknown) => {
        if (settled) { answerLate(messageOf(error)); return }
        settled = true
        clearTimeout(timer)
        settings.onEvent?.({ kind: 'threw', read, detail: messageOf(error) })
        resolve(guardFailure(threwMessage(read, messageOf(error))))
      },
    )
  })
}

/**
 * Guard one method of one namespace service.
 *
 * The method is addressed as a property descriptor rather than as a value: the
 * Client Remote namespaces install each method with
 * `Object.defineProperty(this, method, { configurable: true, get })`
 * (`packages/api/gateway/src/client/index.ts`), so the getter is captured here and
 * re-invoked at call time. That keeps the wrapper late-binding: the namespace's
 * own method record is read per call, and a record installed after this point is
 * what the wrapper forwards to.
 *
 * The replacement getter **returns** the callable, matching the accessor shape it
 * replaces. Writing the callable as the getter itself would look equivalent and is
 * not: a property read would then run the read, so `remote.pluginInventory.list()`
 * would call the read at `.list` and try to invoke its result.
 * @param holder - the namespace service instance.
 * @param method - the method name on it.
 * @param read - the guarded read, as `<namespace>.<method>`, for messages.
 * @param settings - live settings.
 * @returns whether the read is now guarded (with the descriptor it replaced), or why it is not.
 */
export function guardAccessor(
  holder: object,
  method: string,
  read: string,
  settings: ReadGuardSettings,
): GuardOutcome {
  const descriptor = Object.getOwnPropertyDescriptor(holder, method)
  if (descriptor === undefined) return { kind: 'skipped', reason: 'missing' }
  const get = descriptor.get
  if (typeof get !== 'function') return { kind: 'skipped', reason: 'not-an-accessor' }
  if (descriptor.configurable !== true) return { kind: 'skipped', reason: 'not-configurable' }
  if (isGuarded(get)) return { kind: 'skipped', reason: 'already-guarded' }
  const guardedGetter = function guardedGetter(this: object): (...args: unknown[]) => unknown {
    const owner = this
    return function guardedCall(...args: unknown[]): unknown {
      let answer: unknown
      try {
        answer = (get.call(owner) as (...rest: unknown[]) => unknown)(...args)
      } catch (error: unknown) {
        settings.onEvent?.({ kind: 'threw', read, detail: messageOf(error) })
        return Promise.resolve(guardFailure(threwMessage(read, messageOf(error))))
      }
      if (isPromiseLike(answer)) return bounded(answer, read, settings)
      // A stream or a plain value: not a read this guard can bound, and not one it
      // may claim to have bounded.
      return answer
    }
  }
  Object.defineProperty(guardedGetter, GUARDED_MARK, { value: true })
  Object.defineProperty(holder, method, {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get: guardedGetter,
  })
  return { kind: 'armed', original: descriptor }
}

/**
 * Put the original accessor back.
 * @param holder - the namespace service instance.
 * @param method - the method name on it.
 * @param original - the descriptor {@link guardAccessor} replaced.
 * @returns whether a descriptor was restored.
 */
export function restoreAccessor(holder: object, method: string, original: PropertyDescriptor | undefined): boolean {
  if (original === undefined) return false
  Object.defineProperty(holder, method, original)
  return true
}
