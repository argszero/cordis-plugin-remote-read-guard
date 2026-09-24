/**
 * The subject under test: a real cordis context carrying the Client Remote
 * shape the Web shell actually builds, plus the consumer read the plugin guards.
 *
 * The stubs here are shape-faithful on purpose, and every detail they copy is
 * cited so a reader can check it against the harness:
 *
 * - **A namespace is its own cordis Service on a dotted name.**
 *   `packages/api/gateway/src/client/index.ts` constructs `RemoteNamespaceService`
 *   with `super(ctx, remoteServiceKey(name))`, and `remoteServiceKey(n)` is
 *   `` `remote.${n}` ``.
 * - **A method is a configurable accessor that re-reads its record per read.**
 *   `install()` does `Object.defineProperty(this, method, { configurable: true,
 *   enumerable: true, get: function () { const current = this.methods.get(method); …
 *   return (...args) => this.invokeRemote(direct, scoped, callerCtx, args) } })`,
 *   so which record a call reaches is decided when the method is *read*.
 * - **The consumer is a fiber that declares the dotted names.**
 *   `packages/client/ui-plugin-manager/src/client/index.ts:52` injects
 *   `['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.pluginInventory', …]`,
 *   which is why the reads below go through `ctx.remote.<namespace>.<method>()`
 *   and not through `ctx.get`.
 */

import { spawnSync } from 'node:child_process'
import { Context, Service } from '@deepseek-ai/cordis'

/** A `remote` service: the parent every namespace hangs under. */
export class RemoteStub extends Service {
  constructor(ctx) {
    super(ctx, 'remote')
  }
}

/**
 * One namespace service, as the gateway installs and removes methods.
 * @param ctx - the fiber context the service is created in.
 * @param namespace - the namespace name, without the `remote.` prefix.
 */
export class NamespaceStub extends Service {
  constructor(ctx, namespace) {
    super(ctx, `remote.${namespace}`)
    this.namespace = namespace
    this.records = new Map()
  }

  /**
   * Install (or replace) one method. The accessor is created once, as the
   * gateway's `install()` does, and re-reads the record on every property read.
   * @param method - method name.
   * @param make - called with the call's own arguments; returns what the method returns.
   */
  install(method, make) {
    if (!this.records.has(method)) {
      Object.defineProperty(this, method, {
        configurable: true,
        enumerable: true,
        get: function () {
          const current = this.records.get(method)
          return (...args) => current.make(...args)
        },
      })
    }
    this.records.set(method, { make })
  }

  /** Remove one method, as the gateway's `remove()` does when the last variant goes. */
  remove(method) {
    this.records.delete(method)
    Reflect.deleteProperty(this, method)
  }
}

/** A read that answered: the `{ ok: true }` branch. */
export function ok(value) {
  return { ok: true, value }
}

/**
 * A read that hangs: a promise that never settles. The plugin's subject, in the
 * shape the report describes — nothing rejects, nothing resolves.
 */
export function hanging() {
  return new Promise(() => {})
}

/** A read that rejects. The protocol reserves rejections for assembly faults, which is what this stands for. */
export function rejecting(message) {
  return () => Promise.reject(new Error(message))
}

/** The plugin-manager controller's own read, as the product runs it. */
export function createManager() {
  const state = { status: 'idle', reads: [] }
  return {
    state,
    /**
     * `PluginManagerController.read()` with the plugin installed, mirroring
     * `packages/client/ui-plugin-manager/src/client/manager-store.ts:670-707`:
     * set `loading` once, await the inventory, then the manager's two reads
     * together, and set the status from what came back. Deliberately no catch and
     * no deadline — the absence of both is the defect this guard addresses, so a
     * model that added either would be measuring itself.
     * @param remote - the client remote service, read through the consumer's own path.
     * @returns the terminal status, or `loading` when the read never returns.
     */
    async read(remote) {
      state.reads = []
      try {
        if (state.status === 'idle') state.status = 'loading'
        const inventory = await remote.pluginInventory.list()
        state.reads.push(['pluginInventory.list', inventory.ok])
        if (!inventory.ok) { state.status = 'error'; return state.status }
        if (inventory.value.managementAvailable !== true) { state.status = 'unavailable'; return state.status }
        const [bundles, plugins] = await Promise.all([
          remote.pluginManager.listBundles(),
          remote.pluginManager.listPlugins(),
        ])
        state.reads.push(['pluginManager.listBundles', bundles.ok], ['pluginManager.listPlugins', plugins.ok])
        if (!bundles.ok || !plugins.ok) { state.status = 'error'; return state.status }
        state.status = 'ready'
        return state.status
      } finally {
        // The product resets `inFlight` here and touches nothing else — which is
        // exactly why a rejection or a hang leaves the page on `loading`.
      }
    },
  }
}

/**
 * Build a world: a real cordis root, a `remote` service, one namespace service per
 * entry, and a consumer fiber that declares the dotted names the product declares.
 * @param namespaces - `{ <namespace>: { <method>: { make } } }`.
 * @returns the pieces an arm needs to drive the consumer's own call path.
 */
export async function world(namespaces) {
  const app = new Context()
  await app.plugin(RemoteStub)

  const fibers = new Map()
  for (const [namespace, methods] of Object.entries(namespaces)) {
    const fiber = app.plugin({
      name: `remote.${namespace}`,
      apply: (ctx) => {
        const service = new NamespaceStub(ctx, namespace)
        for (const [method, record] of Object.entries(methods)) service.install(method, record.make)
      },
    })
    fibers.set(namespace, fiber)
  }
  await Promise.all([...fibers.values()])

  // The consumer fiber, declaring the same dotted names the product declares.
  let remote
  await app.plugin({
    name: 'plugin-manager-page',
    inject: ['remote', 'remote.pluginInventory', 'remote.pluginManager'],
    apply: (ctx) => { remote = ctx.remote },
  })

  return {
    app,
    remote,
    /** Remount one namespace the way the client assembly does when the host re-sends its graph. */
    async remount(namespace) {
      await fibers.get(namespace).dispose()
      const fiber = app.plugin({
        name: `remote.${namespace}`,
        apply: (ctx) => {
          const service = new NamespaceStub(ctx, namespace)
          for (const method of Object.keys(namespaces[namespace])) {
            service.install(method, namespaces[namespace][method].make)
          }
        },
      })
      fibers.set(namespace, fiber)
      await fiber
    },
  }
}

/** Let microtasks and a zero-delay timer run, so a guarded read has settled. */
export async function settle(times = 3) {
  for (let index = 0; index < times; index += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** Wait real milliseconds, for the arms that need a read to answer after a deadline. */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Await a promise, but fail loudly if it is still pending after `ms`.
 *
 * The guard's whole claim is that an unanswered read stops being unanswered, so
 * the arms that assert it must not be able to *hang* when the claim breaks: a
 * hung test reports nothing, and a defect-injection arm reading "the suite hung"
 * is far weaker than one reading "this assertion failed". Every await of a read
 * that is supposed to answer goes through here.
 * @param promise - the read, or the consumer's own method call, being awaited.
 * @param ms - how long it may stay pending before the test fails.
 * @param label - what was being awaited, for the failure message.
 * @returns what the promise resolved to.
 */
export function within(promise, ms, label) {
  return Promise.race([
    promise,
    delay(ms).then(() => { throw new Error(`${label} was still pending after ${String(ms)}ms`) }),
  ])
}

/**
 * Run a snippet in a **fresh Node process** and return its output.
 *
 * Needed for claims about process lifetime: a bounded read that only settles
 * because the test's own timers keep the loop alive proves nothing about the
 * bound. The child is what makes the question askable — it has exactly the code
 * under test and nothing else.
 * @param code - the module source to run with `node --input-type=module -e`.
 * @returns the child's combined output and exit status.
 */
export function inChildProcess(code) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

/** Whether a promise is still pending after `ms` — the other half of {@link within}. */
export async function staysPending(promise, ms) {
  return await Promise.race([promise.then(() => 'settled'), delay(ms).then(() => 'pending')]) === 'pending'
}

/**
 * Materialize the client bundle the way the Web shell does: hand
 * `window.__ModuleLoader__` a `load({ id, factory })` row, then run the factory
 * with a `require` that answers nothing.
 *
 * The shell stores the factory and runs it later, so nothing in the bundle may
 * touch the page at script-execution time — which is why the fake `window` here
 * carries only the loader. The `require` throws on purpose: this package imports
 * no shared value (`lib/client.js.build.json` reports `required: []`), so a
 * require reaching the loader would be a bundle that asks for a row it did not
 * declare — the failure this returns should never happen.
 * @param text - the bundle source, `lib/client.js`.
 * @returns the row the bundle handed the loader, and the module it built.
 */
export function loadClientBundle(text) {
  let row
  const window = { __ModuleLoader__: { load: (loaded) => { row = loaded } } }
  new Function('window', text)(window)
  if (row === undefined) throw new Error('client bundle: the artifact never called window.__ModuleLoader__.load')
  const built = row.factory((specifier) => {
    throw new Error(`client bundle: the factory required "${specifier}", which its dsh.client declaration does not cover`)
  })
  return { row, exports: built }
}
