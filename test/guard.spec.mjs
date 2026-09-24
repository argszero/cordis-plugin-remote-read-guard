/**
 * The guard's own semantics, against the shipped `lib/guard.js`.
 *
 * These arms are about what a bounded read *is*: what it passes through, what it
 * turns a hang and a throw into, what it does not claim to have bounded, and what
 * it says when it cannot arm at all.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { within } from './harness.mjs'
import {
  DEFAULT_TIMEOUT_MS,
  GUARD_FAILURE_CODE,
  GUARDED_READS,
  bounded,
  guardAccessor,
  guardFailure,
  isGuarded,
  isPromiseLike,
} from '../lib/guard.js'

/** A settings object with a deadline short enough for a test. */
function settings(timeoutMs, onEvent) {
  return onEvent === undefined ? { timeoutMs } : { timeoutMs, onEvent }
}

test('the default deadline is a documented, finite number', () => {
  assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number')
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && Number.isFinite(DEFAULT_TIMEOUT_MS))
})

test('the guarded reads are exactly the three the plugin-manager page awaits', () => {
  assert.deepEqual([...GUARDED_READS], [
    'pluginInventory.list',
    'pluginManager.listBundles',
    'pluginManager.listPlugins',
  ])
})

test('the failure carries the declared carrier code and an empty details payload', () => {
  const failure = guardFailure('boom')
  assert.equal(failure.ok, false)
  assert.equal(failure.error.isDSHRemoteError, true)
  assert.equal(failure.error.code, GUARD_FAILURE_CODE)
  assert.equal(failure.error.message, 'boom')
  assert.deepEqual(failure.error.details, {})
})

test('a read that answers in time is passed through untouched', async () => {
  const value = { ok: true, value: { managementAvailable: true } }
  assert.deepEqual(await bounded(Promise.resolve(value), 'pluginInventory.list', settings(50)), value)
})

test('a read that fails in time keeps its own failure, not one of ours', async () => {
  const value = { ok: false, error: { isDSHRemoteError: true, code: 'gateway/cancelled', message: 'client', details: {} } }
  assert.deepEqual(await bounded(Promise.resolve(value), 'pluginInventory.list', settings(50)), value)
})

test('a read that never answers becomes a failure at the deadline', async () => {
  const events = []
  const result = await within(
    bounded(new Promise(() => {}), 'pluginInventory.list', settings(20, event => events.push(event))),
    500,
    'the guarded read',
  )
  assert.equal(result.ok, false)
  assert.match(result.error.message, /did not answer within 20ms/u)
  assert.deepEqual(events.map(event => event.kind), ['deadline'])
  assert.equal(events[0].read, 'pluginInventory.list')
})

test('a read that rejects becomes a failure instead of escaping the consumer', async () => {
  const events = []
  const result = await bounded(
    Promise.reject(new Error('no context adapter')),
    'pluginManager.listBundles',
    settings(50, event => events.push(event)),
  )
  assert.equal(result.ok, false)
  assert.match(result.error.message, /threw instead of resolving/u)
  assert.match(result.error.message, /no context adapter/u)
  assert.deepEqual(events.map(event => event.kind), ['threw'])
})

test('a rejection after the deadline is reported, never left unhandled', async () => {
  const events = []
  let reject
  const answer = new Promise((_, rejectAnswer) => { reject = rejectAnswer })
  const result = await within(
    bounded(answer, 'pluginManager.listPlugins', settings(10, event => events.push(event))),
    500,
    'the guarded read',
  )
  assert.equal(result.ok, false)
  reject(new Error('too late'))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(events.map(event => event.kind), ['deadline', 'late'])
  assert.equal(events[1].detail, 'too late')
})

test('an answer after the deadline is reported as late, and does not resurrect the read', async () => {
  const events = []
  let resolveSlow
  const answer = new Promise((resolve) => { resolveSlow = resolve })
  const result = await within(
    bounded(answer, 'pluginInventory.list', settings(10, event => events.push(event))),
    500,
    'the guarded read',
  )
  assert.equal(result.ok, false)
  resolveSlow({ ok: true, value: { managementAvailable: true } })
  await new Promise(r => setTimeout(r, 5))
  assert.deepEqual(events.map(event => event.kind), ['deadline', 'late'])
  assert.equal(events[1].detail, 'resolved')
})

test('only promise-shaped answers get a deadline', () => {
  assert.equal(isPromiseLike(Promise.resolve()), true)
  assert.equal(isPromiseLike({ then: () => {} }), true)
  assert.equal(isPromiseLike({ ok: true, value: {} }), false)
  assert.equal(isPromiseLike(undefined), false)
  assert.equal(isPromiseLike(null), false)
})

test('a stream-shaped read is passed through untouched', () => {
  const stream = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }
  const holder = {}
  Object.defineProperty(holder, 'tail', { configurable: true, enumerable: true, get: () => () => stream })
  assert.equal(guardAccessor(holder, 'tail', 'pluginInventory.tail', settings(10)).kind, 'armed')
  assert.equal(holder.tail(), stream)
})

test('a method absent from the namespace is a named skip, not a silent success', () => {
  const outcome = guardAccessor({}, 'list', 'pluginInventory.list', settings(10))
  assert.deepEqual(outcome, { kind: 'skipped', reason: 'missing' })
})

test('a plain data method is a named skip: it is not a read this guard can bound', () => {
  const holder = { list: () => Promise.resolve({ ok: true, value: {} }) }
  const outcome = guardAccessor(holder, 'list', 'pluginInventory.list', settings(10))
  assert.deepEqual(outcome, { kind: 'skipped', reason: 'not-an-accessor' })
})

test('a non-configurable method is a named skip rather than a thrown TypeError', () => {
  const holder = {}
  Object.defineProperty(holder, 'list', { configurable: false, get: () => () => Promise.resolve({ ok: true, value: {} }) })
  const outcome = guardAccessor(holder, 'list', 'pluginInventory.list', settings(10))
  assert.deepEqual(outcome, { kind: 'skipped', reason: 'not-configurable' })
})

test('guarding the same accessor twice is a named skip, with one deadline on the read', async () => {
  const holder = {}
  let calls = 0
  Object.defineProperty(holder, 'list', {
    configurable: true,
    enumerable: true,
    get: () => () => { calls += 1; return new Promise(() => {}) },
  })
  assert.equal(guardAccessor(holder, 'list', 'pluginInventory.list', settings(10)).kind, 'armed')
  const descriptor = Object.getOwnPropertyDescriptor(holder, 'list')
  assert.equal(isGuarded(descriptor.get), true)
  assert.deepEqual(guardAccessor(holder, 'list', 'pluginInventory.list', settings(10)), { kind: 'skipped', reason: 'already-guarded' })
  const result = await within(holder.list(), 500, 'the twice-guarded read')
  assert.equal(result.ok, false)
  assert.equal(calls, 1, 'the original read ran exactly once')
})

test('the wrapper re-reads the namespace record per call, so a re-installed method is what it forwards to', async () => {
  // Shape copied from the gateway's own `install()`
  // (`packages/api/gateway/src/client/index.ts`): the getter *captures* the current
  // method record and returns a closure over it. So a wrapper that froze the
  // getter's output at arm time would keep answering from the record that was live
  // then, while re-invoking the getter follows the record as the namespace
  // re-installs it — which is what a second contribution for the same method does.
  const holder = {}
  let record = { make: () => Promise.resolve({ ok: true, value: { generation: 1 } }) }
  Object.defineProperty(holder, 'list', {
    configurable: true,
    enumerable: true,
    get: function () {
      const captured = record
      return (...args) => captured.make(...args)
    },
  })
  guardAccessor(holder, 'list', 'pluginInventory.list', settings(50))
  assert.deepEqual(await holder.list(), { ok: true, value: { generation: 1 } })
  record = { make: () => Promise.resolve({ ok: true, value: { generation: 2 } }) }
  assert.deepEqual(await holder.list(), { ok: true, value: { generation: 2 } })
})

test('an argument list reaches the underlying read unchanged', async () => {
  const holder = {}
  const seen = []
  Object.defineProperty(holder, 'list', {
    configurable: true,
    enumerable: true,
    get: () => (...args) => { seen.push(args); return Promise.resolve({ ok: true, value: args }) },
  })
  guardAccessor(holder, 'list', 'pluginInventory.list', settings(50))
  const result = await holder.list('a', 1, { b: 2 })
  assert.deepEqual(seen, [['a', 1, { b: 2 }]])
  assert.deepEqual(result.value, ['a', 1, { b: 2 }])
})

test('a synchronous throw from the read becomes a failure instead of throwing at the caller', async () => {
  const holder = {}
  Object.defineProperty(holder, 'list', {
    configurable: true,
    enumerable: true,
    get: () => () => { throw new Error('method record is gone') },
  })
  guardAccessor(holder, 'list', 'pluginInventory.list', settings(10))
  const result = await holder.list()
  assert.equal(result.ok, false)
  assert.match(result.error.message, /method record is gone/u)
})
