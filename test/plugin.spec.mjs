/**
 * The plugin face, end to end.
 *
 * `test/guard.spec.mjs` pins the wrapper's semantics on a bare object. This file
 * runs the same guard the way a page does: the *shipped bundle* mounted into a
 * real cordis app whose namespaces have the gateway's shape, read through the
 * consumer's own call path, and judged by the consumer's own store.
 *
 * The measured claim is narrow and worth stating plainly: with the plugin
 * mounted, a read that hangs or throws reaches the controller's `error` branch
 * instead of leaving it on `loading` — and `error` is the status whose sentence
 * and Retry button the page already renders.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createManager, delay, hanging, loadClientBundle, ok, rejecting, settle, staysPending, within, world } from './harness.mjs'

const BUNDLE = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/** A fresh copy of the shipped bundle, as its own module instance. */
function bundle() {
  return loadClientBundle(BUNDLE)
}

/** Mount a bundle copy into a fresh app with the given namespaces, and arm a short deadline. */
async function mount(namespaces, timeoutMs = 25) {
  const built = bundle()
  const area = await world(namespaces)
  built.exports.configure({ timeoutMs })
  await area.app.plugin(built.exports)
  await settle()
  return { ...area, client: built.exports }
}

/** The namespaces the plugin-manager page reads, all healthy. */
function healthy() {
  return {
    pluginInventory: { list: { make: () => Promise.resolve(ok({ managementAvailable: true })) } },
    pluginManager: {
      listBundles: { make: () => Promise.resolve(ok([])) },
      listPlugins: { make: () => Promise.resolve(ok([])) },
    },
  }
}

test('the bundle hands the loader a factory named after the package', () => {
  const { row } = bundle()
  assert.equal(row.id, '@argszero/cordis-plugin-remote-read-guard')
  assert.equal(typeof row.factory, 'function')
})

test('the bundle builds the plugin face the client loader needs', () => {
  const built = bundle()
  assert.equal(typeof built.exports.apply, 'function')
  assert.ok(Array.isArray(built.exports.inject))
  assert.equal(typeof built.exports.configure, 'function')
  assert.equal(typeof built.exports.guardReport, 'function')
  assert.equal(typeof built.exports.unwrapAll, 'function')
})

test('the bundle mounts before its namespaces exist, because it declares no injection of its own', async () => {
  // `dsh.client.inject` is empty: at mount time the namespaces are not there yet,
  // and the plugin waits for them instead of parking itself.
  const built = bundle()
  const app = new Context()
  await app.plugin(built.exports)
})

test('a healthy world is passed through: the controller still reaches ready', async () => {
  const namespaces = healthy()
  const { app, remote } = await world(namespaces)
  const manager = createManager()
  assert.equal(await manager.read(remote), 'ready')
  await app.plugin(bundle().exports)
  await settle()
  assert.equal(await manager.read(remote), 'ready')
})

test('the mount is reported: every guarded read says armed', async () => {
  const { client } = await mount(healthy())
  assert.deepEqual(client.guardReport(), [
    { read: 'pluginInventory.list', status: 'armed' },
    { read: 'pluginManager.listBundles', status: 'armed' },
    { read: 'pluginManager.listPlugins', status: 'armed' },
  ])
})

test('a hanging inventory read reaches error instead of loading forever', async () => {
  const namespaces = healthy()
  namespaces.pluginInventory.list = { make: () => hanging() }
  const { client, remote } = await mount(namespaces)
  const manager = createManager()
  assert.equal(await within(manager.read(remote), 500, 'the controller read'), 'error')
  assert.equal(manager.state.status, 'error')
  const events = []
  client.configure({ onEvent: event => events.push(event) })
  assert.equal(await manager.read(remote), 'error')
  assert.deepEqual(events.map(event => [event.kind, event.read]), [['deadline', 'pluginInventory.list']])
})

test('a throwing inventory read reaches error, and the throw does not escape the caller', async () => {
  const namespaces = healthy()
  namespaces.pluginInventory.list = { make: rejecting('no context adapter') }
  const { remote } = await mount(namespaces)
  const manager = createManager()
  assert.equal(await within(manager.read(remote), 500, 'the controller read'), 'error')
  assert.deepEqual(manager.state.reads, [['pluginInventory.list', false]])
})

test('a hanging bundle read reaches error, with the inventory already answered', async () => {
  const namespaces = healthy()
  namespaces.pluginManager.listBundles = { make: () => hanging() }
  const { remote } = await mount(namespaces)
  const manager = createManager()
  assert.equal(await manager.read(remote), 'error')
  // Both parallel reads are recorded: the guard answers with a value rather than
  // rejecting, so the join itself resolves and the store sees both rows.
  assert.deepEqual(manager.state.reads, [
    ['pluginInventory.list', true],
    ['pluginManager.listBundles', false],
    ['pluginManager.listPlugins', true],
  ])
})

test('a read that answers in time is never reported, even on a short deadline', async () => {
  const namespaces = healthy()
  const events = []
  const { client, remote } = await mount(namespaces)
  client.configure({ onEvent: event => events.push(event) })
  namespaces.pluginManager.listPlugins = {
    make: () => new Promise(resolve => setTimeout(() => { resolve(ok([])) }, 5)),
  }
  const manager = createManager()
  assert.equal(await manager.read(remote), 'ready')
  assert.deepEqual(events, [])
})

test('the plugin invents no failure the manifest did not already branch on', async () => {
  // `managementAvailable: false` is the page's own "unavailable" answer: the guard
  // passes it through rather than folding it into an error.
  const namespaces = healthy()
  namespaces.pluginInventory.list = { make: () => Promise.resolve(ok({ managementAvailable: false })) }
  const { remote } = await mount(namespaces)
  const manager = createManager()
  assert.equal(await manager.read(remote), 'unavailable')
})

test('a read answering after its deadline is reported late, and the page stays on error', async () => {
  const namespaces = healthy()
  let resolveLate
  namespaces.pluginInventory.list = { make: () => new Promise((resolve) => { resolveLate = resolve }) }
  const events = []
  const { client, remote } = await mount(namespaces)
  client.configure({ onEvent: event => events.push(event) })
  const manager = createManager()
  assert.equal(await within(manager.read(remote), 500, 'the controller read'), 'error')
  resolveLate(ok({ managementAvailable: true }))
  await settle()
  assert.deepEqual(events.map(event => event.kind), ['deadline', 'late'])
  assert.equal(manager.state.status, 'error')
})

test('a namespace remounted after the plugin mounted is armed again', async () => {
  // The client assembly rebuilds a namespace service when the Host re-sends its
  // graph; the wrapper lives on the instance that just died. `ctx.inject` re-fires
  // on the rebuild, which is what makes the second round guarded too — measured on
  // @deepseek-ai/cordis 4.0.4.
  const namespaces = healthy()
  namespaces.pluginInventory.list = { make: () => hanging() }
  const { remount, client, remote } = await mount(namespaces)
  const manager = createManager()
  assert.equal(await within(manager.read(remote), 500, 'the controller read'), 'error')
  await remount('pluginInventory')
  await settle()
  assert.equal(await within(manager.read(remote), 500, 'the controller read'), 'error', 'the rebuilt namespace is guarded as well')
  assert.equal(client.guardReport()[0].status, 'armed')
})

test('unwrapAll puts a namespace back as it was, and takes the deadline off it', async () => {
  const namespaces = healthy()
  namespaces.pluginInventory.list = { make: () => hanging() }
  const { client, remote } = await mount(namespaces)
  assert.equal(client.unwrapAll(), 3)
  assert.equal(await staysPending(remote.pluginInventory.list(), 80), true, 'the raw read is unbounded again')
  assert.equal(client.guardReport()[0].detail, 'unwrapped')
})

test('a healthy read still answers after the guard is taken off', async () => {
  const { client, remote } = await mount(healthy())
  assert.equal(client.unwrapAll(), 3)
  assert.equal((await within(remote.pluginInventory.list(), 500, 'the unguarded read')).ok, true)
})

test('configure refuses a deadline that is not a positive finite number', async () => {
  const { client } = await mount(healthy())
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => client.configure({ timeoutMs: bad }), /positive finite number/u)
  }
})

test('configure leaves a reporter alone when the call does not mention one', async () => {
  const namespaces = healthy()
  namespaces.pluginInventory.list = { make: () => hanging() }
  const events = []
  const { client, remote } = await mount(namespaces)
  client.configure({ onEvent: event => events.push(event) })
  client.configure({ timeoutMs: 25 })
  const manager = createManager()
  assert.equal(await within(manager.read(remote), 500, 'the controller read'), 'error')
  assert.deepEqual(events.map(event => event.kind), ['deadline'])
})
