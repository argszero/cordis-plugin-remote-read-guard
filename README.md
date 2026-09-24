# @argszero/cordis-plugin-remote-read-guard

**A Client Remote read that never answers must not leave the Web UI loading forever.**

The dsh Web plugin-manager page reads its state through three Client Remote calls:

```
pluginInventory.list()
pluginManager.listBundles()
pluginManager.listPlugins()
```

and those calls have **no failure exit and no deadline**. In
`packages/client/ui-plugin-manager/src/client/manager-store.ts` (the
`PluginManagerController.read()` body, `try` / `finally` with no `catch`), the status is
set to `loading` and then handed whatever the reads return:

- a read that **rejects** propagates out of `read()` — `finally` runs, nothing else
  does, and the status stays `loading` with no message and no retry;
- a read that **never settles** does exactly the same, for as long as the page is open.

That is the report this plugin answers: the plugin-manager page showing
*"Reading plugins…"* indefinitely.

The page already ships the branch that would fix it — `status === 'error'` renders an
error sentence and a **Retry** button, and the store reaches that status whenever a read
answers `{ ok: false }`. The path is unreachable only because the method call itself
never returns. So this plugin does not invent a failure surface. It makes an unanswered
read reach the one that already exists.

## What it does

A **browser-half** cordis plugin. When the Web shell mounts it, it wraps each of the
three reads so that:

| the read | without the plugin | with the plugin |
|---|---|---|
| answers `{ ok: true }` in time | passed through | **passed through, untouched** |
| answers `{ ok: false }` in time | the store's error branch | **the read's own failure, unchanged** |
| does not answer within the deadline (default 15 s) | `loading` forever | `{ ok: false }` — the store reaches `error`, the page shows Retry |
| rejects (an assembly fault: the Remote face folds carrier failures into `{ ok: false }` itself, so a rejection means the call could not be made) | rejection escapes `read()`, `loading` forever | `{ ok: false }` — as above |
| throws synchronously | throws at the caller | `{ ok: false }` — as above |
| answers *after* the deadline | — | still reported (`onEvent`, kind `late`); the call is not cancelled and the page stays on `error`, so an operator can tell "slow" from "gone" |

It never cancels a read, never retries one, never substitutes a value for one, and never
turns a healthy answer into a failure.

## Mount

```yaml
# in your dsh profile / bundle patch
- insert:
    - id: remote-read-guard
      name: '@argszero/cordis-plugin-remote-read-guard'
```

The package ships exactly that row as `cordis.patch.yml` (`dsh.bundle.patch`), so a
bundle can include it directly. To stop guarding, disable or drop the row:

```yaml
- set:
    - id: remote-read-guard
      disabled: true
```

The node half is deliberately inert: the reads happen in the browser, and the browser
half reaches the page because the manifest declares `dsh.client` — the row that mounts
this package is the same row `@deepseek-ai/dsh-client-modules` scans for, which is what
puts the guard into the Web shell.

## How the wrap works (and why it is legal)

Each Client Remote namespace is its own cordis Service on a dotted name
(`RemoteNamespaceService` is constructed with `remote.<name>`), and it installs every
method as a **configurable accessor**:

```ts
Object.defineProperty(this, method, { configurable: true, enumerable: true, get: /* returns the callable */ })
```

So a sibling plugin can address a method as a property descriptor, capture its getter,
and install a replacement getter that returns a wrapper. Two properties follow, and both
are pinned by tests here:

- **the consumer's own path reaches the wrapper** — the plugin manager keeps calling
  `ctx.remote.pluginInventory.list()`, and that read goes through the wrapper;
- **the wrapper stays late-binding** — the original getter is re-invoked *per call*, so
  a method record installed after the wrap is what the wrapper forwards to.

The plugin declares no injection of its own; it waits for each dotted namespace with
`ctx.inject(['remote.<namespace>'], …)`. That is also what makes it survive a namespace
**remount** — when the client assembly rebuilds a namespace service after the Host
re-sends its graph, cordis re-runs the wait and the wrapper is re-armed on the new
instance (measured on `@deepseek-ai/cordis` 4.0.4).

## The honest boundary

Two things this plugin does **not** claim, both of which matter more than the feature:

1. **It is a guard, not the fix.** The fix is four lines in
   `manager-store.ts`: a `catch` around the reads, and a deadline on them. A plugin can
   only reach objects cordis hands it; the store's own `try` is not one of them. If
   core grows a `catch` + timeout, this plugin becomes redundant — that is a good
   outcome, and this package's README should be retired with it.
2. **The Remote face already folds carrier failures into `{ ok: false }`**
   (`packages/typert/protocol/src/types.ts`): a lost connection arrives as a failure,
   not as a rejection. So the durable value here is the **deadline**, not "surviving a
   dropped connection". What rejects a Remote read is an **assembly** fault — the method
   could not be dispatched at all — and that is the case this plugin also normalizes.

Because the plugin reports a read as failed when its deadline expires, it can say
something the store's `catch` cannot: the call was **not** cancelled. A read reported
failed may still answer, and the guard reports that through `onEvent` (kind `late`) —
"the Host was slow" and "the Host never answered" call for different fixes.

## Configure

```ts
import { configure, guardReport, unwrapAll } from '@argszero/cordis-plugin-remote-read-guard/client'

configure({ timeoutMs: 5_000, onEvent: event => console.warn(event) })
```

- `configure({ timeoutMs })` — read at call time, so a later change applies to later
  reads. Must be a positive finite number; anything else throws.
- `configure({ onEvent })` — where the guard reports `deadline` / `threw` / `late`.
  Omit the field to leave a reporter in place; pass `undefined` to clear it.
- `guardReport()` — one record per guarded read (`armed` / `pending` / `skipped` with a
  reason). "The guard ran and skipped this read" and "the guard never ran" are different
  facts, and a passing read alone cannot tell them apart.
- `unwrapAll()` — take the guard off every read it armed and put the namespaces back as
  they were. Returned for tests and for unwinding by hand; on a real page, cordis
  disposal is enough.

A shipped browser half receives no config — the boot row carries the entry id alone
(`packages/client/modules/src/client/entries.ts`) — so the deadline is a documented
constant (`DEFAULT_TIMEOUT_MS`, 15 s) and `configure` is a door a deployment reaches
from a client module it also ships. That is a boundary of the plugin, not a choice of it.

## Exports

| entry | what it is |
|---|---|
| `.` | the node half: `apply` that does nothing, and the `dsh.client` declaration that puts the browser half in the Web shell |
| `./client` | the browser half: `apply`, `configure`, `guardReport`, `unwrapAll`, `inject` |
| `./guard` | the wrapper itself, import-free: `guardAccessor`, `restoreAccessor`, `bounded`, `guardFailure`, `isGuarded`, `isPromiseLike`, `DEFAULT_TIMEOUT_MS`, `GUARD_FAILURE_CODE`, `GUARDED_READS` |

`./guard` takes objects, not cordis: anything that reads a Client Remote namespace can
use it without mounting the plugin.

## Tests

```sh
npm test          # guard semantics + the plugin face end-to-end + packaging
npm run test:inject   # defect injection: every claim negated, one arm at a time
```

`test/plugin.spec.mjs` runs the **shipped bundle** — evaluated through a fake
`window.__ModuleLoader__`, exactly as the shell materializes it — inside a real cordis
app whose namespaces have the gateway's shape, and judges the result with the
controller's own store (`read()` without a `catch`, as it is in the product). The
measured claim: with the plugin mounted, a hanging or throwing read reaches `error`
instead of `loading`.

One arm runs a **child process** that arms a hanging read and awaits only that: the
deadline must fire in a process where nothing else is keeping the loop alive. The bound
is unconditional — a deadline that only works while other work is pending is the same
silent non-answer in a different costume.

## Peer / compatibility

- peer: `@deepseek-ai/cordis`
- measured on: `@deepseek-ai/cordis` 4.0.4, against `deepseek-harness` at `46a7f68b09`
- the extension point is an **implementation detail of the client assembly**
  (methods installed as configurable accessors on dotted namespace services). If that
  changes, the plugin reports `skipped` with a reason instead of pretending to guard:
  `npm test` covers each skip reason.

## License

MIT
